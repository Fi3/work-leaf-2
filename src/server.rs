use crate::{
    application::{Application, Delivery},
    config::Config,
    process,
    protocol::{self, Framer, RpcError},
};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

struct Connection {
    socket: UnixStream,
    frames: Framer,
    replies: VecDeque<Vec<u8>>,
    watches: HashMap<String, Vec<u8>>,
    writing: Option<(Vec<u8>, usize, bool)>,
    queued: usize,
}

impl Connection {
    fn new(socket: UnixStream) -> std::io::Result<Self> {
        socket.set_nonblocking(true)?;
        Ok(Self {
            socket,
            frames: Framer::default(),
            replies: VecDeque::new(),
            watches: HashMap::new(),
            writing: None,
            queued: 0,
        })
    }
    fn queue(&mut self, value: Value) -> Result<(), RpcError> {
        let bytes = protocol::encode(&value)?;
        if value["method"] == "session.state" {
            let watch = value["params"]["watch_id"]
                .as_str()
                .ok_or_else(|| RpcError::app("internal_error", "Invalid watch record"))?;
            if serde_json::to_vec(&value["params"]["snapshot"])
                .map_or(true, |v| v.len() > protocol::MAX_SNAPSHOT)
            {
                return Err(RpcError::app(
                    "resource_limit",
                    "Worker snapshot exceeds 512 KiB",
                ));
            }
            self.watches.insert(watch.into(), bytes);
        } else {
            if self.queued + bytes.len() > protocol::MAX_OUTPUT {
                return Err(RpcError::app(
                    "resource_limit",
                    "Client output queue is full",
                ));
            }
            self.queued += bytes.len();
            self.replies.push_back(bytes);
        }
        Ok(())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        for _ in 0..8 {
            if self.writing.is_none() {
                if let Some(frame) = self.replies.pop_front() {
                    self.writing = Some((frame, 0, true));
                } else if let Some(key) = self.watches.keys().next().cloned() {
                    self.writing = self.watches.remove(&key).map(|b| (b, 0, false));
                }
            }
            let Some((bytes, offset, reply)) = self.writing.as_mut() else {
                break;
            };
            match self.socket.write(&bytes[*offset..]) {
                Ok(0) => return Err(std::io::Error::other("Client closed")),
                Ok(n) => {
                    *offset += n;
                    if *reply {
                        self.queued -= n;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
            if *offset == bytes.len() {
                self.writing = None;
            }
        }
        Ok(())
    }
    fn empty(&self) -> bool {
        self.replies.is_empty() && self.writing.is_none()
    }
}

fn route(client: u64, bytes: &[u8], app: &mut Application, connection: &mut Connection) -> bool {
    let value: Option<Value> = serde_json::from_slice(bytes).ok();
    if value
        .as_ref()
        .is_some_and(|v| v.is_object() && !v.as_object().is_some_and(|o| o.contains_key("id")))
    {
        return false;
    }
    match protocol::Request::parse(bytes) {
        Ok(request) => app.request(client, request),
        Err(error) => {
            let id = value
                .as_ref()
                .and_then(|v| v.get("id"))
                .filter(|id| id.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 128))
                .cloned()
                .unwrap_or(Value::Null);
            if connection
                .queue(protocol::response(id, Err(error)))
                .is_err()
            {
                return false;
            }
        }
    }
    true
}

pub fn serve(config: Config) -> Result<(), RpcError> {
    process::prepare_server()?;
    let lock = process::lock(&config.state_dir)?;
    let parent = config
        .socket_path
        .parent()
        .ok_or_else(|| RpcError::invalid("Socket has no parent"))?;
    process::private_dir(parent)?;
    process::private_dir(&config.state_dir.join("logs"))?;
    process::check_endpoint(&config.socket_path)?;
    if config.socket_path.exists() {
        if UnixStream::connect(&config.socket_path).is_ok() {
            return Err(RpcError::app(
                "conflict",
                "A live endpoint already uses this socket",
            ));
        }
        std::fs::remove_file(&config.socket_path)?;
    }
    let listener = UnixListener::bind(&config.socket_path)?;
    std::fs::set_permissions(&config.socket_path, std::fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    let result = run(listener, config.clone(), lock);
    let _ = std::fs::remove_file(&config.socket_path);
    result
}

fn run(listener: UnixListener, config: Config, lock: std::fs::File) -> Result<(), RpcError> {
    let mut app = Application::new(config, lock)?;
    let mut clients = HashMap::<u64, Connection>::new();
    let mut next_id = 0;
    let mut finish_at = None;
    loop {
        if process::interrupted() {
            clients.clear();
            app.close();
            break;
        }
        if !app.finished {
            for _ in 0..protocol::MAX_CLIENTS {
                match listener.accept() {
                    Ok((socket, _)) => {
                        if clients.len() >= protocol::MAX_CLIENTS {
                            continue;
                        }
                        next_id += 1;
                        clients.insert(next_id, Connection::new(socket)?);
                        app.add_client(next_id);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => return Err(e.into()),
                }
            }
        }
        let mut closed = Vec::new();
        for (id, connection) in &mut clients {
            if !app.finished {
                let mut bytes = [0; 65536];
                match connection.socket.read(&mut bytes) {
                    Ok(0) => closed.push(*id),
                    Ok(n) => match connection.frames.push(&bytes[..n]) {
                        Ok(records) => {
                            for record in records {
                                if !route(*id, &record, &mut app, connection) {
                                    closed.push(*id);
                                    break;
                                }
                            }
                        }
                        Err(_) => closed.push(*id),
                    },
                    Err(e)
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                        ) => {}
                    Err(_) => closed.push(*id),
                }
            }
        }
        for delivery in app.tick() {
            match delivery {
                Delivery::Record(id, value) => {
                    if let Some(connection) = clients.get_mut(&id)
                        && connection.queue(value).is_err()
                    {
                        closed.push(id);
                    }
                }
                Delivery::Close(id) => closed.push(id),
            }
        }
        for (id, connection) in &mut clients {
            if connection.flush().is_err() {
                closed.push(*id);
            }
        }
        for id in closed {
            clients.remove(&id);
            app.remove_client(id);
        }
        if app.finished {
            let deadline = finish_at.get_or_insert_with(|| Instant::now() + Duration::from_secs(1));
            if clients.values().all(Connection::empty) || Instant::now() >= *deadline {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

fn existing(
    config: &Config,
    expected_pid: Option<u32>,
    current: bool,
) -> Result<Option<Value>, RpcError> {
    process::check_endpoint(&config.socket_path)?;
    let mut stream = match UnixStream::connect(&config.socket_path) {
        Ok(stream) => stream,
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            ) =>
        {
            return Ok(None);
        }
        Err(e) => return Err(e.into()),
    };
    if let Some(expected) = expected_pid
        && process::peer_pid(&stream)? != expected
    {
        return Err(RpcError::app(
            "conflict",
            "Another server started during setup. The entered key was not applied. Run auth or setup again",
        ));
    }
    stream.set_read_timeout(Some(Duration::from_millis(500)))?;
    stream.set_write_timeout(Some(Duration::from_millis(500)))?;
    stream.write_all(&protocol::encode(
        &json!({"jsonrpc":"2.0","id":"startup","method":"system.hello","params":{"api_version":1}}),
    )?)?;
    let record = protocol::read_frame(&mut std::io::BufReader::new(stream))?.ok_or_else(|| {
        RpcError::app(
            "incompatible_version",
            "Existing endpoint closed its handshake",
        )
    })?;
    let value: Value = serde_json::from_slice(&record).map_err(|_| {
        RpcError::app(
            "incompatible_version",
            "Existing endpoint returned invalid JSON",
        )
    })?;
    if value["result"]["api_version"] != 1 {
        return Err(RpcError::app(
            "incompatible_version",
            "Existing endpoint uses another protocol",
        ));
    }
    if value["result"]["state_dir"] != json!(config.state_dir) {
        return Err(RpcError::app(
            "conflict",
            "Existing server has another protocol or state directory",
        ));
    }
    protocol::check_revision(&value["result"], !current)?;
    Ok(Some(value["result"].clone()))
}

pub(crate) fn released(config: &Config) -> Result<std::fs::File, RpcError> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if process::interrupted() {
            return Err(RpcError::app("not_ready", "Server restart interrupted"));
        }
        match process::lock(&config.state_dir) {
            Ok(lock) if !config.socket_path.exists() => return Ok(lock),
            Ok(_) => {}
            Err(error) if error.kind() == Some("conflict") => {}
            Err(error) => return Err(error),
        }
        if Instant::now() >= deadline {
            return Err(RpcError::app(
                "not_ready",
                "The old server did not release its storage and socket",
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

pub fn upgrade(config: &Config) -> Result<Value, RpcError> {
    if existing(config, None, false)?.is_some() {
        let mut client =
            crate::client::Client::connect_for_upgrade(&config.socket_path, &config.state_dir)?;
        client.request("server.shutdown", json!({}))?;
        drop(client);
        drop(released(config)?);
    }
    start(config)
}

pub fn start(config: &Config) -> Result<Value, RpcError> {
    start_with_key(config, None)
}

pub fn start_with_key(config: &Config, key: Option<&str>) -> Result<Value, RpcError> {
    let deadline = Instant::now() + Duration::from_secs(10);
    if let Some(hello) = existing(config, key.map(|_| 0), true)?
        && hello["storage_ready"] == true
    {
        return Ok(hello);
    }
    process::private_dir(&config.state_dir)?;
    let logs = config.state_dir.join("logs");
    process::private_dir(&logs)?;
    let log_path = logs.join("server.log");
    if std::fs::metadata(&log_path).is_ok_and(|m| m.len() >= 10 * 1024 * 1024) {
        let _ = std::fs::remove_file(logs.join("server.1.log"));
        std::fs::rename(&log_path, logs.join("server.1.log"))?;
    }
    let log = process::private_file(&log_path)?;
    let mut command = Command::new(std::env::current_exe()?);
    if let Some(key) = key {
        command
            .env_remove("ANTHROPIC_AUTH_TOKEN")
            .env_remove("ANTHROPIC_OAUTH_TOKEN")
            .env("ANTHROPIC_API_KEY", key);
    }
    command
        .arg("serve")
        .arg("--state-dir")
        .arg(&config.state_dir)
        .arg("--socket")
        .arg(&config.socket_path);
    if let Some(path) = &config.config_path {
        command.arg("--config").arg(path);
    }
    command
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    process::detach(&mut command);
    let mut child: Option<std::process::Child> = None;
    loop {
        let connected = existing(
            config,
            key.map(|_| child.as_ref().map_or(0, |child| child.id())),
            true,
        )?;
        if let Some(hello) = &connected
            && hello["storage_ready"] == true
        {
            return Ok(hello.clone());
        }
        if let Some(running) = child.as_mut()
            && running.try_wait()?.is_some()
        {
            child = None;
        }
        if connected.is_none() && child.is_none() {
            match process::lock(&config.state_dir) {
                Ok(lock) => {
                    drop(lock);
                    child = Some(command.spawn()?);
                }
                Err(error) if error.kind() == Some("conflict") => {}
                Err(error) => return Err(error),
            }
        }
        if Instant::now() >= deadline {
            return Err(RpcError::app(
                "not_ready",
                format!(
                    "Server did not become ready in 10 seconds; check {}",
                    log_path.display()
                ),
            ));
        }
        if process::interrupted() {
            return Err(RpcError::app("not_ready", "Startup interrupted"));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
