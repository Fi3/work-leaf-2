use crate::protocol::RpcError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    provider: Option<String>,
    model: Option<String>,
    #[serde(default)]
    instructions: String,
    node_path: Option<PathBuf>,
    worker_path: Option<PathBuf>,
    state_dir: Option<PathBuf>,
    socket_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Config {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub instructions: String,
    pub node_path: PathBuf,
    pub worker_path: PathBuf,
    pub state_dir: PathBuf,
    pub socket_path: PathBuf,
    #[serde(skip)]
    pub config_path: Option<PathBuf>,
}

fn home() -> Result<PathBuf, RpcError> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| RpcError::invalid("Set HOME or explicit paths"))
}

fn xdg(name: &str, fallback: &str) -> Result<PathBuf, RpcError> {
    match std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
    {
        Some(path) => Ok(path),
        None => Ok(home()?.join(fallback)),
    }
}

pub fn absolute(path: &Path, base: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    }
}

pub fn bundled_path(installed: &str, source: &str) -> Result<PathBuf, RpcError> {
    let executable = std::env::current_exe()?;
    let path = executable
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| RpcError::invalid("Executable has no installation directory"))?
        .join("share/harness")
        .join(installed);
    Ok(if path.exists() {
        path
    } else {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(source)
    })
}

pub fn canonical_path(path: &Path) -> Result<PathBuf, RpcError> {
    if let Ok(metadata) = std::fs::symlink_metadata(path)
        && metadata.file_type().is_symlink()
    {
        return Err(RpcError::invalid(format!(
            "Managed path is a symbolic link: {}",
            path.display()
        )));
    }
    if path.exists() {
        return path.canonicalize().map_err(RpcError::io);
    }
    let parent = path
        .parent()
        .ok_or_else(|| RpcError::invalid("Path has no parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| RpcError::invalid("Path has no file name"))?;
    Ok(canonical_path(parent)?.join(name))
}

impl Config {
    pub fn load(
        config_path: Option<&Path>,
        state_override: Option<&Path>,
        socket_override: Option<&Path>,
    ) -> Result<Self, RpcError> {
        let cwd = std::env::current_dir()?;
        let path = match config_path {
            Some(path) => absolute(path, &cwd),
            None => xdg("XDG_CONFIG_HOME", ".config")?.join("harness/config.json"),
        };
        let raw: FileConfig = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| RpcError::invalid(format!("Invalid configuration: {e}")))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && config_path.is_none() => {
                FileConfig::default()
            }
            Err(e) => return Err(RpcError::invalid(format!("Cannot read configuration: {e}"))),
        };
        let base = path
            .parent()
            .ok_or_else(|| RpcError::invalid("Configuration has no parent"))?;
        let default_state = xdg("XDG_STATE_HOME", ".local/state")
            .and_then(|path| canonical_path(&path.join("harness")));
        let state_dir = match state_override
            .map(|p| absolute(p, &cwd))
            .or_else(|| raw.state_dir.as_ref().map(|p| absolute(p, base)))
        {
            Some(path) => canonical_path(&path)?,
            None => default_state.clone()?,
        };
        let default_socket = std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .map(|p| p.join("harness/control.sock"))
            .or_else(|| {
                default_state
                    .as_ref()
                    .ok()
                    .map(|p| p.join("run/control.sock"))
            });
        let socket = socket_override
            .map(|p| absolute(p, &cwd))
            .or_else(|| raw.socket_path.as_ref().map(|p| absolute(p, base)));
        if !default_state.as_ref().is_ok_and(|p| p == &state_dir)
            && (socket.is_none() || socket == default_socket)
        {
            return Err(RpcError::invalid(
                "A custom state_dir requires a distinct socket_path",
            ));
        }
        let socket_path = canonical_path(
            &socket
                .or(default_socket)
                .ok_or_else(|| RpcError::invalid("Set socket_path"))?,
        )?;
        if socket_path.as_os_str().len() > 107 {
            return Err(RpcError::invalid(
                "Unix socket path exceeds 107 bytes; set a shorter socket_path",
            ));
        }
        let worker_path = match raw.worker_path {
            Some(path) => absolute(&path, base),
            None => bundled_path("adapter/worker.mjs", "adapter/worker.mjs")?,
        };
        Ok(Self {
            provider: raw.provider,
            model: raw.model,
            instructions: raw.instructions,
            node_path: raw
                .node_path
                .map(|p| absolute(&p, base))
                .unwrap_or_else(|| PathBuf::from("node")),
            worker_path,
            state_dir,
            socket_path,
            config_path: if path.exists() || config_path.is_some() {
                Some(path)
            } else {
                None
            },
        })
    }

    pub fn reload(&self) -> Result<Self, RpcError> {
        Self::load(
            self.config_path.as_deref(),
            Some(&self.state_dir),
            Some(&self.socket_path),
        )
    }
}
