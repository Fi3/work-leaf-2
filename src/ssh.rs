use crate::browser::{self, Callback};
use crate::process;
use crate::protocol::RpcError;
use std::fs;
use std::io::{self, IsTerminal, Read};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone)]
pub(crate) struct Connection {
    host: String,
    control: PathBuf,
}

pub(crate) struct Forward {
    connection: Connection,
    bindings: Vec<String>,
}

struct Session {
    connection: Connection,
    directory: PathBuf,
    remote: Option<String>,
    master: Option<Child>,
}

impl Connection {
    fn command(&self) -> Command {
        let mut command = Command::new("ssh");
        command
            .args(["-F", "/dev/null"])
            .arg("-S")
            .arg(&self.control)
            .args(["-o", "ControlMaster=no", "-o", "ProxyCommand=false"]);
        command
    }

    fn control(&self, operation: &str, arguments: &[&str]) -> Result<Vec<u8>, RpcError> {
        capture(
            self.command()
                .args(["-O", operation])
                .args(arguments)
                .arg(&self.host),
        )
    }

    fn remote(&self, script: &str) -> Result<Vec<u8>, RpcError> {
        capture(self.command().args(["-T", &self.host, script]))
    }

    pub(crate) fn forward(&self, callback: &Callback) -> Result<Forward, RpcError> {
        let bindings = bindings(callback)?;
        let mut forward = Forward {
            connection: self.clone(),
            bindings: Vec::new(),
        };
        for binding in bindings {
            self.control("forward", &["-L", &binding]).map_err(|_| {
                RpcError::app(
                    "not_ready",
                    format!(
                        "Cannot forward login callback port {}. The local port may be busy, or SSH forwarding is disabled",
                        callback.port
                    ),
                )
            })?;
            forward.bindings.push(binding);
        }
        let target = format!(
            "{}:{}",
            if callback.host == "::1" {
                "[::1]"
            } else {
                "127.0.0.1"
            },
            callback.port
        );
        // A local forward alone does not check the server's TCP policy. An empty
        // stdio connection checks it without sending an HTTP request to Pi.
        capture(self.command().args(["-W", &target, &self.host])).map_err(|_| {
            RpcError::app(
                "not_ready",
                format!(
                    "SSH cannot reach login callback port {}. Check the server's forwarding permissions",
                    callback.port
                ),
            )
        })?;
        Ok(forward)
    }
}

impl Drop for Forward {
    fn drop(&mut self) {
        for binding in self.bindings.iter().rev() {
            let _ = self.connection.control("cancel", &["-L", binding]);
        }
    }
}

impl Session {
    fn open(host: &str) -> Result<Self, RpcError> {
        let directory = std::env::temp_dir().join(format!("harness-ssh-{}", process::random_id()?));
        // OpenSSH first binds control.<16 random bytes>. Linux permits 107
        // pathname bytes before the terminating NUL in a Unix socket address.
        if directory.as_os_str().as_encoded_bytes().len() + "/control.".len() + 16 > 107 {
            return Err(RpcError::invalid(
                "Set TMPDIR to a shorter path for SSH sockets",
            ));
        }
        fs::DirBuilder::new().mode(0o700).create(&directory)?;
        let mut session = Self {
            connection: Connection {
                host: host.into(),
                control: directory.join("control"),
            },
            directory,
            remote: None,
            master: None,
        };
        let mut command = Command::new("ssh");
        command
            .args(["-M", "-N", "-n", "-S"])
            .arg(&session.connection.control)
            .args([
                "-o",
                "ControlPersist=no",
                "-o",
                "ClearAllForwardings=yes",
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "StreamLocalBindUnlink=no",
                "-o",
                "StreamLocalBindMask=0177",
                "-o",
                "ConnectTimeout=10",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                host,
            ]);
        process::parent_lifetime(&mut command);
        session.master = Some(command.spawn()?);
        loop {
            if session.master.as_mut().unwrap().try_wait()?.is_some() || process::interrupted() {
                return Err(RpcError::app(
                    "not_ready",
                    "Cannot start the SSH connection",
                ));
            }
            if session.connection.control.exists()
                && session.connection.control("check", &[]).is_ok()
            {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let output = session
            .connection
            .remote("mktemp -d /tmp/harness-ssh.XXXXXXXXXX")?;
        let remote = String::from_utf8(output)
            .ok()
            .and_then(|text| {
                let path = text.trim();
                path.strip_prefix("/tmp/harness-ssh.")
                    .filter(|suffix| {
                        suffix.len() == 10
                            && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
                    })
                    .map(|_| path.to_owned())
            })
            .ok_or_else(|| RpcError::app("not_ready", "Cannot create the private SSH directory"))?;
        session.remote = Some(remote);
        Ok(session)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(remote) = &self.remote {
            let _ = self.connection.remote(&cleanup(remote));
        }
        let _ = self.connection.control("exit", &[]);
        if let Some(master) = &mut self.master {
            let _ = master.kill();
            let _ = master.wait();
        }
        let _ = fs::remove_file(self.directory.join("browser.sock"));
        let _ = fs::remove_file(&self.connection.control);
        let _ = fs::remove_dir(&self.directory);
    }
}

pub(crate) fn run(host: &str, workspace: &str, remote_command: &str) -> Result<i32, RpcError> {
    validate(host, workspace, remote_command)?;
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(RpcError::invalid("The SSH editor requires a terminal"));
    }
    let _terminal = process::TerminalSession::open()?;
    let session = Session::open(host)?;
    let local_socket = session.directory.join("browser.sock");
    let listener = UnixListener::bind(&local_socket)?;
    fs::set_permissions(&local_socket, fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    let remote_socket = format!("{}/browser.sock", session.remote.as_ref().unwrap());
    let reverse = format!("{remote_socket}:{}", local_socket.display());
    session.connection.control("forward", &["-R", &reverse])?;
    session.connection.remote(&format!(
        "test -S {} && chmod 600 -- {}",
        quote(&remote_socket),
        quote(&remote_socket)
    ))?;
    let connection = session.connection.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let browser = thread::spawn(move || browser::serve(listener, connection, stopped));
    let script = format!(
        "trap {} EXIT; trap 'exit 129' HUP; trap 'exit 143' TERM; cd -- {} && env HARNESS_BROWSER_SOCKET={} {} nvim",
        quote(&cleanup(session.remote.as_ref().unwrap())),
        quote(workspace),
        quote(&remote_socket),
        quote(remote_command)
    );
    let command = format!("sh -c {}", quote(&script));
    let outcome = interactive(session.connection.command().args(["-tt", host, &command]));
    stop.store(true, Ordering::Relaxed);
    browser
        .join()
        .map_err(|_| RpcError::app("internal_error", "The browser connection failed"))??;
    Ok(outcome?.code().unwrap_or(130))
}

fn bindings(callback: &Callback) -> Result<Vec<String>, RpcError> {
    if callback.port == 0 {
        return Err(RpcError::invalid("Invalid login callback port"));
    }
    let port = callback.port;
    match callback.host.as_str() {
        "127.0.0.1" => Ok(vec![format!("127.0.0.1:{port}:127.0.0.1:{port}")]),
        "::1" => Ok(vec![format!("[::1]:{port}:[::1]:{port}")]),
        "localhost" => Ok(vec![
            format!("127.0.0.1:{port}:127.0.0.1:{port}"),
            format!("[::1]:{port}:127.0.0.1:{port}"),
        ]),
        _ => Err(RpcError::invalid("Login callback must use loopback")),
    }
}

fn validate(host: &str, workspace: &str, command: &str) -> Result<(), RpcError> {
    if host.starts_with('-')
        || host.chars().any(char::is_whitespace)
        || [host, workspace, command]
            .iter()
            .any(|value| value.is_empty() || value.chars().any(char::is_control))
    {
        return Err(RpcError::invalid(
            "Invalid SSH host, workspace, or remote command",
        ));
    }
    Ok(())
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn cleanup(remote: &str) -> String {
    format!(
        "rm -f -- {} && rmdir -- {}",
        quote(&format!("{remote}/browser.sock")),
        quote(remote)
    )
}

fn interactive(command: &mut Command) -> Result<ExitStatus, RpcError> {
    process::parent_lifetime(command);
    let mut child = command.spawn()?;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if process::interrupted() {
            let _ = child.kill();
            return Ok(child.wait()?);
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn capture(command: &mut Command) -> Result<Vec<u8>, RpcError> {
    process::parent_lifetime(command);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut output = child.stdout.take().unwrap();
    let result = (|| {
        process::nonblocking(output.as_raw_fd())?;
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut bytes = Vec::new();
        loop {
            let mut buffer = [0; 1024];
            match output.read(&mut buffer) {
                Ok(count) => bytes.extend_from_slice(&buffer[..count]),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.into()),
            }
            if bytes.len() > 4096 {
                return Err(RpcError::app("not_ready", "Unexpected SSH command output"));
            }
            if let Some(status) = child.try_wait()? {
                if !status.success() {
                    return Err(RpcError::app("not_ready", "The SSH command failed"));
                }
                output.take(4097).read_to_end(&mut bytes)?;
                if bytes.len() > 4096 {
                    return Err(RpcError::app("not_ready", "Unexpected SSH command output"));
                }
                return Ok(bytes);
            }
            if Instant::now() >= deadline {
                return Err(RpcError::app(
                    "not_ready",
                    "The SSH command did not complete",
                ));
            }
            thread::sleep(Duration::from_millis(20));
        }
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_arguments_preserve_shell_characters() {
        for value in ["directory with spaces", "a'b", "$(false); echo wrong", "é"] {
            let output = Command::new("sh")
                .args(["-c", &format!("printf %s {}", quote(value))])
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(String::from_utf8(output.stdout).unwrap(), value);
        }
        assert!(validate("-oProxyCommand=bad", "/tmp", "harness").is_err());
        assert!(validate("host\nother", "/tmp", "harness").is_err());
        assert!(validate("user@host", "/work directory", "/home/user/harness").is_ok());
    }

    #[test]
    fn callback_forwarding_requires_loopback_and_nonzero_port() {
        for (host, port) in [("0.0.0.0", 1455), ("example.test", 1455), ("127.0.0.1", 0)] {
            assert!(
                bindings(&Callback {
                    host: host.into(),
                    port
                })
                .is_err()
            );
        }
        assert_eq!(
            bindings(&Callback {
                host: "localhost".into(),
                port: 1455
            })
            .unwrap(),
            ["127.0.0.1:1455:127.0.0.1:1455", "[::1]:1455:127.0.0.1:1455"]
        );
    }
}
