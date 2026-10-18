use harness::{client::Client, config::Config};
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
        // This socket belongs to this fixture. SO_PEERCRED initializes the supplied credential value.
        unsafe {
            let mut credentials: libc::ucred = std::mem::zeroed();
            let mut size = std::mem::size_of_val(&credentials) as libc::socklen_t;
            assert_eq!(
                libc::getsockopt(
                    socket.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    (&mut credentials as *mut libc::ucred).cast(),
                    &mut size
                ),
                0
            );
            Some(credentials.pid)
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(pid) = self.peer() {
            // The peer came from this fixture's private socket, not from an unrelated PID lookup.
            unsafe { libc::kill(pid, libc::SIGTERM) };
            let deadline = Instant::now() + Duration::from_secs(6);
            while self.socket.exists() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(20));
            }
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
    cancelled.until("Provider [1/2/q]: ");
    cancelled.send("q\n");
    cancelled.finish(130);
    assert!(!fixture.path.exists());
    let instance = fixture
        .client()
        .request("system.hello", json!({"api_version":1}))
        .unwrap()["instance_id"]
        .clone();
    let mut setup = Terminal::spawn(fixture.command(&["setup"]));
    setup.until("Provider [1/2/q]: ");
    setup.send("invalid\n2\n");
    setup.finish(0);
    assert!(setup.output.contains("Enter 1, 2, or q."));
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
    let original = fixture.write(&json!({"provider":"anthropic","model":"old", "instructions":"Keep λ unchanged", "worker_path":"../../worker.mjs", "node_path":"../../node", "state_dir":"../../data", "socket_path":"../../socket"}));
    let parent = fixture.path.parent().unwrap();
    fs::set_permissions(parent, fs::Permissions::from_mode(0o755)).unwrap();
    let config = fixture.config();
    let expected = Some(original.clone());
    let staged = config.stage_setup("faux", "test", &expected).unwrap();
    assert_eq!(fs::read(&fixture.path).unwrap(), original);
    assert!(config.stage_setup("faux", "test", &expected).is_err());
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
    let mut setup = Terminal::spawn(fixture.command(&["setup"]));
    setup.until("Provider [1/2/q]: ");
    setup.send("1\n");
    setup.until("Model number (q cancels): ");
    setup.send("1\n");
    setup.until("API key (hidden; Enter cancels): ");
    assert_eq!(terminal_flags(&setup.slave) & libc::ECHO, 0);
    setup.send(KEY);
    // The setup process owns this terminal; interrupting it must restore the previous echo flags.
    unsafe { libc::kill(setup.child.id() as i32, libc::SIGINT) };
    setup.finish(130);
    assert!(!fixture.path.exists());
}

#[test]
fn a_key_is_given_only_to_the_server_environment_and_can_be_reused() {
    for inherited in [false, true] {
        let fixture = Fixture::new();
        let mut command = fixture.command(&["setup"]);
        command
            .env("ANTHROPIC_AUTH_TOKEN", "unused-auth-token")
            .env("ANTHROPIC_OAUTH_TOKEN", "unused-oauth-token");
        if inherited {
            command.env("ANTHROPIC_API_KEY", KEY);
        }
        let mut setup = Terminal::spawn(command);
        setup.until("Provider [1/2/q]: ");
        setup.send("1\n");
        setup.until("Model number (q cancels): ");
        setup.send("1\n");
        if inherited {
            setup.until("Use ANTHROPIC_API_KEY from this terminal? [Y/n/q]: ");
            setup.send("\n");
        } else {
            setup.until("API key (hidden; Enter cancels): ");
            assert_eq!(terminal_flags(&setup.slave) & libc::ECHO, 0);
            setup.send(&format!("{KEY}\n"));
        }
        setup.finish(0);
        assert!(!fs::read_to_string(&fixture.path).unwrap().contains(KEY));
        let pid = fixture.peer().unwrap();
        let environment = fs::read(format!("/proc/{pid}/environ")).unwrap();
        assert!(
            environment
                .split(|byte| *byte == 0)
                .any(|entry| entry == format!("ANTHROPIC_API_KEY={KEY}").as_bytes())
        );
        assert!(
            !environment
                .split(|byte| *byte == 0)
                .any(|entry| entry.starts_with(b"ANTHROPIC_AUTH_TOKEN=")
                    || entry.starts_with(b"ANTHROPIC_OAUTH_TOKEN="))
        );
        assert!(
            !fs::read(format!("/proc/{pid}/cmdline"))
                .unwrap()
                .windows(KEY.len())
                .any(|bytes| bytes == KEY.as_bytes())
        );
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
        for file in fs::read_dir(fixture.state.join("logs")).unwrap() {
            assert!(
                !fs::read_to_string(file.unwrap().path())
                    .unwrap()
                    .contains(KEY)
            );
        }
        let mut again = Terminal::spawn(fixture.command(&["setup"]));
        again.until("Provider [1/2/q]: ");
        again.send("1\n");
        again.until("Model number (q cancels): ");
        again.send("1\n");
        again.until("Keep the current server key? [Y/n/q]: ");
        again.send("\n");
        again.finish(0);
        assert_eq!(fixture.peer(), Some(pid));
    }
}

#[test]
fn whitespace_keys_fail_before_settings_or_server_change() {
    let fixture = Fixture::new();
    let mut command = fixture.command(&["setup"]);
    command.env("ANTHROPIC_API_KEY", "   ");
    let mut setup = Terminal::spawn(command);
    setup.until("Provider [1/2/q]: ");
    setup.send("1\n");
    setup.until("Model number (q cancels): ");
    setup.send("1\n");
    setup.until("API key (hidden; Enter cancels): ");
    assert!(
        !setup
            .output
            .contains("Use ANTHROPIC_API_KEY from this terminal?")
    );
    let pid = fixture.peer();
    setup.send("   \n");
    setup.finish(2);
    assert!(!fixture.path.exists());
    assert_eq!(fixture.peer(), pid);
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
    setup.until("Provider [1/2/q]: ");
    setup.send("1\n");
    setup.until("Model number (q cancels): ");
    setup.send("1\n");
    setup.until("API key (hidden; Enter cancels): ");
    let pid = fixture.peer();
    let limit = libc::rlimit {
        rlim_cur: 1,
        rlim_max: 1,
    };
    // Change only this test's setup child after its independent server has started.
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
    setup.send(&format!("{KEY}\n"));
    setup.finish(3);
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
fn active_work_rejects_setup_without_changing_file_or_instance() {
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
    let mut setup = Terminal::spawn(fixture.command(&["setup"]));
    setup.until("Provider [1/2/q]: ");
    setup.send("1\n");
    setup.until("Model number (q cancels): ");
    setup.send("1\n");
    setup.until("API key (hidden; Enter cancels): ");
    setup.send(&format!("{KEY}\n"));
    setup.finish(6);
    assert!(
        setup
            .output
            .contains("Settings were not changed and work was preserved")
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
