use crate::{client::Client, config::Config, process, protocol::RpcError, server};
use serde_json::{Value, json};
use std::io::{self, IsTerminal, Write};

fn terminal() -> Result<(), RpcError> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(RpcError::invalid(
            "Login and setup require a terminal. Use \\login in a chat",
        ));
    }
    Ok(())
}

fn choose<'a>(
    items: &'a [Value],
    label: &str,
    supplied: Option<&str>,
) -> Result<Option<&'a Value>, RpcError> {
    if let Some(id) = supplied {
        return items
            .iter()
            .find(|item| item["id"] == id)
            .map(Some)
            .ok_or_else(|| {
                RpcError::invalid(format!(
                    "Unknown {label}. Run harness auth to see available choices"
                ))
            });
    }
    if items.is_empty() {
        return Err(RpcError::app(
            "not_ready",
            format!("No {label} choices are available"),
        ));
    }
    for (index, item) in items.iter().enumerate() {
        println!(
            "{}. {} ({})",
            index + 1,
            item["name"].as_str().unwrap_or_default(),
            item["id"].as_str().unwrap_or_default()
        );
    }
    loop {
        let Some(value) = process::terminal_line(&format!("{label} number (q cancels): "))? else {
            return Ok(None);
        };
        if value.is_empty() || value == "q" || value == "\u{1b}" {
            return Ok(None);
        }
        if let Some(item) = value
            .parse::<usize>()
            .ok()
            .and_then(|n| n.checked_sub(1))
            .and_then(|n| items.get(n))
        {
            return Ok(Some(item));
        }
        println!("Enter a number from the list, or q.");
    }
}

fn catalog<'a>(status: &'a Value, key: &str) -> Result<&'a [Value], RpcError> {
    status[key].as_array().map(Vec::as_slice).ok_or_else(|| {
        RpcError::app(
            "not_ready",
            "The provider catalog is unavailable. Upgrade the server",
        )
    })
}

fn cancel() -> i32 {
    println!("Cancelled. Existing credentials and configuration were preserved.");
    130
}

fn login(client: &mut Client, provider: &Value, method: Option<&str>) -> Result<i32, RpcError> {
    let Some(method) = choose(catalog(provider, "methods")?, "Login method", method)? else {
        return Ok(cancel());
    };
    println!(
        "{} — {}",
        provider["name"].as_str().unwrap_or_default(),
        method["name"].as_str().unwrap_or_default()
    );
    println!(
        "Credentials are saved privately for this server. No model request is made.\nPress Ctrl-C or Escape to cancel."
    );
    io::stdout().flush()?;
    let guard = process::TerminalSession::open()?;
    let result = client.request(
        "auth.login",
        json!({"provider":provider["id"],"method":method["id"],"terminal":guard.path}),
    )?;
    drop(guard);
    if result["cancelled"] == true {
        return Ok(cancel());
    }
    println!("Login saved. Select a model in the chat. API keys are checked when a task runs.");
    Ok(0)
}

pub fn auth(
    config: &Config,
    provider: Option<&str>,
    method: Option<&str>,
) -> Result<i32, RpcError> {
    terminal()?;
    server::start(config)?;
    let mut client = Client::connect(&config.socket_path, Some(&config.state_dir))?;
    let status = client.request("configuration.get", json!({}))?;
    let providers: Vec<_> = catalog(&status, "providers")?
        .iter()
        .filter(|item| {
            item["methods"]
                .as_array()
                .is_some_and(|methods| !methods.is_empty())
        })
        .cloned()
        .collect();
    let Some(provider) = choose(&providers, "Provider", provider)? else {
        return Ok(cancel());
    };
    login(&mut client, provider, method)
}

pub fn run(config: &Config) -> Result<i32, RpcError> {
    terminal()?;
    println!(
        "Harness setup\nConfiguration: {}\nSetup makes no model request.",
        config.setup_path()?.display()
    );
    let original = config.setup_bytes()?;
    server::start(config)?;
    let mut client = Client::connect(&config.socket_path, Some(&config.state_dir))?;
    let status = client.request("configuration.get", json!({}))?;
    let Some(provider) = choose(catalog(&status, "providers")?, "Provider", None)? else {
        return Ok(cancel());
    };
    let models: Vec<_> = catalog(&status, "models")?
        .iter()
        .filter(|model| model["provider"] == provider["id"])
        .cloned()
        .collect();
    let Some(model) = choose(&models, "Model", None)? else {
        return Ok(cancel());
    };
    let provider_id = provider["id"].as_str().unwrap_or_default();
    let model_id = model["id"].as_str().unwrap_or_default();
    if config.provider.as_deref() == Some(provider_id)
        && config.model.as_deref() == Some(model_id)
        && status["provider"] == provider_id
        && status["model"] == model_id
        && status["ready"] == true
    {
        println!("Configuration is already ready. No restart is needed.");
        return Ok(0);
    }
    let staged = config.stage_setup(provider_id, model_id, &original)?;
    if provider["authenticated"] != true && login(&mut client, provider, None)? != 0 {
        return Ok(cancel());
    }
    staged.unchanged()?;
    println!("Apply defaults. Active work prevents restart; it will not be stopped.");
    client.request("server.shutdown", json!({}))?;
    drop(client);
    let ownership = server::released(config)?;
    staged.commit()?;
    let updated = config.reload()?;
    drop(ownership);
    server::start(&updated)?;
    let mut client = Client::connect(&updated.socket_path, Some(&updated.state_dir))?;
    let current = client.request("configuration.get", json!({}))?;
    if current["provider"] != provider_id
        || current["model"] != model_id
        || current["ready"] != true
    {
        return Err(RpcError::app(
            "not_ready",
            "Defaults were saved. Use harness auth to connect the selected provider",
        ));
    }
    println!("Setup complete. Ready to create a chat. No model request was made.");
    Ok(0)
}
