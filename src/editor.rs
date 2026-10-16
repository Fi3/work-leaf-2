use crate::config::{Config, bundled_path};
use crate::protocol::RpcError;
use serde_json::json;
use std::os::unix::process::CommandExt;
use std::process::Command;

const SETUP: &str = "lua local runtime = vim.env.HARNESS_NVIM_RUNTIME; \
local options = vim.json.decode(vim.env.HARNESS_NVIM_OPTIONS); \
vim.env.HARNESS_NVIM_RUNTIME = nil; vim.env.HARNESS_NVIM_OPTIONS = nil; \
vim.opt.runtimepath:prepend(runtime); require('harness').setup(options)";

pub fn open(config: &Config) -> Result<i32, RpcError> {
    let runtime = bundled_path("nvim", "")?;
    if !runtime.join("plugin/harness.lua").is_file() {
        return Err(RpcError::app(
            "not_ready",
            "Cannot find the Neovim plugin; install Harness again",
        ));
    }
    let mut options = json!({
        "executable": std::env::current_exe()?,
        "socket_path": config.socket_path,
    });
    if let Some(path) = &config.config_path {
        options["config_path"] = json!(path);
    }
    let error = Command::new("nvim")
        .env("HARNESS_NVIM_RUNTIME", runtime)
        .env("HARNESS_NVIM_OPTIONS", options.to_string())
        .args([
            "--cmd",
            SETUP,
            "-c",
            "runtime plugin/harness.lua",
            "-c",
            "lua require('harness').enable_sidebar()",
        ])
        .exec();
    Err(RpcError::app(
        "not_ready",
        format!("Cannot start Neovim: {error}. Install nvim and add it to PATH"),
    ))
}
