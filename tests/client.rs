use harness::client::Client;
use harness::protocol::{MAX_INPUT, MAX_RECORD, RpcError, encode, read_frame, response};
use serde_json::{Value, json};
use std::fs;
use std::io::{BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    dir: PathBuf,
    socket: PathBuf,
    task: Option<thread::JoinHandle<()>>,
}

impl Fixture {
    fn new(run: impl FnOnce(&mut BufReader<UnixStream>) + Send + 'static) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "harness-client-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&dir).unwrap();
        let socket = dir.join("control.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
        let task = thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            run(&mut BufReader::new(socket));
        });
        Self {
            dir,
            socket,
            task: Some(task),
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_harness"));
        command
            .args(args)
            .arg("--socket")
            .arg(&self.socket)
            .env("XDG_CONFIG_HOME", &self.dir)
            .env("XDG_STATE_HOME", &self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    fn run(&self, args: &[&str], input: &[u8]) -> Output {
        let mut child = self.command(args).spawn().unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        child.wait_with_output().unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.join().unwrap();
        }
        fs::remove_dir_all(&self.dir).unwrap();
    }
}

fn request(stream: &mut BufReader<UnixStream>) -> Value {
    serde_json::from_slice(&read_frame(stream).unwrap().unwrap()).unwrap()
}

fn reply(stream: &mut BufReader<UnixStream>, request: &Value, value: Value) {
    stream
        .get_mut()
        .write_all(&encode(&response(request["id"].clone(), Ok(value))).unwrap())
        .unwrap();
}

fn hello(stream: &mut BufReader<UnixStream>) {
    let input = request(stream);
    assert_eq!(input["method"], "system.hello");
    assert_eq!(input["params"], json!({"api_version":1}));
    reply(
        stream,
        &input,
        json!({"api_version":1,"instance_id":"test","state_dir":"/tmp","ready":true}),
    );
}

fn disconnected(stream: &mut BufReader<UnixStream>) {
    assert!(
        read_frame(stream).unwrap().is_none(),
        "Client sent an unexpected request"
    );
}

fn success(output: &Output) {
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn fragments_and_unicode_preserve_response_values() {
    for width in [1, 2, 3, 7, 64, 4096] {
        let fixture = Fixture::new(move |stream| {
            hello(stream);
            let input = request(stream);
            assert_eq!(input["method"], "session.list");
            let bytes = encode(&response(
                input["id"].clone(),
                Ok(json!({"items":["é中🙂\ntext"],"next_cursor":null})),
            ))
            .unwrap();
            for part in bytes.chunks(width) {
                stream.get_mut().write_all(part).unwrap();
            }
        });
        let mut client = Client::connect(&fixture.socket, None).unwrap();
        assert_eq!(
            client.request("session.list", json!({})).unwrap()["items"][0],
            "é中🙂\ntext"
        );
    }
}

#[test]
fn handshake_rejects_wrong_version_state_and_unsafe_socket() {
    let fixture = Fixture::new(|stream| {
        let input = request(stream);
        reply(stream, &input, json!({"api_version":2,"state_dir":"/tmp"}));
    });
    assert_eq!(
        Client::connect(&fixture.socket, None).err().unwrap().kind(),
        Some("incompatible_version")
    );
    let fixture = Fixture::new(hello);
    assert_eq!(
        Client::connect(&fixture.socket, Some(Path::new("/")))
            .err()
            .unwrap()
            .kind(),
        Some("conflict")
    );
    let dir = std::env::temp_dir().join(format!("harness-unsafe-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("socket");
    let _listener = UnixListener::bind(&socket).unwrap();
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o666)).unwrap();
    assert_eq!(
        Client::connect(&socket, None).err().unwrap().kind(),
        Some("not_ready")
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn scripts_create_send_and_stop_without_terminal() {
    for (args, method, params, input) in [
        (
            vec!["session", "create", "--id", "work", "--workspace", "/tmp"],
            "session.create",
            json!({"session_id":"work","workspace":"/tmp"}),
            "",
        ),
        (
            vec![
                "send",
                "--session",
                "work",
                "--request-id",
                "request_1",
                "--stdin",
            ],
            "input.submit",
            json!({"session_id":"work","request_id":"request_1","text":"é中🙂\nTask\n","context":[]}),
            "é中🙂\nTask\n",
        ),
        (
            vec!["stop", "--session", "work", "--submission-id", "opaque"],
            "run.stop",
            json!({"session_id":"work","submission_id":"opaque"}),
            "",
        ),
    ] {
        let fixture = Fixture::new(move |stream| {
            hello(stream);
            let request = request(stream);
            assert_eq!(request["method"], method);
            assert_eq!(request["params"], params);
            reply(
                stream,
                &request,
                json!({"status":"unanswered","reason":"cancelled"}),
            );
            disconnected(stream);
        });
        let output = fixture.run(&args, input.as_bytes());
        success(&output);
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap()["status"],
            "unanswered"
        );
    }
}

#[test]
fn wait_text_reads_complete_utf8_chunks() {
    let expected = "é🙂".repeat(20_000);
    let answer = expected.clone();
    let fixture = Fixture::new(move |stream| {
        hello(stream);
        let input = request(stream);
        assert_eq!(input["method"], "submission.wait");
        assert_eq!(input["params"]["timeout_ms"], 2500);
        reply(
            stream,
            &input,
            json!({"status":"done","answer_entry_id":"answer"}),
        );
        let mut offset = 0;
        for part in answer.as_bytes().chunks(60_000) {
            let input = request(stream);
            assert_eq!(input["method"], "entry.read");
            assert_eq!(input["params"]["offset"], offset);
            assert_eq!(input["params"]["entry_id"], "answer");
            offset += part.len();
            reply(
                stream,
                &input,
                json!({"text":std::str::from_utf8(part).unwrap(),"next_offset":offset,"end":offset==answer.len()}),
            );
        }
        disconnected(stream);
    });
    let output = fixture.run(
        &[
            "wait",
            "--session",
            "work",
            "--request-id",
            "r",
            "--timeout-ms",
            "2500",
            "--text",
        ],
        b"",
    );
    success(&output);
    assert_eq!(output.stdout, expected.as_bytes());
}

#[test]
fn exact_wait_outcomes_map_to_exit_status() {
    for (value, status) in [
        (json!({"status":"done"}), 0),
        (json!({"status":"unanswered","reason":"cancelled"}), 5),
        (json!({"status":"unanswered","reason":"provider_error"}), 1),
    ] {
        let fixture = Fixture::new(move |stream| {
            hello(stream);
            let input = request(stream);
            reply(stream, &input, value);
        });
        assert_eq!(
            fixture
                .run(&["wait", "--session", "s", "--request-id", "r"], b"")
                .status
                .code(),
            Some(status)
        );
    }
    for (kind, status) in [
        ("timeout", 4),
        ("busy", 6),
        ("conflict", 6),
        ("resource_limit", 6),
        ("not_ready", 3),
        ("storage_error", 3),
        ("provider_error", 1),
    ] {
        let fixture = Fixture::new(move |stream| {
            hello(stream);
            let input = request(stream);
            stream
                .get_mut()
                .write_all(
                    &encode(&response(
                        input["id"].clone(),
                        Err(RpcError::app(kind, "Test failure")),
                    ))
                    .unwrap(),
                )
                .unwrap();
        });
        let output = fixture.run(&["wait", "--session", "s", "--request-id", "r"], b"");
        assert_eq!(output.status.code(), Some(status));
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn proxy_preserves_ids_values_out_of_order_and_drains_eof() {
    let fixture = Fixture::new(|stream| {
        hello(stream);
        let wait = request(stream);
        let stop = request(stream);
        assert_eq!(wait["id"], "wait/é");
        assert_eq!(stop["id"], "stop");
        assert_eq!(wait["params"]["timeout_ms"], 1234);
        reply(
            stream,
            &stop,
            json!({"status":"unanswered","reason":"cancelled","text":"é中🙂"}),
        );
        thread::sleep(Duration::from_millis(100));
        reply(
            stream,
            &wait,
            json!({"status":"unanswered","reason":"cancelled"}),
        );
        disconnected(stream);
    });
    let input = "{\"jsonrpc\":\"2.0\",\"id\":\"wait/é\",\"method\":\"submission.wait\",\"params\":{\"session_id\":\"s\",\"request_id\":\"r\",\"timeout_ms\":1234}}\n{\"jsonrpc\":\"2.0\",\"id\":\"stop\",\"method\":\"run.stop\",\"params\":{\"session_id\":\"s\",\"submission_id\":\"opaque\"}}\n";
    let output = fixture.run(&["rpc"], input.as_bytes());
    success(&output);
    let values: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(values.len(), 2);
    assert_eq!(values[0]["id"], "stop");
    assert_eq!(values[1]["id"], "wait/é");
    assert_eq!(values[0]["result"]["text"], "é中🙂");
}

#[test]
fn proxy_releases_watch_at_eof_without_stopping() {
    let fixture = Fixture::new(|stream| {
        hello(stream);
        let input = request(stream);
        assert_eq!(input["method"], "session.watch");
        reply(
            stream,
            &input,
            json!({"watch_id":"w","snapshot":{"state":"running"}}),
        );
        disconnected(stream);
    });
    let input = encode(
        &json!({"jsonrpc":"2.0","id":"watch","method":"session.watch","params":{"session_id":"s"}}),
    )
    .unwrap();
    let output = fixture.run(&["rpc"], &input);
    success(&output);
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["result"]["snapshot"]["state"],
        "running"
    );
}

#[test]
fn watch_stream_reports_initial_and_later_state() {
    let fixture = Fixture::new(|stream| {
        hello(stream);
        let input = request(stream);
        reply(
            stream,
            &input,
            json!({"watch_id":"w","snapshot":{"state":"running"}}),
        );
        stream.get_mut().write_all(&encode(&json!({"jsonrpc":"2.0","method":"session.state","params":{"watch_id":"w","sequence":1,"snapshot":{"state":"idle"}}})).unwrap()).unwrap();
    });
    let output = fixture.run(&["watch", "--session", "s"], b"");
    assert_eq!(output.status.code(), Some(3));
    let lines: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["snapshot"]["state"], "running");
    assert_eq!(lines[1]["params"]["snapshot"]["state"], "idle");
}

#[test]
fn proxy_rejects_duplicate_pending_ids_and_capacity_overflow() {
    for (count, duplicate, status) in [(2, true, 2), (33, false, 6)] {
        let fixture = Fixture::new(move |stream| {
            hello(stream);
            for _ in 0..if duplicate { 1 } else { 32 } {
                assert_eq!(request(stream)["method"], "submission.wait");
            }
            disconnected(stream);
        });
        let mut input = Vec::new();
        for index in 0..count {
            input.extend(encode(&json!({"jsonrpc":"2.0","id":if duplicate{"same".to_owned()}else{index.to_string()},"method":"submission.wait","params":{"session_id":"s","request_id":"r"}})).unwrap());
        }
        let output = fixture.run(&["rpc"], &input);
        assert_eq!(output.status.code(), Some(status));
    }
}

#[test]
fn malformed_incoming_and_outgoing_records_fail() {
    for input in [
        b"[]\n".as_slice(),
        b"{\n",
        b"{\"jsonrpc\":\"2.0\"}\n",
        b"{\"id\":",
        b"\xff\n",
    ] {
        let fixture = Fixture::new(|stream| {
            hello(stream);
            disconnected(stream);
        });
        assert!(!fixture.run(&["rpc"], input).status.success());
    }
    for record in [
        b"[]\n".to_vec(),
        b"{\n".to_vec(),
        b"{}".to_vec(),
        vec![b'x'; MAX_RECORD + 1],
    ] {
        let fixture = Fixture::new(move |stream| {
            hello(stream);
            let _ = request(stream);
            let _ = stream.get_mut().write_all(&record);
        });
        assert_eq!(
            fixture.run(&["session", "list"], b"").status.code(),
            Some(3)
        );
    }
}

#[test]
fn invalid_arguments_fail_before_connection() {
    for args in [
        vec!["send", "--session", "s", "--stdin"],
        vec![
            "wait",
            "--session",
            "s",
            "--request-id",
            "r",
            "--timeout-ms",
            "-1",
        ],
        vec!["stop", "--session", "bad/id", "--submission-id", "x"],
        vec!["session", "list", "--text"],
        vec!["wat"],
        vec!["status", "--socket", "x", "--socket", "y"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_harness"))
            .args(args)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(2),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let mut child = Command::new(env!("CARGO_BIN_EXE_harness"))
        .args(["send", "--session", "s", "--request-id", "r", "--stdin"])
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&vec![b'x'; MAX_INPUT + 1])
        .unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(6));
}

#[test]
fn sigint_interrupts_wait_and_standard_input_without_stop() {
    let (send, receive) = mpsc::channel();
    let fixture = Fixture::new(move |stream| {
        hello(stream);
        assert_eq!(request(stream)["method"], "submission.wait");
        send.send(()).unwrap();
        disconnected(stream);
    });
    let child = fixture
        .command(&["wait", "--session", "s", "--request-id", "r"])
        .spawn()
        .unwrap();
    receive.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(
        Command::new("kill")
            .args(["-INT", &child.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(child.wait_with_output().unwrap().status.code(), Some(130));
    let child = fixture
        .command(&["send", "--session", "s", "--request-id", "r", "--stdin"])
        .spawn()
        .unwrap();
    thread::sleep(Duration::from_millis(100));
    assert!(
        Command::new("kill")
            .args(["-INT", &child.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(child.wait_with_output().unwrap().status.code(), Some(130));
}

#[test]
fn sigint_interrupts_full_standard_output() {
    for proxy in [false, true] {
        let (send, receive) = mpsc::channel();
        let fixture = Fixture::new(move |stream| {
            hello(stream);
            let input = request(stream);
            reply(stream, &input, json!({"text":"x".repeat(1024 * 1024)}));
            send.send(()).unwrap();
            disconnected(stream);
        });
        let mut child = fixture
            .command(if proxy {
                &["rpc"]
            } else {
                &["session", "list"]
            })
            .spawn()
            .unwrap();
        if proxy {
            child
                .stdin
                .as_mut()
                .unwrap()
                .write_all(
                    &encode(
                        &json!({"jsonrpc":"2.0","id":"read","method":"session.list","params":{}}),
                    )
                    .unwrap(),
                )
                .unwrap();
        }
        receive.recv_timeout(Duration::from_secs(5)).unwrap();
        thread::sleep(Duration::from_millis(100));
        assert!(
            Command::new("kill")
                .args(["-INT", &child.id().to_string()])
                .status()
                .unwrap()
                .success()
        );
        assert_eq!(child.wait().unwrap().code(), Some(130));
    }
}

#[test]
fn client_configuration_selects_socket_and_checks_state() {
    let fixture = Fixture::new(|stream| {
        let input = request(stream);
        let state = stream.get_ref().local_addr().unwrap();
        let state = state.as_pathname().unwrap().parent().unwrap();
        reply(stream, &input, json!({"api_version":1,"state_dir":state}));
        let input = request(stream);
        assert_eq!(input["method"], "session.list");
        reply(stream, &input, json!({"items":[]}));
        disconnected(stream);
    });
    let config = fixture.dir.join("config.json");
    fs::write(
        &config,
        serde_json::to_vec(&json!({"state_dir":fixture.dir,"socket_path":fixture.socket})).unwrap(),
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_harness"))
        .args(["--config"])
        .arg(config)
        .args(["session", "list"])
        .env("XDG_CONFIG_HOME", &fixture.dir)
        .env("XDG_STATE_HOME", &fixture.dir)
        .output()
        .unwrap();
    success(&output);
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"items":[]})
    );
}
