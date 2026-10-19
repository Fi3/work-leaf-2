use crate::process;
use crate::protocol::{self, API_VERSION, Framer, MAX_PENDING, MAX_WATCHES, Request, RpcError};
use serde_json::{Value, json};
use std::collections::{HashSet, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::fd::{AsFd, AsRawFd};
use std::os::unix::fs::{FileTypeExt, OpenOptionsExt};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(100);

pub fn write_stdout(mut bytes: &[u8]) -> Result<(), RpcError> {
    let mut output = File::from(io::stdout().as_fd().try_clone_to_owned()?);
    let kind = output.metadata()?.file_type();
    if kind.is_fifo() || kind.is_char_device() {
        // dup shares status flags with the caller. Reopening gives pipes and terminals independent flags.
        output = OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY)
            .open("/proc/self/fd/1")?;
    }
    while !bytes.is_empty() {
        if process::interrupted() {
            return Err(unavailable("Client interrupted; the run can continue"));
        }
        let result = if kind.is_socket() {
            process::send_nonblocking(output.as_raw_fd(), bytes)
        } else {
            output.write(bytes)
        };
        match result {
            Ok(0) => return Err(unavailable("Standard output closed")),
            Ok(count) => bytes = &bytes[count..],
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10))
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

pub struct Client {
    socket: UnixStream,
    framer: Framer,
    records: VecDeque<Vec<u8>>,
    notifications: VecDeque<Value>,
    next_id: u64,
    deadline: Option<Instant>,
}

fn unavailable(message: impl Into<String>) -> RpcError {
    RpcError::app("not_ready", message)
}

impl Client {
    pub fn connect(socket: &Path, expected_state: Option<&Path>) -> Result<Self, RpcError> {
        Self::open(socket, expected_state, true)
    }

    pub(crate) fn connect_for_upgrade(socket: &Path, state: &Path) -> Result<Self, RpcError> {
        Self::open(socket, Some(state), false)
    }

    fn open(socket: &Path, expected_state: Option<&Path>, current: bool) -> Result<Self, RpcError> {
        process::check_endpoint(socket)?;
        let socket = UnixStream::connect(socket)?;
        socket.set_read_timeout(Some(POLL))?;
        socket.set_write_timeout(Some(Duration::from_secs(10)))?;
        let mut client = Self {
            socket,
            framer: Framer::default(),
            records: VecDeque::new(),
            notifications: VecDeque::new(),
            next_id: 0,
            deadline: Some(Instant::now() + Duration::from_secs(10)),
        };
        let hello = client.request("system.hello", json!({"api_version": API_VERSION}))?;
        if hello["api_version"].as_u64() != Some(API_VERSION) {
            return Err(RpcError::app(
                "incompatible_version",
                "Unsupported server version",
            ));
        }
        if let Some(expected) = expected_state {
            let expected = expected.canonicalize()?;
            if hello["state_dir"].as_str().map(Path::new) != Some(expected.as_path()) {
                return Err(RpcError::app(
                    "conflict",
                    "Socket belongs to another state directory",
                ));
            }
        }
        protocol::check_revision(&hello, !current)?;
        client.deadline = None;
        Ok(client)
    }

    pub fn request(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        protocol::validate(method, &params)?;
        self.next_id += 1;
        let id = format!("client_{}", self.next_id);
        self.socket
            .write_all(&protocol::encode(&json!(Request::new(
                &id, method, params
            )))?)?;
        loop {
            let value = self.receive()?;
            if value.get("id").is_none() {
                self.retain_notification(value)?;
                continue;
            }
            if value["id"] != id {
                return Err(unavailable("Server response has an unknown id"));
            }
            return result(value);
        }
    }

    pub fn read(&mut self) -> Result<Value, RpcError> {
        match self.notifications.pop_front() {
            Some(value) => Ok(value),
            None => self.receive(),
        }
    }

    fn retain_notification(&mut self, value: Value) -> Result<(), RpcError> {
        let watch = &value["params"]["watch_id"];
        self.notifications
            .retain(|old| &old["params"]["watch_id"] != watch);
        if self.notifications.len() >= MAX_WATCHES {
            return Err(unavailable("Server exceeded the watch limit"));
        }
        self.notifications.push_back(value);
        Ok(())
    }

    fn receive(&mut self) -> Result<Value, RpcError> {
        let mut bytes = [0; 16 * 1024];
        loop {
            if process::interrupted() {
                return Err(unavailable("Client interrupted; the run can continue"));
            }
            if self
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
            {
                return Err(unavailable("Server handshake timed out"));
            }
            if let Some(record) = self.records.pop_front() {
                return parse_response(&record);
            }
            match self.socket.read(&mut bytes) {
                Ok(0) => {
                    return Err(unavailable(if self.framer.is_empty() {
                        "Server connection closed"
                    } else {
                        "Server closed an incomplete record"
                    }));
                }
                Ok(count) => self.records.extend(
                    self.framer
                        .push(&bytes[..count])
                        .map_err(|error| unavailable(error.message))?,
                ),
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock
                            | io::ErrorKind::TimedOut
                            | io::ErrorKind::Interrupted
                    ) => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
}

fn parse_response(bytes: &[u8]) -> Result<Value, RpcError> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| unavailable("Invalid server JSON"))?;
    let object = value
        .as_object()
        .ok_or_else(|| unavailable("Invalid server record"))?;
    let allowed: &[&str] = if object.contains_key("id") {
        let id = value["id"]
            .as_str()
            .ok_or_else(|| unavailable("Invalid server response id"))?;
        if id.is_empty()
            || id.len() > 128
            || object.contains_key("result") == object.contains_key("error")
        {
            return Err(unavailable("Invalid server response"));
        }
        if let Some(error) = object.get("error") {
            serde_json::from_value::<RpcError>(error.clone())
                .map_err(|_| unavailable("Invalid server error"))?;
        }
        &["jsonrpc", "id", "result", "error"]
    } else {
        if value["method"] != "session.state" || !value["params"].is_object() {
            return Err(unavailable("Invalid server notification"));
        }
        &["jsonrpc", "method", "params"]
    };
    if value["jsonrpc"] != "2.0" || object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(unavailable("Invalid server envelope"));
    }
    Ok(value)
}

fn result(mut value: Value) -> Result<Value, RpcError> {
    if let Some(error) = value.get_mut("error") {
        return Err(serde_json::from_value(error.take())
            .map_err(|_| unavailable("Invalid server error"))?);
    }
    Ok(value["result"].take())
}

enum Event {
    Input(Result<Option<Vec<u8>>, RpcError>),
    Socket(Result<Value, RpcError>),
}

pub fn proxy(socket: &Path, expected_state: Option<&Path>) -> Result<(), RpcError> {
    let mut client = Client::connect(socket, expected_state)?;
    let mut writer = client.socket.try_clone()?;
    let (send, receive) = mpsc::sync_channel(0);
    let input_send = send.clone();
    thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            let record = protocol::read_frame(&mut input);
            let done = !matches!(&record, Ok(Some(_)));
            if input_send.send(Event::Input(record)).is_err() || done {
                break;
            }
        }
    });
    thread::spawn(move || {
        loop {
            let record = client.read();
            let failed = record.is_err();
            if send.send(Event::Socket(record)).is_err() || failed {
                break;
            }
        }
    });
    let outcome = proxy_records(&mut writer, receive);
    let _ = writer.shutdown(Shutdown::Both);
    outcome
}

fn proxy_records(socket: &mut UnixStream, events: mpsc::Receiver<Event>) -> Result<(), RpcError> {
    let mut pending = HashSet::new();
    let mut eof = false;
    while !eof || !pending.is_empty() {
        if process::interrupted() {
            return Err(unavailable("Client interrupted; the run can continue"));
        }
        let event = match events.recv_timeout(POLL) {
            Ok(event) => event,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                return Err(unavailable("Proxy connection closed"));
            }
        };
        match event {
            Event::Input(record) => match record? {
                None => eof = true,
                Some(mut bytes) => {
                    let request = Request::parse(&bytes)?;
                    if !pending.insert(request.id) {
                        return Err(RpcError::invalid("Request id is already pending"));
                    }
                    if pending.len() > MAX_PENDING {
                        return Err(RpcError::app("resource_limit", "Too many pending requests"));
                    }
                    bytes.push(b'\n');
                    socket.write_all(&bytes)?;
                }
            },
            Event::Socket(record) => {
                let record = record?;
                if let Some(id) = record.get("id")
                    && !pending.remove(id.as_str().unwrap_or_default())
                {
                    return Err(unavailable("Server response has an unknown id"));
                }
                write_stdout(&protocol::encode(&record)?)?;
            }
        }
    }
    Ok(())
}
