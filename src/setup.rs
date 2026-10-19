use crate::{client::Client, config::Config, process, protocol::RpcError, server};
use serde_json::{Value, json};
use std::io::{self, IsTerminal};

fn input(prompt: &str, secret: bool) -> Result<Option<String>, RpcError> {
    let value = process::terminal_line(prompt, secret)?;
    if secret {
        println!();
    }
    Ok(value.filter(|value| !value.is_empty() && value != "q" && value != "\u{1b}"))
}

fn provider() -> Result<Option<&'static str>, RpcError> {
    println!(
        "1. Anthropic (paid; API key required)\n2. Local demo (fixed replies; no AI coding)\nq. Cancel"
    );
    loop {
        match input("Provider [1/2/q]: ", false)?.as_deref() {
            Some("1") => return Ok(Some("anthropic")),
            Some("2") => return Ok(Some("faux")),
            None => return Ok(None),
            _ => println!("Enter 1, 2, or q."),
        }
    }
}

fn model(status: &Value) -> Result<Option<String>, RpcError> {
    let models = status["models"]
        .as_array()
        .filter(|models| !models.is_empty())
        .ok_or_else(|| RpcError::app("not_ready", "The model catalog is unavailable"))?;
    for (index, model) in models.iter().enumerate() {
        println!(
            "{}. {} ({})",
            index + 1,
            model["name"].as_str().unwrap_or_default(),
            model["id"].as_str().unwrap_or_default()
        );
    }
    loop {
        let Some(value) = input("Model number (q cancels): ", false)? else {
            return Ok(None);
        };
        if let Some(id) = value
            .parse::<usize>()
            .ok()
            .and_then(|index| index.checked_sub(1))
            .and_then(|index| models.get(index))
            .and_then(|model| model["id"].as_str())
        {
            return Ok(Some(id.into()));
        }
        println!("Enter a model number from the list, or q.");
    }
}

fn cancel() -> i32 {
    println!("Cancelled. Configuration was not changed.");
    130
}

fn terminal() -> Result<(), RpcError> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(RpcError::invalid(
            "Credentials and setup require a terminal. Use \\auth in the chat for credentials",
        ));
    }
    Ok(())
}

fn credential() -> Result<Option<String>, RpcError> {
    println!(
        "The key stays in the server environment. It is not saved to disk.\nAfter the server stops, supply the key again or set ANTHROPIC_API_KEY before startup."
    );
    let inherited = std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .filter(|key| !key.trim().is_empty());
    let key = if let Some(key) = inherited {
        match process::terminal_line("Use ANTHROPIC_API_KEY from this terminal? [Y/n/q]: ", false)?
            .as_deref()
        {
            Some("" | "y" | "Y") => Some(key),
            Some("n" | "N") => input("API key (hidden; Enter cancels): ", true)?,
            _ => None,
        }
    } else {
        input("API key (hidden; Enter cancels): ", true)?
    };
    if key
        .as_ref()
        .is_some_and(|key| key.trim().is_empty() || key.chars().any(char::is_control))
    {
        return Err(RpcError::invalid(
            "API key must contain text and no control characters",
        ));
    }
    Ok(key)
}

fn shutdown(mut client: Client, hello: &Value, config: &Config) -> Result<std::fs::File, RpcError> {
    println!("Apply settings. Active work prevents restart; it will not be stopped.");
    if let Err(error) = client.request("server.shutdown", json!({})) {
        if error.kind() == Some("busy") {
            return Err(RpcError::app(
                "busy",
                if hello["ready"] == false {
                    "Unfinished work is blocked. Settings were not changed and work was preserved. Restore the required server environment: send SIGTERM to the server, set ANTHROPIC_API_KEY, then run harness start with the same configuration. Do not stop the runs to change credentials"
                } else {
                    "Work is active. Settings were not changed and work was preserved. Wait for completion, then retry this command"
                },
            ));
        }
        return Err(error);
    }
    drop(client);
    server::released(config)
}

pub fn auth(config: &Config) -> Result<i32, RpcError> {
    terminal()?;
    println!("Anthropic credential\nNo model request is made. Press Ctrl-C to cancel.");
    let hello = server::start(config)?;
    let client = Client::connect(&config.socket_path, Some(&config.state_dir))?;
    let Some(key) = credential()? else {
        return Ok(cancel());
    };
    let ownership = shutdown(client, &hello, config)?;
    drop(ownership);
    server::start_with_key(config, Some(&key))?;
    drop(key);
    println!(
        "Credential loaded in the server environment. The provider has not checked it. Select a model in the chat."
    );
    Ok(0)
}

pub fn run(config: &Config) -> Result<i32, RpcError> {
    terminal()?;
    println!(
        "Harness setup\nConfiguration: {}",
        config.setup_path()?.display()
    );
    println!("Setup makes no model request. Press Ctrl-C to cancel.");
    let original = config.setup_bytes()?;
    let hello = server::start(config)?;
    let mut client = Client::connect(&config.socket_path, Some(&config.state_dir))?;
    let status = client.request("configuration.get", json!({}))?;
    let Some(provider) = provider()? else {
        return Ok(cancel());
    };
    let model = if provider == "faux" {
        "test".into()
    } else {
        let Some(model) = model(&status)? else {
            return Ok(cancel());
        };
        model
    };
    let same = config.provider.as_deref() == Some(provider)
        && config.model.as_deref() == Some(&model)
        && status["provider"] == provider
        && status["model"] == model
        && status["ready"] == true;
    if same {
        if provider == "faux" {
            println!("Configuration is already ready. No restart is needed.");
            return Ok(0);
        }
        match process::terminal_line("Keep the current server key? [Y/n/q]: ", false)?.as_deref() {
            Some("" | "y" | "Y") => {
                println!("Configuration is already ready. No restart is needed.");
                return Ok(0);
            }
            Some("n" | "N") => {}
            _ => return Ok(cancel()),
        }
    }
    let mut key = None;
    if provider == "anthropic" {
        key = credential()?;
        if key.is_none() {
            return Ok(cancel());
        }
    }
    let staged = config.stage_setup(provider, &model, &original)?;
    staged.unchanged()?;
    let ownership = shutdown(client, &hello, config)?;
    staged.commit()?;
    let updated = config.reload()?;
    drop(ownership);
    server::start_with_key(&updated, key.as_deref())?;
    drop(key);
    let mut client = Client::connect(&updated.socket_path, Some(&updated.state_dir))?;
    let current = client.request("configuration.get", json!({}))?;
    if current["provider"] != provider || current["model"] != model || current["ready"] != true {
        return Err(RpcError::app(
            "not_ready",
            "Configuration was saved, but the server is not ready. Run setup again",
        ));
    }
    println!("Setup complete. Ready to create an agent. No model request was made.");
    Ok(0)
}
