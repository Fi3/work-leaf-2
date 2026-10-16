use crate::protocol::RpcError;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};

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

fn owned(path: &Path) -> io::Result<std::fs::Metadata> {
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
