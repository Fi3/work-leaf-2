use harness::{client::Client, process, protocol};
use serde_json::{Value, json};
use std::fs;
use std::io::{BufReader, Read, Write};
use std::os::unix::{
    fs::{MetadataExt, PermissionsExt, symlink},
    net::{UnixListener, UnixStream},
};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Server {
    root: PathBuf,
    config: PathBuf,
    socket: PathBuf,
    child: Option<Child>,
    pid: Option<u32>,
}
fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_harness")
}
fn kill(pid: u32, signal: &str) {
    let _ = Command::new("kill")
        .args([signal, &pid.to_string()])
        .stderr(Stdio::null())
        .status();
}
fn until(mut predicate: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(10);
    while !predicate() {
        assert!(Instant::now() < end, "condition timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
}
impl Server {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("harness-server-{}", process::random_id().unwrap()));
        fs::create_dir(&root).unwrap();
        let config = root.join("config.json");
        let socket = root.join("control.sock");
        fs::write(&config,serde_json::to_vec(&json!({"state_dir":root.join("state"),"socket_path":socket,"provider":"faux","model":"test","worker_path":Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/worker.mjs")})).unwrap()).unwrap();
        Self {
            root,
            config,
            socket,
            child: None,
            pid: None,
        }
    }
    fn command(&self, name: &str) -> Command {
        let mut c = Command::new(binary());
        c.arg(name)
            .arg("--config")
            .arg(&self.config)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        c
    }
    fn serve(&mut self, mode: &str) {
        self.child = Some(
            self.command("serve")
                .env("HARNESS_FAKE_MODE", mode)
                .spawn()
                .unwrap(),
        );
        self.pid = Some(self.child.as_ref().unwrap().id());
        self.ready();
    }
    fn ready(&self) {
        until(|| {
            self.client()
                .ok()
                .and_then(|mut c| c.request("system.hello", json!({"api_version":1})).ok())
                .is_some_and(|h| h["storage_ready"] == true)
        });
    }
    fn client(&self) -> Result<Client, protocol::RpcError> {
        Client::connect(&self.socket, None)
    }
    fn workers(&self) -> Vec<u32> {
        fs::read_to_string(self.root.join("state/worker-pids"))
            .unwrap_or_default()
            .lines()
            .map(|p| p.parse().unwrap())
            .collect()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        if let Some(pid) = self.pid {
            kill(pid, "-TERM");
        }
        if let Some(child) = self.child.as_mut() {
            let end = Instant::now() + Duration::from_secs(6);
            while child.try_wait().unwrap().is_none() && Instant::now() < end {
                std::thread::sleep(Duration::from_millis(10));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        for pid in self.workers() {
            if Path::new(&format!("/proc/{pid}")).exists() {
                kill(pid, "-KILL");
            }
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn raw(server: &Server) -> BufReader<UnixStream> {
    let mut socket = UnixStream::connect(&server.socket).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    socket.write_all(&protocol::encode(&json!({"jsonrpc":"2.0","id":"hello","method":"system.hello","params":{"api_version":1}})).unwrap()).unwrap();
    let mut reader = BufReader::new(socket);
    read(&mut reader);
    reader
}
fn read(reader: &mut BufReader<UnixStream>) -> Value {
    serde_json::from_slice(&protocol::read_frame(reader).unwrap().unwrap()).unwrap()
}
fn request(reader: &mut BufReader<UnixStream>, id: &str, method: &str, params: Value) {
    reader
        .get_mut()
        .write_all(
            &protocol::encode(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
                .unwrap(),
        )
        .unwrap();
}

#[test]
fn two_starters_converge_and_permissions_are_private() {
    let mut server = Server::new();
    let mut first = server.command("start").spawn().unwrap();
    let mut second = server.command("start").spawn().unwrap();
    assert!(first.wait().unwrap().success());
    assert!(second.wait().unwrap().success());
    server.ready();
    let workers = server.workers();
    assert_eq!(workers.len(), 1);
    let status = fs::read_to_string(format!("/proc/{}/status", workers[0])).unwrap();
    server.pid = Some(
        status
            .lines()
            .find_map(|l| l.strip_prefix("PPid:").map(str::trim))
            .unwrap()
            .parse()
            .unwrap(),
    );
    assert_eq!(fs::metadata(&server.socket).unwrap().mode() & 0o777, 0o600);
    for path in [server.root.join("state"), server.root.join("state/logs")] {
        assert_eq!(fs::metadata(path).unwrap().mode() & 0o777, 0o700);
    }
    assert_eq!(
        fs::metadata(server.root.join("state/owner.lock"))
            .unwrap()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn an_explicit_upgrade_replaces_an_idle_legacy_server_after_release() {
    let mut server = Server::new();
    let state = server.root.join("state");
    let lock = process::lock(&state).unwrap();
    let listener = UnixListener::bind(&server.socket).unwrap();
    fs::set_permissions(&server.socket, fs::Permissions::from_mode(0o600)).unwrap();
    let socket = server.socket.clone();
    let old = std::thread::spawn(move || {
        for attempt in 0..3 {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut stream = BufReader::new(stream);
            let hello = read(&mut stream);
            assert_eq!(hello["method"], "system.hello");
            assert_eq!(hello["params"], json!({"api_version":1}));
            stream.get_mut().write_all(&protocol::encode(&protocol::response(hello["id"].clone(), Ok(json!({"api_version":1,"state_dir":state,"instance_id":"legacy","ready":true,"storage_ready":true})))).unwrap()).unwrap();
            if attempt < 2 {
                assert!(protocol::read_frame(&mut stream).unwrap().is_none());
            } else {
                let shutdown = read(&mut stream);
                assert_eq!(shutdown["method"], "server.shutdown");
                assert_eq!(shutdown["params"], json!({}));
                stream
                    .get_mut()
                    .write_all(
                        &protocol::encode(&protocol::response(
                            shutdown["id"].clone(),
                            Ok(json!({})),
                        ))
                        .unwrap(),
                    )
                    .unwrap();
            }
        }
        drop(listener);
        fs::remove_file(socket).unwrap();
        drop(lock);
    });
    let rejected = server
        .command("start")
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(rejected.status.code(), Some(3));
    assert!(
        String::from_utf8(rejected.stderr)
            .unwrap()
            .contains("harness upgrade")
    );
    assert!(server.workers().is_empty());
    assert!(process::lock(&server.root.join("state")).is_err());
    let upgraded = server
        .command("upgrade")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert!(
        upgraded.status.success(),
        "{}",
        String::from_utf8_lossy(&upgraded.stderr)
    );
    old.join().unwrap();
    let hello: Value = serde_json::from_slice(&upgraded.stdout).unwrap();
    assert_eq!(hello["api_revision"], 2);
    assert_eq!(hello["state_dir"], json!(server.root.join("state")));
    assert_ne!(hello["instance_id"], "legacy");
    server.pid = Some(process::peer_pid(&UnixStream::connect(&server.socket).unwrap()).unwrap());
    assert_eq!(server.workers().len(), 1);
}

#[test]
fn upgrade_checks_legacy_state_before_shutdown() {
    let server = Server::new();
    let listener = UnixListener::bind(&server.socket).unwrap();
    fs::set_permissions(&server.socket, fs::Permissions::from_mode(0o600)).unwrap();
    let task = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut stream = BufReader::new(stream);
        let hello = read(&mut stream);
        stream.get_mut().write_all(&protocol::encode(&protocol::response(hello["id"].clone(), Ok(json!({"api_version":1,"state_dir":"/another/state","ready":true,"storage_ready":true})))).unwrap()).unwrap();
        assert!(
            protocol::read_frame(&mut stream).unwrap().is_none(),
            "Upgrade sent a request to another state"
        );
    });
    let result = server
        .command("upgrade")
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(6));
    assert!(
        String::from_utf8(result.stderr)
            .unwrap()
            .contains("state directory")
    );
    task.join().unwrap();
    assert!(server.workers().is_empty());
}

#[test]
fn upgrade_never_shuts_down_an_unknown_or_newer_interface() {
    for after_probe in [false, true] {
        for revision in [json!(3), json!("2"), Value::Null] {
            let server = Server::new();
            let state = server.root.join("state");
            process::private_dir(&state).unwrap();
            let listener = UnixListener::bind(&server.socket).unwrap();
            fs::set_permissions(&server.socket, fs::Permissions::from_mode(0o600)).unwrap();
            let task = std::thread::spawn(move || {
                for attempt in 0..=usize::from(after_probe) {
                    let (stream, _) = listener.accept().unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut stream = BufReader::new(stream);
                    let hello = read(&mut stream);
                    assert_eq!(hello["method"], "system.hello");
                    let mut value = json!({"api_version":1,"state_dir":state,"ready":true,"storage_ready":true});
                    if attempt == usize::from(after_probe) {
                        value["api_revision"] = revision.clone();
                    }
                    stream
                        .get_mut()
                        .write_all(
                            &protocol::encode(&protocol::response(hello["id"].clone(), Ok(value)))
                                .unwrap(),
                        )
                        .unwrap();
                    assert!(
                        protocol::read_frame(&mut stream).unwrap().is_none(),
                        "Upgrade sent shutdown to an unsupported interface"
                    );
                }
            });
            let result = server
                .command("upgrade")
                .stderr(Stdio::piped())
                .output()
                .unwrap();
            assert_eq!(result.status.code(), Some(3));
            assert!(
                String::from_utf8(result.stderr)
                    .unwrap()
                    .contains("Update Harness")
            );
            task.join().unwrap();
            assert!(server.workers().is_empty());
        }
    }
}

#[test]
fn an_old_worker_interface_never_becomes_ready_or_accepts_mutations() {
    let mut server = Server::new();
    server.child = Some(
        server
            .command("serve")
            .env("HARNESS_FAKE_MODE", "old-interface")
            .spawn()
            .unwrap(),
    );
    server.pid = Some(server.child.as_ref().unwrap().id());
    until(|| server.workers().len() == 4);
    let mut client = server.client().unwrap();
    let hello = client
        .request("system.hello", json!({"api_version":1}))
        .unwrap();
    assert_eq!(hello["api_revision"], 2);
    assert_eq!(hello["storage_ready"], false);
    assert_eq!(hello["ready"], false);
    let error = client
        .request(
            "session.create",
            json!({"session_id":"blocked","workspace":server.root,"name":"New chat"}),
        )
        .unwrap_err();
    assert_eq!(error.kind(), Some("not_ready"));
}

#[test]
fn applying_a_key_rejects_an_existing_server_without_replacing_it() {
    let mut server = Server::new();
    server.serve("");
    let config = harness::config::Config::load(Some(&server.config), None, None).unwrap();
    let original = harness::server::start(&config).unwrap();
    let workers = server.workers();
    let key = "replacement-test-key-must-not-be-returned";
    let error = harness::server::start_with_key(&config, Some(key)).unwrap_err();
    assert_eq!(error.kind(), Some("conflict"));
    assert!(error.message.contains("key was not applied"));
    assert!(!error.message.contains(key));
    assert_eq!(harness::server::start(&config).unwrap(), original);
    assert_eq!(server.workers(), workers);
    assert!(server.child.as_mut().unwrap().try_wait().unwrap().is_none());
}

#[test]
fn pending_wait_does_not_block_stop_and_lost_watch_is_released() {
    let mut server = Server::new();
    server.serve("");
    let mut client = raw(&server);
    request(
        &mut client,
        "wait",
        "submission.wait",
        json!({"session_id":"work","request_id":"r"}),
    );
    request(
        &mut client,
        "stop",
        "run.stop",
        json!({"session_id":"work","submission_id":"opaque"}),
    );
    assert_eq!(read(&mut client)["id"], "stop");
    drop(client);
    let mut client = raw(&server);
    request(
        &mut client,
        "watch",
        "session.watch",
        json!({"session_id":"work"}),
    );
    std::thread::sleep(Duration::from_millis(20));
    drop(client);
    until(|| {
        fs::read_to_string(server.root.join("state/released"))
            .unwrap_or_default()
            .contains("watch-w")
    });
}

#[test]
fn framing_validation_and_connection_limits_are_enforced() {
    let mut server = Server::new();
    server.serve("");
    let mut client = raw(&server);
    client.get_mut().write_all(b"{bad}\n").unwrap();
    assert_eq!(read(&mut client)["error"]["code"], -32700);
    request(
        &mut client,
        "bad",
        "session.get",
        json!({"session_id":"work","extra":true}),
    );
    assert_eq!(read(&mut client)["error"]["code"], -32602);
    request(
        &mut client,
        "version",
        "system.hello",
        json!({"api_version":2}),
    );
    assert_eq!(
        read(&mut client)["error"]["data"]["kind"],
        "incompatible_version"
    );
    client
        .get_mut()
        .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"session.list\",\"params\":{}}\n")
        .unwrap();
    assert!(protocol::read_frame(&mut client).unwrap().is_none());
    let mut oversized = raw(&server);
    let _ = oversized
        .get_mut()
        .write_all(&vec![b' '; protocol::MAX_RECORD + 1]);
    match oversized.get_mut().read(&mut [0]) {
        Ok(0) => {}
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
        result => panic!("Oversized record did not close the connection: {result:?}"),
    }
    let mut clients = Vec::new();
    for _ in 0..32 {
        clients.push(raw(&server));
    }
    let extra = UnixStream::connect(&server.socket).unwrap();
    extra
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    assert!(
        protocol::read_frame(&mut BufReader::new(extra))
            .unwrap()
            .is_none()
    );
    request(&mut clients[0], "work", "session.list", json!({}));
    assert!(read(&mut clients[0])["result"]["items"].is_array());
}

#[test]
fn partial_and_combined_frames_preserve_correlation() {
    let mut server = Server::new();
    server.serve("");
    let mut client = raw(&server);
    let record=protocol::encode(&json!({"jsonrpc":"2.0","id":"λ世界","method":"session.get","params":{"session_id":"work"}})).unwrap();
    for part in record.chunks(2) {
        client.get_mut().write_all(part).unwrap();
    }
    assert_eq!(read(&mut client)["id"], "λ世界");
    let records = ["first", "second"]
        .into_iter()
        .flat_map(|id| {
            protocol::encode(&json!({"jsonrpc":"2.0","id":id,"method":"session.list","params":{}}))
                .unwrap()
        })
        .collect::<Vec<_>>();
    client.get_mut().write_all(&records).unwrap();
    let mut observed = [
        read(&mut client)["id"].as_str().unwrap().to_string(),
        read(&mut client)["id"].as_str().unwrap().to_string(),
    ];
    observed.sort();
    assert_eq!(observed, ["first", "second"]);
}

#[test]
fn slow_client_cannot_block_another_stop() {
    let mut server = Server::new();
    server.serve("");
    let mut slow = raw(&server);
    for batch in 0..3 {
        for n in 0..32 {
            request(
                &mut slow,
                &format!("bulk{batch}_{n}"),
                "entry.read",
                json!({"session_id":"work","entry_id":"e"}),
            );
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    let start = Instant::now();
    let result = server
        .client()
        .unwrap()
        .request("run.stop", json!({"session_id":"work","submission_id":"s"}))
        .unwrap();
    assert_eq!(result["status"], "unanswered");
    assert!(start.elapsed() < Duration::from_secs(1));
    while let Ok(Some(_)) = protocol::read_frame(&mut slow) {}
    assert!(protocol::read_frame(&mut slow).unwrap().is_none());
}

#[test]
fn pending_requests_and_watches_have_separate_limits() {
    let mut server = Server::new();
    server.serve("");
    let mut client = raw(&server);
    for n in 0..32 {
        request(
            &mut client,
            &format!("wait{n}"),
            "submission.wait",
            json!({"session_id":"work","request_id":"r"}),
        );
    }
    request(&mut client, "overflow", "session.list", json!({}));
    assert_eq!(read(&mut client)["error"]["data"]["kind"], "resource_limit");
    drop(client);
    let mut client = server.client().unwrap();
    for _ in 0..8 {
        client
            .request("session.watch", json!({"session_id":"work"}))
            .unwrap();
    }
    assert_eq!(
        client
            .request("session.watch", json!({"session_id":"work"}))
            .unwrap_err()
            .kind(),
        Some("resource_limit")
    );
    client
        .request("session.unwatch", json!({"watch_id":"other-client-watch"}))
        .unwrap();
    assert_eq!(
        client
            .request("session.watch", json!({"session_id":"work"}))
            .unwrap_err()
            .kind(),
        Some("resource_limit")
    );
}

#[test]
fn orphan_worker_keeps_storage_ownership() {
    let mut server = Server::new();
    server.serve("orphan");
    let worker = server.workers()[0];
    kill(worker, "-STOP");
    kill(server.pid.unwrap(), "-KILL");
    server.child.as_mut().unwrap().wait().unwrap();
    server.pid = None;
    let result = server.command("serve").status().unwrap();
    assert_eq!(result.code(), Some(6));
    assert_eq!(server.workers().len(), 1);
    kill(worker, "-KILL");
    until(|| {
        let f = fs::OpenOptions::new()
            .read(true)
            .open(server.root.join("state/owner.lock"))
            .unwrap();
        f.try_lock().is_ok()
    });
    server.serve("");
    assert_eq!(server.workers().len(), 2);
}

#[test]
fn worker_restart_limit_and_manual_attempt_are_bounded() {
    let mut server = Server::new();
    server.serve("crash");
    until(|| server.workers().len() == 4);
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(server.workers().len(), 4);
    let mut client = server.client().unwrap();
    assert_eq!(
        client
            .request("system.hello", json!({"api_version":1}))
            .unwrap()["storage_ready"],
        false
    );
    client.request("server.restart_worker", json!({})).unwrap();
    until(|| server.workers().len() == 5);
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(server.workers().len(), 5);
}

#[test]
fn state_identity_symlinks_and_explicit_paths_are_checked() {
    let mut server = Server::new();
    server.serve("");
    let alternate = server.root.join("other.json");
    fs::write(
        &alternate,
        serde_json::to_vec(
            &json!({"state_dir":server.root.join("other"),"socket_path":server.socket}),
        )
        .unwrap(),
    )
    .unwrap();
    let result = Command::new(binary())
        .arg("start")
        .arg("--config")
        .arg(&alternate)
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(6));
    assert_eq!(server.workers().len(), 1);
    let linked = server.root.join("linked.sock");
    symlink(&server.socket, &linked).unwrap();
    assert!(
        Command::new(binary())
            .args(["status", "--socket"])
            .arg(linked)
            .output()
            .unwrap()
            .status
            .code()
            .is_some_and(|c| c != 0)
    );
    let result = Command::new(binary())
        .arg("status")
        .arg("--config")
        .arg(&server.config)
        .env_remove("HOME")
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("XDG_STATE_HOME")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    fs::set_permissions(&server.socket, fs::Permissions::from_mode(0o666)).unwrap();
    assert!(server.client().is_err());
}
