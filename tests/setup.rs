use harness::{client::Client, config::Config, process};
use serde_json::{Value, json};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

static NEXT: AtomicU64 = AtomicU64::new(0);
const KEY: &str = "setup-test-key-must-not-be-printed";

struct Fixture {
    root: PathBuf,
    path: PathBuf,
    state: PathBuf,
    socket: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "h-setup-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self {
            path: root.join("config/harness/config.json"),
            state: root.join("state/harness"),
            socket: root.join("state/harness/run/control.sock"),
            root,
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_harness"));
        command
            .args(args)
            .current_dir(&self.root)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("HOME", &self.root)
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("XDG_STATE_HOME", self.root.join("state"));
        command
    }

    fn write(&self, value: &Value) -> Vec<u8> {
        fs::create_dir_all(self.path.parent().unwrap()).unwrap();
        let bytes = serde_json::to_vec_pretty(value).unwrap();
        fs::write(&self.path, &bytes).unwrap();
        bytes
    }

    fn config(&self) -> Config {
        Config::load_setup(Some(&self.path), Some(&self.state), Some(&self.socket)).unwrap()
    }

    fn client(&self) -> Client {
        Client::connect(&self.socket, Some(&self.state)).unwrap()
    }

    fn peer(&self) -> Option<i32> {
        let socket = UnixStream::connect(&self.socket).ok()?;
        Some(process::peer_pid(&socket).unwrap().try_into().unwrap())
    }

    fn wait_for_socket_removal(&self) -> bool {
        let deadline = Instant::now() + Duration::from_secs(6);
        while self.socket.exists() {
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(10));
        }
        true
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(pid) = self.peer() {
            // The peer came from this fixture's private socket, not from an unrelated PID lookup.
            unsafe { libc::kill(pid, libc::SIGTERM) };
            let _ = self.wait_for_socket_removal();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct Terminal {
    child: Child,
    master: File,
    slave: File,
    flags: libc::tcflag_t,
    output: String,
}

impl Terminal {
    fn spawn(mut command: Command) -> Self {
        let (mut master, mut slave) = (-1, -1);
        // openpty initializes two descriptors with default terminal settings.
        unsafe {
            assert_eq!(
                libc::openpty(
                    &mut master,
                    &mut slave,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    std::ptr::null()
                ),
                0
            );
        }
        // Each descriptor is newly owned by this test.
        let (master, slave) = unsafe { (File::from_raw_fd(master), File::from_raw_fd(slave)) };
        let flags = terminal_flags(&slave);
        command
            .stdin(Stdio::from(slave.try_clone().unwrap()))
            .stdout(Stdio::from(slave.try_clone().unwrap()))
            .stderr(Stdio::from(slave.try_clone().unwrap()));
        // Only async-signal-safe session/ioctl operations run in the child before exec.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
            assert_eq!(
                libc::fcntl(master.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK),
                0
            );
        }
        Self {
            child: command.spawn().unwrap(),
            master,
            slave,
            flags,
            output: String::new(),
        }
    }

    fn read(&mut self) {
        let mut bytes = [0; 8192];
        loop {
            match self.master.read(&mut bytes) {
                Ok(0) => break,
                Ok(count) => self
                    .output
                    .push_str(&String::from_utf8_lossy(&bytes[..count])),
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    break;
                }
                Err(error) => panic!("Terminal read: {error}"),
            }
        }
    }

    fn until(&mut self, text: &str) {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            self.read();
            if self.output.contains(text) {
                return;
            }
            assert!(
                self.child.try_wait().unwrap().is_none(),
                "Setup exited before {text}: {}",
                self.output
            );
            assert!(
                Instant::now() < deadline,
                "Setup did not show {text}: {}",
                self.output
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn send(&mut self, text: &str) {
        self.master.write_all(text.as_bytes()).unwrap();
    }

    fn choose(&mut self, label: &str, id: &str) {
        self.until(&format!("{label} number (q cancels): "));
        let number = self
            .output
            .lines()
            .rev()
            .find_map(|line| {
                let (number, text) = line.trim().split_once(". ")?;
                (text.ends_with(&format!("({id})")))
                    .then(|| number.parse::<usize>().ok())
                    .flatten()
            })
            .expect("Requested choice must appear in the visible catalog");
        self.send(&format!("{number}\n"));
    }

    fn finish(&mut self, expected: i32) {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            self.read();
            if let Some(status) = self.child.try_wait().unwrap() {
                self.read();
                assert_eq!(status.code(), Some(expected), "{}", self.output);
                assert_eq!(
                    terminal_flags(&self.slave),
                    self.flags,
                    "Terminal flags must be restored"
                );
                assert!(
                    !self.output.contains(KEY),
                    "Secret appeared on the terminal"
                );
                return;
            }
            assert!(
                Instant::now() < deadline,
                "Setup did not exit: {}",
                self.output
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn terminal_flags(file: &File) -> libc::tcflag_t {
    // tcgetattr initializes the settings for a live fixture terminal.
    unsafe {
        let mut settings = std::mem::zeroed();
        assert_eq!(libc::tcgetattr(file.as_raw_fd(), &mut settings), 0);
        settings.c_lflag
    }
}

#[test]
fn first_setup_is_explicit_cancellable_and_usable_without_credentials() {
    let fixture = Fixture::new();
    let mut cancelled = Terminal::spawn(fixture.command(&["setup"]));
    cancelled.until("Provider number (q cancels): ");
    cancelled.send("q\n");
    cancelled.finish(130);
    assert!(!fixture.path.exists());
    let instance = fixture
        .client()
        .request("system.hello", json!({"api_version":1}))
        .unwrap()["instance_id"]
        .clone();
    let mut setup = Terminal::spawn(fixture.command(&["setup"]));
    setup.until("Provider number (q cancels): ");
    setup.send("invalid\n");
    setup.until("Enter a number from the list, or q.");
    setup.choose("Provider", "faux");
    setup.choose("Model", "test");
    setup.finish(0);
    assert_eq!(
        fs::metadata(&fixture.path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(fixture.path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    let mut client = fixture.client();
    assert_ne!(
        client
            .request("system.hello", json!({"api_version":1}))
            .unwrap()["instance_id"],
        instance
    );
    let status = client.request("configuration.get", json!({})).unwrap();
    assert_eq!(status["provider"], "faux");
    assert_eq!(status["ready"], true);
    client
        .request(
            "session.create",
            json!({"session_id":"demo","workspace":fixture.root}),
        )
        .unwrap();
    client
        .request(
            "input.submit",
            json!({"session_id":"demo","request_id":"first","text":"Hello","context":[]}),
        )
        .unwrap();
    let result = client
        .request(
            "submission.wait",
            json!({"session_id":"demo","request_id":"first","timeout_ms":5000}),
        )
        .unwrap();
    assert_eq!(result["status"], "done");
}

#[test]
fn setup_preserves_raw_fields_and_rejects_concurrent_or_changed_files() {
    let fixture = Fixture::new();
    let original = fixture.write(&json!({"provider":"anthropic","model":"old", "instructions":"Keep \u{3bb} unchanged", "worker_path":"../../worker.mjs", "node_path":"../../node", "state_dir":"../../data", "socket_path":"../../socket"}));
    let parent = fixture.path.parent().unwrap();
    fs::set_permissions(parent, fs::Permissions::from_mode(0o755)).unwrap();
    let config = fixture.config();
    let expected = Some(original.clone());
    let staged = config.stage_setup("faux", "test", &expected).unwrap();
    assert_eq!(fs::read(&fixture.path).unwrap(), original);
    assert!(config.stage_setup("faux", "test", &expected).is_err());
    let lock_path = parent.join(".config.json.setup.lock");
    let descriptor = fs::read_dir("/proc/self/fd")
        .unwrap()
        .filter_map(Result::ok)
        .find(|entry| fs::read_link(entry.path()).is_ok_and(|path| path == lock_path))
        .unwrap()
        .file_name()
        .to_str()
        .unwrap()
        .parse::<i32>()
        .unwrap();
    // A fork before exec holds the same open-file description after the staging owner drops it.
    let inherited = unsafe { libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, 0) };
    assert!(inherited >= 0);
    // This descriptor is a new owned copy; retain it through the next setup attempt.
    let inherited = unsafe { File::from_raw_fd(inherited) };
    staged.commit().unwrap();
    let saved: Value = serde_json::from_slice(&fs::read(&fixture.path).unwrap()).unwrap();
    let mut wanted: Value = serde_json::from_slice(&original).unwrap();
    wanted["provider"] = json!("faux");
    wanted["model"] = json!("test");
    assert_eq!(saved, wanted);
    assert_eq!(
        fs::metadata(parent).unwrap().permissions().mode() & 0o777,
        0o755
    );
    drop(staged);
    let saved = config.setup_bytes().unwrap();
    let staged = config.stage_setup("anthropic", "new", &saved).unwrap();
    drop(inherited);
    fs::write(&fixture.path, b"{\"instructions\":\"User edit\"}").unwrap();
    assert!(staged.commit().is_err());
    drop(staged);
    assert_eq!(
        fs::read(&fixture.path).unwrap(),
        b"{\"instructions\":\"User edit\"}"
    );
    assert!(config.stage_setup("faux", "test", &saved).is_err());
    assert!(!fs::read_dir(parent).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".harness-setup-")
    }));
}

#[test]
fn unsafe_or_invalid_configuration_is_never_replaced() {
    for content in ["not json", "{\"unexpected\":true}"] {
        let fixture = Fixture::new();
        fixture.write(&json!({}));
        fs::write(&fixture.path, content).unwrap();
        let output = fixture.command(&["setup"]).output().unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert_eq!(fs::read_to_string(&fixture.path).unwrap(), content);
        assert!(!fixture.state.exists());
    }
    let fixture = Fixture::new();
    fixture.write(&json!({}));
    let target = fixture.root.join("original.json");
    fs::rename(&fixture.path, &target).unwrap();
    symlink(&target, &fixture.path).unwrap();
    assert!(
        Config::load_setup(
            Some(&fixture.path),
            Some(&fixture.state),
            Some(&fixture.socket)
        )
        .is_err()
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), "{}");
    fs::remove_file(&fixture.path).unwrap();
    fs::create_dir(&fixture.path).unwrap();
    assert!(
        Config::load_setup(
            Some(&fixture.path),
            Some(&fixture.state),
            Some(&fixture.socket)
        )
        .is_err()
    );
}

#[test]
fn secret_input_stays_hidden_and_sigint_restores_echo() {
    let fixture = Fixture::new();
    let mut setup =
        Terminal::spawn(fixture.command(&["auth", "--provider", "openai", "--method", "api_key"]));
    setup.until("Enter OpenAI API key");
    assert_eq!(terminal_flags(&setup.slave) & libc::ECHO, 0);
    setup.send(KEY);
    // Interrupt only this live fixture client; the worker must cancel its terminal read.
    unsafe { libc::kill(setup.child.id() as i32, libc::SIGINT) };
    setup.finish(130);
    assert!(!fixture.path.exists());
    let mut retry =
        Terminal::spawn(fixture.command(&["auth", "--provider", "openai", "--method", "api_key"]));
    retry.until("Enter OpenAI API key");
    retry.send("\u{3}");
    retry.finish(130);
}

#[test]
fn saved_keys_remain_private_and_are_reused_after_restart() {
    let fixture = Fixture::new();
    let mut setup = Terminal::spawn(fixture.command(&["setup"]));
    setup.choose("Provider", "anthropic");
    setup.choose("Model", "claude-sonnet-4-6");
    setup.choose("Login method", "api_key");
    setup.until("Enter Anthropic API key");
    assert_eq!(terminal_flags(&setup.slave) & libc::ECHO, 0);
    setup.send(&format!("{KEY}\n"));
    setup.finish(0);
    assert!(!fs::read_to_string(&fixture.path).unwrap().contains(KEY));
    let mut client = fixture.client();
    let status = client.request("configuration.get", json!({})).unwrap();
    assert_eq!(status["ready"], true);
    assert!(!status.to_string().contains(KEY));
    let metadata = client
        .request(
            "session.create",
            json!({"session_id":"hosted","workspace":fixture.root}),
        )
        .unwrap();
    assert!(!metadata.to_string().contains(KEY));
    let pid = fixture.peer().unwrap();
    for name in ["environ", "cmdline"] {
        assert!(
            !fs::read(format!("/proc/{pid}/{name}"))
                .unwrap()
                .windows(KEY.len())
                .any(|value| value == KEY.as_bytes())
        );
    }
    for file in fs::read_dir(fixture.state.join("logs")).unwrap() {
        assert!(
            !fs::read_to_string(file.unwrap().path())
                .unwrap()
                .contains(KEY)
        );
    }
    client.request("server.shutdown", json!({})).unwrap();
    drop(client);
    assert!(
        fixture.wait_for_socket_removal(),
        "Server shutdown timed out"
    );
    let output = fixture.command(&["start"]).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut client = fixture.client();
    assert_eq!(
        client.request("configuration.get", json!({})).unwrap()["ready"],
        true
    );
    assert!(
        client
            .request("transcript.list", json!({"session_id":"hosted"}))
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let restarted = fixture.peer();
    let mut again = Terminal::spawn(fixture.command(&["setup"]));
    again.choose("Provider", "anthropic");
    again.choose("Model", "claude-sonnet-4-6");
    again.finish(0);
    assert_eq!(fixture.peer(), restarted);
}

#[test]
fn whitespace_keys_fail_before_settings_or_server_change() {
    let fixture = Fixture::new();
    let mut setup =
        Terminal::spawn(fixture.command(&["auth", "--provider", "openai", "--method", "api_key"]));
    setup.until("Enter OpenAI API key");
    let pid = fixture.peer();
    setup.send("   \n");
    setup.finish(2);
    assert!(!fixture.path.exists());
    assert_eq!(fixture.peer(), pid);
    let status = fixture
        .client()
        .request("configuration.get", json!({}))
        .unwrap();
    let provider = status["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "openai")
        .unwrap();
    assert_eq!(provider["authenticated"], false);
}

#[test]
fn failed_staging_write_keeps_configuration_and_server() {
    let fixture = Fixture::new();
    let original = fixture.write(&json!({"provider":"faux", "model":"test"}));
    let mut command = fixture.command(&["setup"]);
    // Ignoring SIGXFSZ makes the injected write limit report an ordinary filesystem error.
    unsafe {
        command.pre_exec(|| {
            libc::signal(libc::SIGXFSZ, libc::SIG_IGN);
            Ok(())
        });
    }
    let mut setup = Terminal::spawn(command);
    setup.choose("Provider", "anthropic");
    setup.until("Model number (q cancels): ");
    let pid = fixture.peer();
    let limit = libc::rlimit {
        rlim_cur: 1,
        rlim_max: 1,
    };
    // Change only this fixture's setup child after its independent server has started.
    unsafe {
        assert_eq!(
            libc::prlimit(
                setup.child.id() as i32,
                libc::RLIMIT_FSIZE,
                &limit,
                std::ptr::null_mut()
            ),
            0
        );
    }
    setup.choose("Model", "claude-sonnet-4-6");
    setup.finish(3);
    assert!(!setup.output.contains("Enter Anthropic API key"));
    assert_eq!(fs::read(&fixture.path).unwrap(), original);
    assert_eq!(fixture.peer(), pid);
    assert!(
        !fs::read_dir(fixture.path.parent().unwrap())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".harness-setup-"))
    );
}

#[test]
fn login_keeps_active_work_and_setup_or_upgrade_cannot_stop_it() {
    let fixture = Fixture::new();
    let original =
        fixture.write(&json!({"provider":"faux", "model":"test", "instructions":"Preserve me"}));
    let output = fixture
        .command(&["start"])
        .env("HARNESS_FAUX_TOKENS_PER_SECOND", "1")
        .output()
        .unwrap();
    assert!(output.status.success());
    let pid = fixture.peer().unwrap();
    let mut client = fixture.client();
    client
        .request(
            "session.create",
            json!({"session_id":"running","workspace":fixture.root}),
        )
        .unwrap();
    let receipt = client
        .request(
            "input.submit",
            json!({"session_id":"running","request_id":"task","text":"Continue","context":[]}),
        )
        .unwrap();
    let mut auth =
        Terminal::spawn(fixture.command(&["auth", "--provider", "openai", "--method", "api_key"]));
    auth.until("Enter OpenAI API key");
    auth.send(&format!("{KEY}\n"));
    auth.finish(0);
    let mut setup = Terminal::spawn(fixture.command(&["setup"]));
    setup.choose("Provider", "openai");
    setup.choose("Model", "gpt-5.4");
    setup.finish(6);
    assert!(setup.output.contains("Active work prevents shutdown"));
    assert_eq!(fs::read(&fixture.path).unwrap(), original);
    assert_eq!(fixture.peer(), Some(pid));
    assert_eq!(
        client
            .request("session.get", json!({"session_id":"running"}))
            .unwrap()["snapshot"]["active_submission_id"],
        receipt["submission_id"]
    );
    let upgrade = fixture.command(&["upgrade"]).output().unwrap();
    assert_eq!(upgrade.status.code(), Some(6));
    assert!(
        String::from_utf8(upgrade.stderr)
            .unwrap()
            .contains("Active work prevents shutdown")
    );
    assert_eq!(fs::read(&fixture.path).unwrap(), original);
    assert_eq!(fixture.peer(), Some(pid));
    assert_eq!(
        client
            .request("session.get", json!({"session_id":"running"}))
            .unwrap()["snapshot"]["active_submission_id"],
        receipt["submission_id"]
    );
    client
        .request(
            "run.stop",
            json!({"session_id":"running","submission_id":receipt["submission_id"]}),
        )
        .unwrap();
}

#[test]
fn direct_login_has_no_model_prompt_and_cancellation_keeps_the_server() {
    let fixture = Fixture::new();
    for answer in ["\n", "\u{1b}", "\u{3}"] {
        let mut auth = Terminal::spawn(fixture.command(&[
            "auth",
            "--provider",
            "openai",
            "--method",
            "api_key",
        ]));
        auth.until("Enter OpenAI API key");
        assert_eq!(terminal_flags(&auth.slave) & libc::ECHO, 0);
        let pid = fixture.peer();
        auth.send(answer);
        auth.finish(130);
        assert_eq!(fixture.peer(), pid);
        assert!(!fixture.path.exists());
        assert!(!auth.output.contains("Provider number"));
        assert!(!auth.output.contains("Model number"));
    }
}

#[test]
fn login_merges_providers_without_restart_or_configuration_write() {
    for existing_config in [false, true] {
        let fixture = Fixture::new();
        let original = existing_config.then(|| {
            fixture.write(
                &json!({"provider":"faux","model":"test","instructions":"Keep defaults unchanged"}),
            )
        });
        let mut old_pid = None;
        for (provider, label) in [("anthropic", "Anthropic"), ("openai", "OpenAI")] {
            let mut auth = Terminal::spawn(fixture.command(&[
                "auth",
                "--provider",
                provider,
                "--method",
                "api_key",
            ]));
            auth.until(&format!("Enter {label} API key"));
            assert_eq!(terminal_flags(&auth.slave) & libc::ECHO, 0);
            let pid = fixture.peer();
            if let Some(previous) = old_pid {
                assert_eq!(pid, previous);
            }
            old_pid = Some(pid);
            auth.send(&format!("{KEY}\n"));
            auth.finish(0);
            assert_eq!(fixture.peer(), pid);
            assert_eq!(fs::read(&fixture.path).ok(), original);
            for name in ["environ", "cmdline"] {
                assert!(
                    !fs::read(format!("/proc/{}/{name}", pid.unwrap()))
                        .unwrap()
                        .windows(KEY.len())
                        .any(|bytes| bytes == KEY.as_bytes())
                );
            }
        }
        let mut client = fixture.client();
        let status = client.request("configuration.get", json!({})).unwrap();
        assert_eq!(
            status["provider"],
            if existing_config {
                json!("faux")
            } else {
                Value::Null
            }
        );
        assert!(!status.to_string().contains(KEY));
        for provider in ["anthropic", "openai"] {
            assert_eq!(
                status["providers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|item| item["id"] == provider)
                    .unwrap()["authenticated"],
                true
            );
        }
        for file in fs::read_dir(fixture.state.join("logs")).unwrap() {
            assert!(
                !fs::read_to_string(file.unwrap().path())
                    .unwrap()
                    .contains(KEY)
            );
        }
        let result = client
            .request("auth.logout", json!({"provider":"openai"}))
            .unwrap();
        assert_eq!(result["authenticated"], false);
        let status = client.request("configuration.get", json!({})).unwrap();
        assert_eq!(
            status["providers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == "anthropic")
                .unwrap()["authenticated"],
            true
        );
    }
}

#[test]
fn chat_configuration_and_parent_links_survive_restart_without_stopping_other_work() {
    let fixture = Fixture::new();
    let output = fixture
        .command(&["start"])
        .env("HARNESS_FAUX_TOKENS_PER_SECOND", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let pid = fixture.peer();
    let workspace = fixture.root.to_str().unwrap();
    for id in ["parent", "other"] {
        let output = fixture
            .command(&["session", "create", "--id", id, "--workspace", workspace])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let metadata: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(metadata["provider"], Value::Null);
    }
    for id in ["parent", "other"] {
        let output = fixture
            .command(&[
                "session",
                "configure",
                "--session",
                id,
                "--provider",
                "faux",
                "--model",
                "test",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let mut client = fixture.client();
    let receipt = client
        .request(
            "input.submit",
            json!({"session_id":"other","request_id":"active","text":"Continue","context":[]}),
        )
        .unwrap();
    let output = fixture
        .command(&[
            "session",
            "configure",
            "--session",
            "parent",
            "--name",
            "Review \u{3bb}",
            "--instructions",
            "Keep my changes",
            "--provider",
            "faux",
            "--model",
            "test",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let parent: Value = serde_json::from_slice(&output.stdout).unwrap();
    let output = fixture
        .command(&[
            "session",
            "create",
            "--id",
            "child",
            "--workspace",
            workspace,
            "--name",
            "Child \u{3bb}",
        ])
        .env("HARNESS_SESSION_ID", "parent")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let child: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(child["parent_session_id"], "parent");
    assert_eq!(child["instructions"], "Keep my changes");
    assert_eq!(child["provider"], "faux");
    assert_eq!(fixture.peer(), pid);
    assert!(!fixture.path.exists());
    assert_eq!(
        client
            .request("session.get", json!({"session_id":"other"}))
            .unwrap()["snapshot"]["active_submission_id"],
        receipt["submission_id"]
    );
    let invalid = fixture
        .command(&[
            "session",
            "configure",
            "--session",
            "parent",
            "--provider",
            "faux",
            "--model",
            "absent",
        ])
        .output()
        .unwrap();
    assert!(!invalid.status.success());
    assert_eq!(
        client
            .request("session.get", json!({"session_id":"parent"}))
            .unwrap()["session"],
        parent
    );
    client
        .request(
            "run.stop",
            json!({"session_id":"other","submission_id":receipt["submission_id"]}),
        )
        .unwrap();
    client.request("server.shutdown", json!({})).unwrap();
    drop(client);
    assert!(
        fixture.wait_for_socket_removal(),
        "Server shutdown timed out"
    );
    let output = fixture.command(&["start"]).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut client = fixture.client();
    assert_eq!(
        client
            .request("session.get", json!({"session_id":"parent"}))
            .unwrap()["session"],
        parent
    );
    assert_eq!(
        client
            .request("session.get", json!({"session_id":"child"}))
            .unwrap()["session"],
        child
    );
}
