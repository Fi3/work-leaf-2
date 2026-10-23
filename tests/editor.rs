use serde_json::Value;
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "harness-editor-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_harness"));
        command
            .arg("nvim")
            .current_dir(&self.0)
            .env("PATH", &self.0)
            .env("XDG_CONFIG_HOME", &self.0)
            .env("XDG_STATE_HOME", &self.0)
            .env_remove("XDG_RUNTIME_DIR");
        command
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn editor_keeps_process_terminal_streams_and_exit_status() {
    let fixture = Fixture::new();
    let editor = fixture.0.join("nvim");
    fs::write(
        &editor,
        "#!/bin/sh\nprintf '%s\\n' \"$$\" \"$PWD\" \"$HARNESS_NVIM_OPTIONS\"\nIFS= read -r input\nprintf '%s' \"$input\"\nexit 23\n",
    )
    .unwrap();
    fs::set_permissions(editor, fs::Permissions::from_mode(0o700)).unwrap();
    let config_name = "launch ' \u{3bb}\n.json";
    let config = fixture.0.join(config_name);
    fs::write(&config, "{}").unwrap();
    let mut child = fixture
        .command()
        .args(["--config", config_name])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let pid = child.id();
    child
        .stdin
        .take()
        .unwrap()
        .write_all("Input \u{3bb} \u{4e16}\u{754c}\n".as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(23));
    assert!(output.stderr.is_empty());
    let text = String::from_utf8(output.stdout).unwrap();
    let mut lines = text.lines();
    assert_eq!(lines.next().unwrap(), pid.to_string());
    assert_eq!(lines.next().unwrap(), fixture.0.to_str().unwrap());
    let options: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
    assert_eq!(options["config_path"], config.to_str().unwrap());
    assert_eq!(
        options["executable"],
        fs::canonicalize(env!("CARGO_BIN_EXE_harness"))
            .unwrap()
            .to_str()
            .unwrap()
    );
    assert_eq!(lines.next().unwrap(), "Input \u{3bb} \u{4e16}\u{754c}");
    assert!(!fixture.0.join("harness/owner.lock").exists());
}

#[test]
fn missing_editor_has_a_remedy_and_starts_no_server() {
    let fixture = Fixture::new();
    let output = fixture.command().output().unwrap();
    assert_eq!(output.status.code(), Some(3));
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("Install nvim")
    );
    assert!(!fixture.0.join("harness").exists());
}

#[test]
fn editor_rejects_a_state_override_that_the_plugin_cannot_retain() {
    let fixture = Fixture::new();
    let output = fixture
        .command()
        .args(["--state-dir", "state"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("--config")
    );
    assert!(!fixture.0.join("harness").exists());
}
