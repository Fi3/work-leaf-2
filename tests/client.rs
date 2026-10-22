use harness::client::Client;
use harness::protocol::{MAX_INPUT, MAX_RECORD, RpcError, encode, read_frame, response};
use serde_json::{Value, json};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStringExt;
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
            .env_remove("HARNESS_SESSION_ID")
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
        json!({"api_version":1,"api_revision":4,"instance_id":"test","state_dir":"/tmp","ready":true}),
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

fn output_flags(output: &impl AsRawFd) -> i32 {
    // The descriptor stays open while fcntl reads its current file status flags.
    let flags = unsafe { libc::fcntl(output.as_raw_fd(), libc::F_GETFL) };
    assert!(flags >= 0);
    flags
}

fn output_pair(socket: bool) -> (OwnedFd, OwnedFd) {
    if socket {
        let (reader, writer) = UnixStream::pair().unwrap();
        (reader.into(), writer.into())
    } else {
        let (reader, writer) = std::io::pipe().unwrap();
        (reader.into(), writer.into())
    }
}

#[test]
fn standard_output_preserves_caller_flags_and_later_pipe_output() {
    for (socket, nonblocking) in [(false, false), (true, false), (false, true), (true, true)] {
        let fixture = Fixture::new(|stream| {
            hello(stream);
            let input = request(stream);
            reply(stream, &input, json!({"items":[]}));
        });
        let (reader, writer) = output_pair(socket);
        let mut writer = fs::File::from(writer);
        if nonblocking {
            harness::process::nonblocking(writer.as_raw_fd()).unwrap();
        }
        let flags = output_flags(&writer);
        let output = fixture
            .command(&["session", "list"])
            .stdout(writer.try_clone().unwrap())
            .output()
            .unwrap();
        success(&output);
        let observed_flags = output_flags(&writer);
        let reading = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            let mut data = Vec::new();
            fs::File::from(reader).read_to_end(&mut data).unwrap();
            data
        });
        let later = vec![b'y'; if nonblocking { 1 } else { 1024 * 1024 }];
        let written = writer.write_all(&later);
        drop(writer);
        let data = reading.join().unwrap();
        assert_eq!(observed_flags, flags, "The caller's output flags changed");
        written.unwrap();
        let mut expected = b"{\"items\":[]}\n".to_vec();
        expected.extend(later);
        assert_eq!(data, expected);
    }
}

#[test]
fn standard_output_preserves_inherited_terminal_flags() {
    let mut master = -1;
    let mut slave = -1;
    // openpty initializes two owned descriptors; null pointers select the default terminal settings.
    assert_eq!(
        unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
            )
        },
        0
    );
    // Both descriptors were returned by the successful openpty call and are owned only here.
    let (master, slave) = unsafe { (fs::File::from_raw_fd(master), fs::File::from_raw_fd(slave)) };
    let fixture = Fixture::new(|stream| {
        hello(stream);
        let input = request(stream);
        reply(stream, &input, json!({"items":[]}));
    });
    let flags = output_flags(&slave);
    success(
        &fixture
            .command(&["session", "list"])
            .stdout(slave.try_clone().unwrap())
            .output()
            .unwrap(),
    );
    assert_eq!(output_flags(&slave), flags);
    drop(slave);
    let mut line = String::new();
    BufReader::new(master).read_line(&mut line).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&line).unwrap(),
        json!({"items":[]})
    );
}

#[test]
fn standard_output_preserves_file_offsets_and_flags_on_failure() {
    let fixture = Fixture::new(|stream| {
        hello(stream);
        for _ in 0..2 {
            let input = request(stream);
            reply(stream, &input, json!({"items":[]}));
        }
        disconnected(stream);
    });
    let path = fixture.dir.join("output");
    let mut file = fs::File::create(&path).unwrap();
    file.write_all(b"before\n").unwrap();
    let flags = output_flags(&file);
    let mut child = fixture
        .command(&["rpc"])
        .stdout(file.try_clone().unwrap())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    for id in ["one", "two"] {
        input
            .write_all(
                &encode(&json!({"jsonrpc":"2.0","id":id,"method":"session.list","params":{}}))
                    .unwrap(),
            )
            .unwrap();
    }
    drop(input);
    success(&child.wait_with_output().unwrap());
    assert_eq!(output_flags(&file), flags);
    file.write_all(b"after\n").unwrap();
    let data = fs::read_to_string(path).unwrap();
    let lines: Vec<_> = data.lines().collect();
    assert_eq!((lines[0], lines[3]), ("before", "after"));
    assert_eq!(
        serde_json::from_str::<Value>(lines[1]).unwrap()["id"],
        "one"
    );
    assert_eq!(
        serde_json::from_str::<Value>(lines[2]).unwrap()["id"],
        "two"
    );

    let fixture = Fixture::new(|stream| {
        hello(stream);
        let input = request(stream);
        reply(stream, &input, json!({"items":[]}));
    });
    let (reader, writer) = std::io::pipe().unwrap();
    drop(reader);
    let flags = output_flags(&writer);
    let output = fixture
        .command(&["session", "list"])
        .stdout(writer.try_clone().unwrap())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3));
    assert_eq!(output_flags(&writer), flags);
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
fn chat_revision_is_checked_before_any_operation() {
    for revision in [
        None,
        Some(json!(1)),
        Some(json!(2)),
        Some(json!(3)),
        Some(json!(5)),
        Some(Value::Null),
    ] {
        for command in [
            vec![
                "session",
                "create",
                "--id",
                "work",
                "--workspace",
                "/tmp",
                "--name",
                "New chat",
            ],
            vec![
                "send",
                "--session",
                "work",
                "--request-id",
                "task",
                "--stdin",
            ],
            vec!["rpc"],
        ] {
            let revision = revision.clone();
            let legacy = revision.is_none()
                || revision == Some(json!(1))
                || revision == Some(json!(2))
                || revision == Some(json!(3));
            let fixture = Fixture::new(move |stream| {
                let input = request(stream);
                assert_eq!(input["method"], "system.hello");
                let mut hello = json!({"api_version":1,"state_dir":"/tmp"});
                if let Some(revision) = revision {
                    hello["api_revision"] = revision;
                }
                reply(stream, &input, hello);
                disconnected(stream);
            });
            let output = fixture.run(&command, b"Preserve this draft\n");
            assert_eq!(output.status.code(), Some(3));
            assert!(output.stdout.is_empty());
            assert!(
                String::from_utf8(output.stderr)
                    .unwrap()
                    .contains(if legacy {
                        "harness upgrade"
                    } else {
                        "Update Harness"
                    })
            );
        }
    }
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
fn chat_commands_preserve_settings_and_parent_precedence() {
    for (args, inherited_parent, method, params) in [
        (
            vec![
                "session",
                "create",
                "--id",
                "child",
                "--workspace",
                "/tmp",
                "--name",
                "Review λ",
            ],
            "parent",
            "session.create",
            json!({"session_id":"child","workspace":"/tmp","parent_session_id":"parent","name":"Review λ"}),
        ),
        (
            vec![
                "session",
                "create",
                "--id",
                "child",
                "--workspace",
                "/tmp",
                "--parent",
                "explicit",
            ],
            "inherited",
            "session.create",
            json!({"session_id":"child","workspace":"/tmp","parent_session_id":"explicit"}),
        ),
        (
            vec![
                "session",
                "configure",
                "--session",
                "chat",
                "--provider",
                "faux",
                "--model",
                "test",
                "--instructions",
                "Keep λ\nTwo lines",
                "--name",
                "Review",
            ],
            "not/a/valid/id",
            "session.configure",
            json!({"session_id":"chat","provider":"faux","model":"test","instructions":"Keep λ\nTwo lines","name":"Review"}),
        ),
        (
            vec![
                "session",
                "configure",
                "--session",
                "chat",
                "--instructions",
                "",
            ],
            "ignored",
            "session.configure",
            json!({"session_id":"chat","instructions":""}),
        ),
        (
            vec!["session", "list", "--workspace", "/tmp"],
            "ignored",
            "session.list",
            json!({"workspace":"/tmp"}),
        ),
    ] {
        let fixture = Fixture::new(move |stream| {
            hello(stream);
            let input = request(stream);
            assert_eq!(input["method"], method);
            assert_eq!(input["params"], params);
            reply(stream, &input, json!({"ok":true}));
            disconnected(stream);
        });
        let output = fixture
            .command(&args)
            .env("HARNESS_SESSION_ID", inherited_parent)
            .output()
            .unwrap();
        success(&output);
    }
}

#[test]
fn incomplete_chat_settings_and_key_arguments_fail_before_connecting() {
    for args in [
        vec!["session", "configure", "--session", "chat"],
        vec![
            "session",
            "configure",
            "--session",
            "chat",
            "--provider",
            "anthropic",
        ],
        vec![
            "session",
            "configure",
            "--session",
            "chat",
            "--model",
            "test",
        ],
        vec!["auth", "--api-key", "must-not-appear"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_harness"))
            .args(args)
            .arg("--socket")
            .arg("/nonexistent/harness.sock")
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(2),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&output.stderr).contains("must-not-appear"));
    }
    let output = Command::new(env!("CARGO_BIN_EXE_harness"))
        .args(["session", "create", "--id", "child", "--workspace", "/tmp"])
        .env(
            "HARNESS_SESSION_ID",
            std::ffi::OsString::from_vec(vec![0xff]),
        )
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("HARNESS_SESSION_ID must be UTF-8"));
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
        vec!["ssh", "--host", "example", "--workspace", "/tmp"],
        vec!["browser"],
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
    for (proxy, socket) in [(false, false), (true, false), (false, true), (true, true)] {
        let (send, receive) = mpsc::channel();
        let fixture = Fixture::new(move |stream| {
            hello(stream);
            let input = request(stream);
            reply(stream, &input, json!({"text":"x".repeat(1024 * 1024)}));
            send.send(()).unwrap();
            disconnected(stream);
        });
        let (_reader, writer) = output_pair(socket);
        let flags = output_flags(&writer);
        let mut child = fixture
            .command(if proxy {
                &["rpc"]
            } else {
                &["session", "list"]
            })
            .stdout(writer.try_clone().unwrap())
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
        assert_eq!(output_flags(&writer), flags);
    }
}

#[test]
fn default_configuration_checks_state_before_mutations() {
    for args in [
        vec!["send", "--session", "work", "--request-id", "r", "--stdin"],
        vec!["stop", "--session", "work", "--submission-id", "s"],
        vec!["rpc"],
    ] {
        let (sent, observed) = mpsc::channel();
        let fixture = Fixture::new(move |stream| {
            hello(stream);
            let record = read_frame(stream).unwrap();
            sent.send(record.is_none()).unwrap();
            if let Some(record) = record {
                let input = serde_json::from_slice(&record).unwrap();
                reply(stream, &input, json!({"status":"accepted"}));
            }
        });
        let settings = fixture.dir.join("harness");
        let state = fixture.dir.join("state-b");
        fs::create_dir(&settings).unwrap();
        fs::create_dir(&state).unwrap();
        fs::write(
            settings.join("config.json"),
            serde_json::to_vec(&json!({"state_dir":state,"socket_path":fixture.socket})).unwrap(),
        )
        .unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_harness"))
            .args(&args)
            .env("XDG_CONFIG_HOME", &fixture.dir)
            .env("XDG_STATE_HOME", &fixture.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = if args[0] == "rpc" {
            encode(&json!({"jsonrpc":"2.0","id":"mutation","method":"run.stop","params":{"session_id":"work","submission_id":"s"}})).unwrap()
        } else {
            b"Task".to_vec()
        };
        let _ = child.stdin.take().unwrap().write_all(&input);
        let output = child.wait_with_output().unwrap();
        assert!(
            observed.recv().unwrap(),
            "A mutation reached the wrong state directory"
        );
        assert_eq!(
            output.status.code(),
            Some(6),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stdout.is_empty());
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .contains("another state directory")
        );
    }
}

#[test]
fn explicit_socket_can_select_an_endpoint_outside_default_configuration() {
    let fixture = Fixture::new(|stream| {
        hello(stream);
        let input = request(stream);
        assert_eq!(input["method"], "session.list");
        reply(stream, &input, json!({"items":[]}));
    });
    let settings = fixture.dir.join("harness");
    fs::create_dir(&settings).unwrap();
    fs::write(settings.join("config.json"), serde_json::to_vec(&json!({"state_dir":fixture.dir.join("other-state"),"socket_path":fixture.dir.join("other.sock")})).unwrap()).unwrap();
    success(&fixture.run(&["session", "list"], b""));
}

#[test]
fn client_configuration_selects_socket_and_checks_state() {
    for explicit in [false, true] {
        let fixture = Fixture::new(|stream| {
            let input = request(stream);
            let state = stream.get_ref().local_addr().unwrap();
            let state = state.as_pathname().unwrap().parent().unwrap();
            reply(
                stream,
                &input,
                json!({"api_version":1,"api_revision":4,"state_dir":state}),
            );
            let input = request(stream);
            assert_eq!(input["method"], "session.list");
            reply(stream, &input, json!({"items":[]}));
            disconnected(stream);
        });
        let directory = fixture.dir.join("harness");
        fs::create_dir(&directory).unwrap();
        let config = directory.join("config.json");
        fs::write(
            &config,
            serde_json::to_vec(&json!({"state_dir":fixture.dir,"socket_path":fixture.socket}))
                .unwrap(),
        )
        .unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_harness"));
        if explicit {
            command.arg("--config").arg(config);
        }
        let output = command
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
}
