use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use crate::{process, protocol::RpcError, ssh};

const MAX_LINE: usize = 12 * 1024;
const INTERVAL: Duration = Duration::from_millis(100);

/// Private browser request carried through the SSH connection, never through agent RPC.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: u64,
    url: String,
    callback: Option<Callback>,
}

#[derive(Clone, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Callback {
    pub(crate) host: String,
    pub(crate) port: u16,
}

#[derive(Serialize)]
struct Reply {
    id: u64,
    error: Option<String>,
}

impl Request {
    fn validate(&self) -> Result<(), &'static str> {
        let authority = self
            .url
            .strip_prefix("https://")
            .or_else(|| self.url.strip_prefix("http://"))
            .and_then(|rest| rest.split(['/', '?', '#']).next());
        if self.url.len() > 8192
            || self
                .url
                .chars()
                .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
            || authority.is_none_or(|host| host.is_empty() || host.contains('@'))
        {
            return Err("The browser request is not a valid web address");
        }
        if self.callback.as_ref().is_some_and(|callback| {
            callback.port == 0
                || !matches!(callback.host.as_str(), "127.0.0.1" | "::1" | "localhost")
        }) {
            return Err("The browser callback must use a loopback address");
        }
        Ok(())
    }
}

fn reply(stream: &mut UnixStream, id: u64, error: Option<&str>) -> io::Result<()> {
    serde_json::to_writer(
        &mut *stream,
        &Reply {
            id,
            error: error.map(str::to_owned),
        },
    )?;
    stream.write_all(b"\n")
}

// A desktop opener may remain alive until its browser closes. Reap completed
// children without waiting for browser windows or killing them on SSH exit.
fn reap(children: &mut Vec<(u64, u64, Child)>) -> Vec<(u64, u64)> {
    let mut failed = Vec::new();
    children.retain_mut(|(login, id, child)| match child.try_wait() {
        Ok(Some(status)) => {
            if !status.success() {
                failed.push((*login, *id));
            }
            false
        }
        Ok(None) => true,
        Err(_) => {
            failed.push((*login, *id));
            false
        }
    });
    failed
}

fn open(
    request: &Request,
    connection: &ssh::Connection,
    callback: &mut Option<(Callback, ssh::Forward)>,
    children: &mut Vec<(u64, u64, Child)>,
    login: u64,
) -> Result<(), String> {
    request.validate().map_err(str::to_owned)?;
    if children.len() >= 16 {
        return Err("Too many browser launch commands are still active".into());
    }
    if callback.as_ref().map(|(value, _)| value) != request.callback.as_ref() {
        *callback = None;
        if let Some(value) = &request.callback {
            let forward = connection.forward(value).map_err(|error| error.message)?;
            *callback = Some((value.clone(), forward));
        }
    }
    let mut command = Command::new("xdg-open");
    command
        .arg(&request.url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    process::detach(&mut command);
    let child = command.spawn().map_err(
        |_| "Cannot start the local browser. Install xdg-open and set a default browser.",
    )?;
    children.push((login, request.id, child));
    Ok(())
}

fn login(
    mut stream: UnixStream,
    connection: &ssh::Connection,
    stop: &AtomicBool,
    children: &mut Vec<(u64, u64, Child)>,
    number: u64,
) -> io::Result<()> {
    stream.set_read_timeout(Some(INTERVAL))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let mut callback = None;
    let mut pending = Vec::new();
    let mut bytes = [0; 4096];
    while !stop.load(Ordering::Relaxed) && !process::interrupted() {
        for (owner, id) in reap(children) {
            if owner == number {
                reply(
                    &mut stream,
                    id,
                    Some(
                        "The local browser could not open. Check the default browser, then retry.",
                    ),
                )?;
            }
        }
        let count = match stream.read(&mut bytes) {
            Ok(0) => return Ok(()),
            Ok(count) => count,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) =>
            {
                continue;
            }
            Err(error) => return Err(error),
        };
        for byte in &bytes[..count] {
            pending.push(*byte);
            if pending.len() > MAX_LINE {
                return Err(io::Error::other("Browser request exceeds 12 KiB"));
            }
            if *byte == b'\n' {
                let request: Request = serde_json::from_slice(&pending)
                    .map_err(|_| io::Error::other("Invalid browser request"))?;
                let result = open(&request, connection, &mut callback, children, number);
                reply(&mut stream, request.id, result.err().as_deref())?;
                pending.clear();
            }
        }
    }
    Ok(())
}

pub(crate) fn serve(
    listener: UnixListener,
    connection: ssh::Connection,
    stop: Arc<AtomicBool>,
) -> io::Result<()> {
    listener.set_nonblocking(true)?;
    let mut number = 0;
    let mut children = Vec::new();
    while !stop.load(Ordering::Relaxed) && !process::interrupted() {
        reap(&mut children);
        match listener.accept() {
            Ok((stream, _)) => {
                number += 1;
                // A closed or malformed private request ends only that login.
                let _ = login(stream, &connection, &stop, &mut children, number);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(INTERVAL),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

pub(crate) fn connect() -> Result<i32, RpcError> {
    let path = std::env::var_os("HARNESS_BROWSER_SOCKET").ok_or_else(|| {
        RpcError::invalid("Start harness ssh on the computer that runs your browser")
    })?;
    let path = Path::new(&path);
    let parent = path
        .parent()
        .ok_or_else(|| RpcError::invalid("Invalid browser socket"))?;
    let directory = process::owned(parent)?;
    let socket = process::owned(path)?;
    if !directory.is_dir()
        || directory.permissions().mode() & 0o077 != 0
        || !socket.file_type().is_socket()
        || socket.permissions().mode() & 0o077 != 0
    {
        return Err(RpcError::invalid("The browser connection is not private"));
    }
    let mut stream = UnixStream::connect(path)?;
    stream.set_read_timeout(Some(INTERVAL))?;
    let mut input = stream.try_clone()?;
    input.set_write_timeout(Some(Duration::from_secs(2)))?;
    thread::spawn(move || {
        let mut reader = io::stdin().lock();
        let mut line = Vec::new();
        loop {
            line.clear();
            match (&mut reader)
                .take((MAX_LINE + 1) as u64)
                .read_until(b'\n', &mut line)
            {
                Ok(0) => break,
                Ok(_) if line.len() <= MAX_LINE && line.last() == Some(&b'\n') => {
                    if input.write_all(&line).is_err() {
                        break;
                    }
                }
                _ => break,
            }
        }
        let _ = input.shutdown(Shutdown::Write);
    });
    let mut output = io::stdout().lock();
    let mut bytes = [0; 4096];
    while !process::interrupted() {
        match stream.read(&mut bytes) {
            Ok(0) => return Ok(0),
            Ok(count) => {
                output.write_all(&bytes[..count])?;
                output.flush()?;
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) => {}
            Err(_) => {
                return Err(RpcError::app(
                    "not_ready",
                    "The SSH browser connection closed",
                ));
            }
        }
    }
    Ok(130)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_requests_reject_non_web_targets_and_non_loopback_callbacks() {
        for url in [
            "file:///tmp/login",
            "javascript:alert(1)",
            "https://",
            "https://u:p@host",
            "https://host\nspoof",
            "https://host\\path",
        ] {
            assert!(
                Request {
                    id: 1,
                    url: url.into(),
                    callback: None
                }
                .validate()
                .is_err()
            );
        }
        for host in [
            "0.0.0.0",
            "192.0.2.1",
            "example.org",
            "localhost.example.org",
        ] {
            assert!(
                Request {
                    id: 1,
                    url: "https://auth.example.test".into(),
                    callback: Some(Callback {
                        host: host.into(),
                        port: 1455
                    })
                }
                .validate()
                .is_err()
            );
        }
        for host in ["127.0.0.1", "::1", "localhost"] {
            assert!(
                Request {
                    id: 1,
                    url: "https://auth.example.test/?state=abc%2F123".into(),
                    callback: Some(Callback {
                        host: host.into(),
                        port: 1455
                    })
                }
                .validate()
                .is_ok()
            );
        }
    }
}
