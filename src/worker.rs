use crate::{
    config::Config,
    process,
    protocol::{self, Framer, RpcError},
};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

pub struct Worker {
    child: Child,
    input: Option<ChildStdin>,
    output: ChildStdout,
    errors: Option<ChildStderr>,
    frames: Framer,
    queue: VecDeque<Vec<u8>>,
    offset: usize,
    queued: usize,
}

pub struct Update {
    pub records: Vec<Value>,
    pub exited: bool,
    pub diagnostics: bool,
}

impl Worker {
    pub fn spawn(config: &Config, lock: &File) -> Result<Self, RpcError> {
        let mut command = Command::new(&config.node_path);
        command
            .arg(&config.worker_path)
            .env("HARNESS_EXECUTABLE", std::env::current_exe()?)
            .env(
                "HARNESS_CONFIG",
                serde_json::to_string(config).map_err(|_| {
                    RpcError::app("internal_error", "Cannot encode worker configuration")
                })?,
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        process::inherit_lock(&mut command, lock);
        let mut child = command
            .spawn()
            .map_err(|e| RpcError::app("not_ready", format!("Cannot start Node worker: {e}")))?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| RpcError::app("internal_error", "Worker input missing"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| RpcError::app("internal_error", "Worker output missing"))?;
        let errors = child
            .stderr
            .take()
            .ok_or_else(|| RpcError::app("internal_error", "Worker diagnostic pipe missing"))?;
        for fd in [input.as_raw_fd(), output.as_raw_fd(), errors.as_raw_fd()] {
            process::nonblocking(fd)?;
        }
        let mut worker = Self {
            child,
            input: Some(input),
            output,
            errors: Some(errors),
            frames: Framer::default(),
            queue: VecDeque::new(),
            offset: 0,
            queued: 0,
        };
        worker.send(json!({"jsonrpc":"2.0","id":"_hello","method":"system.hello","params":{"api_version":1}}))?;
        Ok(worker)
    }

    pub fn send(&mut self, value: Value) -> Result<(), RpcError> {
        let frame = protocol::encode(&value)?;
        if self.queued + frame.len() > protocol::MAX_OUTPUT {
            return Err(RpcError::app(
                "resource_limit",
                "Worker input queue is full",
            ));
        }
        self.queued += frame.len();
        self.queue.push_back(frame);
        Ok(())
    }

    pub(crate) fn wait_fds(&self, readable: &mut Vec<RawFd>, writable: &mut Vec<RawFd>) {
        readable.push(self.output.as_raw_fd());
        if let Some(errors) = &self.errors {
            readable.push(errors.as_raw_fd());
        }
        if !self.queue.is_empty()
            && let Some(input) = &self.input
        {
            writable.push(input.as_raw_fd());
        }
    }

    fn flush(&mut self) -> Result<(), RpcError> {
        let Some(input) = self.input.as_mut() else {
            return Ok(());
        };
        while let Some(frame) = self.queue.front() {
            match input.write(&frame[self.offset..]) {
                Ok(0) => return Err(RpcError::app("not_ready", "Worker input closed")),
                Ok(n) => {
                    self.offset += n;
                    self.queued -= n;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.into()),
            }
            if self.offset == frame.len() {
                self.queue.pop_front();
                self.offset = 0;
            }
        }
        Ok(())
    }

    pub fn poll(&mut self) -> Result<Update, RpcError> {
        self.flush()?;
        let mut result = Update {
            records: Vec::new(),
            exited: false,
            diagnostics: false,
        };
        let mut bytes = [0; 65536];
        for _ in 0..4 {
            match self.output.read(&mut bytes) {
                Ok(0) => {
                    result.exited = true;
                    break;
                }
                Ok(n) => {
                    for record in self.frames.push(&bytes[..n])? {
                        let value: Value = serde_json::from_slice(&record).map_err(|_| {
                            RpcError::app("internal_error", "Invalid worker record")
                        })?;
                        if !value.is_object() {
                            return Err(RpcError::app("internal_error", "Invalid worker record"));
                        }
                        result.records.push(value);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.into()),
            }
        }
        for _ in 0..4 {
            let Some(errors) = &mut self.errors else {
                break;
            };
            match errors.read(&mut bytes) {
                Ok(0) => {
                    self.errors = None;
                    break;
                }
                Ok(_) => result.diagnostics = true,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    break;
                }
                Err(e) => return Err(e.into()),
            }
        }
        Ok(result)
    }

    pub fn close(&mut self) {
        let _ =
            self.send(json!({"jsonrpc":"2.0","id":"_close","method":"worker.close","params":{}}));
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if self.poll().is_err() {
                break;
            }
            if self.queue.is_empty() {
                self.input.take();
            }
            if self.child.try_wait().is_ok_and(|s| s.is_some()) {
                process::cleanup_children();
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        process::kill_worker(&mut self.child);
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        process::kill_worker(&mut self.child);
    }
}
