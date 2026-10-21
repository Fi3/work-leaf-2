use crate::protocol::RpcError;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

static INTERRUPTED: AtomicBool = AtomicBool::new(false);

extern "C" fn signal_handler(_: libc::c_int) {
    INTERRUPTED.store(true, Ordering::Relaxed);
}

pub fn install_signals() -> io::Result<()> {
    INTERRUPTED.store(false, Ordering::Relaxed);
    // The handler only writes a lock-free atomic and does not call Rust allocation code.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = signal_handler as *const () as usize;
        libc::sigemptyset(&mut action.sa_mask);
        for signal in [libc::SIGINT, libc::SIGTERM] {
            if libc::sigaction(signal, &action, std::ptr::null_mut()) < 0 {
                return Err(io::Error::last_os_error());
            }
        }
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    Ok(())
}

pub fn interrupted() -> bool {
    INTERRUPTED.load(Ordering::Relaxed)
}

pub fn random_id() -> io::Result<String> {
    let mut bytes = [0; 16];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub fn peer_pid(stream: &UnixStream) -> io::Result<u32> {
    // SO_PEERCRED initializes this writable value for the live Unix socket.
    let credentials = unsafe {
        let mut credentials: libc::ucred = std::mem::zeroed();
        let mut size = std::mem::size_of_val(&credentials) as libc::socklen_t;
        if libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut size,
        ) < 0
        {
            return Err(io::Error::last_os_error());
        }
        credentials
    };
    u32::try_from(credentials.pid)
        .ok()
        .filter(|pid| *pid != 0)
        .ok_or_else(|| io::Error::other("Socket peer has no process identifier"))
}

pub(crate) fn owned(path: &Path) -> io::Result<std::fs::Metadata> {
    let metadata = std::fs::symlink_metadata(path)?;
    // geteuid has no pointer arguments or preconditions.
    let uid = unsafe { libc::geteuid() };
    if metadata.uid() != uid || metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("Unsafe owner or symbolic link: {}", path.display()),
        ));
    }
    Ok(metadata)
}

pub(crate) fn owned_read(path: &Path) -> io::Result<File> {
    let before = owned(path)?;
    if !before.is_file() {
        return Err(io::Error::other("Configuration is not a regular file"));
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let after = file.metadata()?;
    if before.dev() != after.dev() || before.ino() != after.ino() {
        return Err(io::Error::other("Configuration changed while opening it"));
    }
    Ok(file)
}

pub struct TerminalSession {
    pub path: std::path::PathBuf,
    settings: libc::termios,
}

impl TerminalSession {
    pub fn open() -> io::Result<Self> {
        let path = std::fs::read_link("/proc/self/fd/0")?;
        if !path.starts_with("/dev") || !owned(&path)?.file_type().is_char_device() {
            return Err(io::Error::other("Login requires an owned terminal"));
        }
        // Standard input is live; tcgetattr initializes the writable settings value.
        let settings = unsafe {
            let mut settings = std::mem::zeroed();
            if libc::tcgetattr(0, &mut settings) < 0 {
                return Err(io::Error::last_os_error());
            }
            settings
        };
        Ok(Self { path, settings })
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        // Restore the original terminal even after worker failure or client interruption.
        // TCSAFLUSH discards incomplete secret input from a cancelled prompt.
        unsafe { libc::tcsetattr(0, libc::TCSAFLUSH, &self.settings) };
    }
}

pub fn terminal_line(prompt: &str) -> io::Result<Option<String>> {
    print!("{prompt}");
    io::stdout().flush()?;
    let mut line = Vec::new();
    loop {
        if interrupted() {
            return Ok(None);
        }
        let mut descriptor = libc::pollfd {
            fd: 0,
            events: libc::POLLIN,
            revents: 0,
        };
        // The descriptor is live, and poll receives one valid pollfd for this call.
        let ready = unsafe { libc::poll(&mut descriptor, 1, 100) };
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if ready == 0 {
            continue;
        }
        let mut byte = 0_u8;
        // byte is writable for one byte; reading one byte does not consume the next prompt's input.
        let count = unsafe { libc::read(0, (&mut byte as *mut u8).cast(), 1) };
        if count < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if count == 0 {
            return Ok(None);
        }
        if byte == b'\n' {
            return String::from_utf8(line)
                .map(Some)
                .map_err(|_| io::Error::other("Input must be UTF-8 text"));
        }
        if line.len() >= 4096 {
            return Err(io::Error::other("Setup input is too long"));
        }
        line.push(byte);
    }
}

pub fn private_dir(path: &Path) -> io::Result<()> {
    if !path.exists() {
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::other("Directory has no parent"))?;
        if !parent.exists() {
            private_dir(parent)?;
        }
        let mut builder = std::fs::DirBuilder::new();
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        match builder.create(path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    if !owned(path)?.is_dir() {
        return Err(io::Error::other("Managed directory is not a directory"));
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

pub fn private_file(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .read(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    if !owned(path)?.is_file() {
        return Err(io::Error::other("Managed file is not a regular file"));
    }
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    Ok(file)
}

pub fn lock(state: &Path) -> Result<File, RpcError> {
    private_dir(state)?;
    let file = private_file(&state.join("owner.lock"))?;
    file.try_lock().map_err(|_| {
        RpcError::app(
            "conflict",
            "Another server or worker owns this state directory",
        )
    })?;
    Ok(file)
}

pub fn check_endpoint(path: &Path) -> io::Result<()> {
    match owned(path) {
        Ok(metadata) => {
            use std::os::unix::fs::FileTypeExt;
            if !metadata.file_type().is_socket() {
                return Err(io::Error::other("Socket path is not a socket"));
            }
            if metadata.mode() & 0o077 != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Socket permissions must be 0600",
                ));
            }
            Ok(())
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

pub fn prepare_server() -> io::Result<()> {
    install_signals()?;
    // The process has one worker. Subreaping keeps its ordinary shell descendants owned after a crash.
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } < 0 {
        return Err(io::Error::last_os_error());
    }
    // Restrict files created by Pi, including SQLite WAL and shared-memory files.
    unsafe {
        libc::umask(0o077);
    }
    Ok(())
}

pub fn inherit_lock(command: &mut Command, file: &File) {
    let fd = file.as_raw_fd();
    command
        .env("HARNESS_LOCK_FD", fd.to_string())
        .process_group(0);
    // Only async-signal-safe fcntl runs after fork. The parent keeps fd open through spawn and worker exit.
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

pub fn detach(command: &mut Command) {
    // setsid is async-signal-safe and is called only in the forked child before exec.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

pub fn nonblocking(fd: RawFd) -> io::Result<()> {
    // fd belongs to a live pipe or socket for the duration of these fcntl calls.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

pub(crate) fn wait(
    readable: &[RawFd],
    writable: &[RawFd],
    deadline: Option<Instant>,
) -> io::Result<()> {
    let mut descriptors: Vec<_> = readable
        .iter()
        .map(|fd| (*fd, libc::POLLIN))
        .chain(writable.iter().map(|fd| (*fd, libc::POLLOUT)))
        .map(|(fd, events)| libc::pollfd {
            fd,
            events,
            revents: 0,
        })
        .collect();
    let timeout = deadline.map(|deadline| {
        let remaining = deadline.saturating_duration_since(Instant::now());
        libc::timespec {
            tv_sec: remaining.as_secs().try_into().unwrap_or(libc::time_t::MAX),
            tv_nsec: remaining.subsec_nanos().into(),
        }
    });
    // Each descriptor remains open for this call. The signal sets and timeout are
    // valid local values. Masking before checking INTERRUPTED prevents a lost
    // signal between that check and ppoll; ppoll restores the mask while asleep.
    unsafe {
        let mut signals: libc::sigset_t = std::mem::zeroed();
        let mut previous: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut signals);
        libc::sigaddset(&mut signals, libc::SIGINT);
        libc::sigaddset(&mut signals, libc::SIGTERM);
        if libc::sigprocmask(libc::SIG_BLOCK, &signals, &mut previous) < 0 {
            return Err(io::Error::last_os_error());
        }
        let result = if !interrupted()
            && libc::ppoll(
                descriptors.as_mut_ptr(),
                descriptors.len() as libc::nfds_t,
                timeout.as_ref().map_or(std::ptr::null(), |value| value),
                &previous,
            ) < 0
        {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                Ok(())
            } else {
                Err(error)
            }
        } else {
            Ok(())
        };
        if libc::sigprocmask(libc::SIG_SETMASK, &previous, std::ptr::null_mut()) < 0 {
            return Err(io::Error::last_os_error());
        }
        result
    }
}

pub fn send_nonblocking(fd: RawFd, bytes: &[u8]) -> io::Result<usize> {
    // fd is a live output socket and bytes remains valid throughout this per-call nonblocking send.
    let count = unsafe {
        libc::send(
            fd,
            bytes.as_ptr().cast(),
            bytes.len(),
            libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
        )
    };
    if count < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(count as usize)
    }
}

pub fn kill_worker(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
    cleanup_children();
}

pub fn cleanup_children() {
    let path = format!("/proc/self/task/{}/children", std::process::id());
    for _ in 0..100 {
        let pids: Vec<i32> = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .split_whitespace()
            .filter_map(|s| s.parse().ok())
            .collect();
        if pids.is_empty() {
            break;
        }
        for pid in pids {
            // These PIDs are current children adopted by this single-worker server. Kill their shell groups too.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
                libc::kill(pid, libc::SIGKILL);
            }
        }
        // Reap only this server's exited children; no caller concurrently waits during cleanup.
        unsafe { while libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) > 0 {} }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

pub fn log(state: &Path, message: &str) -> io::Result<()> {
    const LIMIT: u64 = 10 * 1024 * 1024;
    let directory = state.join("logs");
    private_dir(&directory)?;
    let path = directory.join("server.log");
    let line = format!("{} {message}\n", std::process::id());
    if line.len() as u64 > LIMIT {
        return Err(io::Error::other("Diagnostic is too large"));
    }
    let mut file = private_file(&path)?;
    if file.metadata()?.len() + line.len() as u64 > LIMIT {
        drop(file);
        let previous = directory.join("server.1.log");
        if previous.exists() {
            owned(&previous)?;
            std::fs::remove_file(&previous)?;
        }
        std::fs::rename(&path, &previous)?;
        file = private_file(&path)?;
    }
    file.write_all(line.as_bytes())
}
