use crate::client::{self, Client};
use crate::config::Config;
use crate::process;
use crate::protocol::{MAX_CHUNK, MAX_INPUT, RpcError};
use crate::server;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{self, Read};
use std::path::Path;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

const HELP: &str = "harness ssh --host HOST --workspace REMOTE_PATH [--remote-command PATH]\n\
harness nvim [--config PATH] [--socket PATH]\n\
harness setup [--config PATH] [--socket PATH]\n\
harness auth [--provider ID] [--method api_key|oauth] [--config PATH] [--socket PATH]\n\
harness logout --provider ID [--config PATH] [--socket PATH]\n\
harness start|serve|upgrade [--config PATH] [--state-dir PATH] [--socket PATH]\n\
harness status|shutdown|restart-worker|rpc [--socket PATH]\n\
harness session create --id ID --workspace PATH [--parent ID] [--name NAME] [--socket PATH]\n\
harness session configure --session ID [--provider ID --model ID] [--instructions TEXT] [--name NAME]\n\
harness session list [--workspace PATH] [--socket PATH]\n\
harness send --session ID --request-id ID --stdin [--socket PATH]\n\
harness wait --session ID --request-id ID [--timeout-ms N] [--text] [--socket PATH]\n\
harness watch --session ID [--socket PATH]\n\
harness stop --session ID --submission-id ID [--socket PATH]\n\
All client commands also accept --config PATH and --state-dir PATH.\n\
For nvim, set a custom state_dir in the configuration file.";

pub fn run() -> i32 {
    if let Err(error) = process::install_signals() {
        eprintln!("{error}");
        return 3;
    }
    let outcome = execute(std::env::args().skip(1).collect());
    if process::interrupted() {
        return 130;
    }
    match outcome {
        Ok(status) => status,
        Err(error) => {
            eprintln!("{}", error.message);
            match error.kind() {
                Some("busy" | "conflict" | "resource_limit") => 6,
                Some("timeout") => 4,
                Some("incompatible_version" | "not_ready" | "storage_error") => 3,
                _ if matches!(error.code, -32602..=-32600) => 2,
                _ => 1,
            }
        }
    }
}

struct Arguments {
    command: String,
    options: BTreeMap<String, String>,
}

impl Arguments {
    fn parse(args: Vec<String>) -> Result<Self, RpcError> {
        let mut positional = Vec::new();
        let mut options = BTreeMap::new();
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            if arg.starts_with("--") {
                let value = if matches!(arg.as_str(), "--stdin" | "--text") {
                    String::new()
                } else {
                    args.next()
                        .filter(|value| !value.starts_with("--"))
                        .ok_or_else(|| RpcError::invalid(format!("Missing value for {arg}")))?
                };
                if options.insert(arg.clone(), value).is_some() {
                    return Err(RpcError::invalid(format!("Repeated option {arg}")));
                }
            } else {
                positional.push(arg);
            }
        }
        let command = positional.join(" ");
        let allowed: &[&str] = match command.as_str() {
            "ssh" => &["--host", "--workspace", "--remote-command"],
            "browser" => &[],
            "start" | "serve" | "upgrade" => &["--socket", "--config", "--state-dir"],
            "auth" => &["--socket", "--provider", "--method"],
            "logout" => &["--socket", "--provider"],
            "nvim" | "setup" | "status" | "shutdown" | "restart-worker" | "rpc" => &["--socket"],
            "session create" => &["--socket", "--id", "--workspace", "--parent", "--name"],
            "session configure" => &[
                "--socket",
                "--session",
                "--provider",
                "--model",
                "--instructions",
                "--name",
            ],
            "session list" => &["--socket", "--workspace"],
            "send" => &["--socket", "--session", "--request-id", "--stdin"],
            "wait" => &[
                "--socket",
                "--session",
                "--request-id",
                "--timeout-ms",
                "--text",
            ],
            "watch" => &["--socket", "--session"],
            "stop" => &["--socket", "--session", "--submission-id"],
            _ => return Err(RpcError::invalid("Unknown command. Use harness --help")),
        };
        for option in options.keys() {
            if !allowed.contains(&option.as_str())
                && !matches!(option.as_str(), "--config" | "--state-dir")
            {
                return Err(RpcError::invalid(format!("Unknown option {option}")));
            }
        }
        if command == "nvim" && options.contains_key("--state-dir") {
            return Err(RpcError::invalid(
                "For nvim, set state_dir and socket_path in the --config file",
            ));
        }
        Ok(Self { command, options })
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.options.get(key).map(String::as_str)
    }
    fn required(&self, key: &str) -> Result<&str, RpcError> {
        self.get(key)
            .ok_or_else(|| RpcError::invalid(format!("Missing {key}")))
    }
    fn path(&self, key: &str) -> Option<&Path> {
        self.get(key).map(Path::new)
    }
}

fn execute(args: Vec<String>) -> Result<i32, RpcError> {
    if args.as_slice() == ["--help"] || args.as_slice() == ["help"] {
        println!("{HELP}");
        return Ok(0);
    }
    let args = Arguments::parse(args)?;
    if matches!(args.command.as_str(), "ssh" | "browser") {
        if args.get("--config").is_some() || args.get("--state-dir").is_some() {
            return Err(RpcError::invalid(
                "This command does not use a local Harness configuration",
            ));
        }
        return if args.command == "browser" {
            crate::browser::connect()
        } else {
            crate::ssh::run(
                args.required("--host")?,
                args.required("--workspace")?,
                args.get("--remote-command").unwrap_or("harness"),
            )
        };
    }
    let (method, params) = operation(&args)?;
    crate::protocol::validate(method, &params)?;
    let load = if matches!(args.command.as_str(), "setup" | "auth") {
        Config::load_setup
    } else {
        Config::load
    };
    let config = load(
        args.path("--config"),
        args.path("--state-dir"),
        args.path("--socket"),
    )?;
    let expected_state = (args.get("--socket").is_none()
        || args.get("--config").is_some()
        || args.get("--state-dir").is_some())
    .then_some(config.state_dir.as_path());
    match args.command.as_str() {
        "nvim" => return crate::editor::open(&config),
        "setup" => return crate::setup::run(&config),
        "auth" => return crate::setup::auth(&config, args.get("--provider"), args.get("--method")),
        "serve" => {
            server::serve(config)?;
            return Ok(0);
        }
        "start" => {
            output(&server::start(&config)?)?;
            return Ok(0);
        }
        "upgrade" => {
            output(&server::upgrade(&config)?)?;
            return Ok(0);
        }
        "rpc" => {
            client::proxy(&config.socket_path, expected_state)?;
            return Ok(0);
        }
        _ => {}
    }
    let mut client = Client::connect(&config.socket_path, expected_state)?;
    let result = client.request(method, params)?;
    if args.command == "wait" && args.get("--text").is_some() && result["status"] == "done" {
        answer(&mut client, args.required("--session")?, &result)?;
    } else {
        output(&result)?;
    }
    if args.command == "watch" {
        loop {
            output(&client.read()?)?;
        }
    }
    Ok(if args.command == "wait" {
        match result["status"].as_str() {
            Some("done") => 0,
            Some("unanswered") if result["reason"] == "cancelled" => 5,
            _ => 1,
        }
    } else {
        0
    })
}

fn operation(args: &Arguments) -> Result<(&'static str, Value), RpcError> {
    let session = || args.required("--session");
    Ok(match args.command.as_str() {
        "status" => ("system.hello", json!({"api_version":1})),
        "logout" => (
            "auth.logout",
            json!({"provider":args.required("--provider")?}),
        ),
        "session create" => {
            let mut params = json!({"session_id":args.required("--id")?, "workspace":args.required("--workspace")?});
            let parent = if let Some(parent) = args.get("--parent") {
                Some(parent.to_owned())
            } else {
                std::env::var_os("HARNESS_SESSION_ID")
                    .map(|parent| {
                        parent
                            .into_string()
                            .map_err(|_| RpcError::invalid("HARNESS_SESSION_ID must be UTF-8"))
                    })
                    .transpose()?
            };
            if let Some(parent) = parent {
                params["parent_session_id"] = json!(parent);
            }
            if let Some(name) = args.get("--name") {
                params["name"] = json!(name);
            }
            ("session.create", params)
        }
        "session configure" => {
            let mut params = json!({"session_id":session()?});
            for key in ["provider", "model", "instructions", "name"] {
                if let Some(value) = args.get(&format!("--{key}")) {
                    params[key] = json!(value);
                }
            }
            ("session.configure", params)
        }
        "session list" => {
            let mut params = json!({});
            if let Some(workspace) = args.get("--workspace") {
                params["workspace"] = json!(workspace);
            }
            ("session.list", params)
        }
        "send" => {
            let session = session()?;
            let request = args.required("--request-id")?;
            args.required("--stdin")?;
            let text = input()?;
            (
                "input.submit",
                json!({"session_id":session,"request_id":request,"text":text,"context":[]}),
            )
        }
        "wait" => {
            let mut params =
                json!({"session_id":session()?,"request_id":args.required("--request-id")?});
            if let Some(timeout) = args.get("--timeout-ms") {
                params["timeout_ms"] = json!(
                    timeout
                        .parse::<u64>()
                        .map_err(|_| RpcError::invalid("Invalid --timeout-ms"))?
                );
            }
            ("submission.wait", params)
        }
        "watch" => ("session.watch", json!({"session_id":session()?})),
        "stop" => (
            "run.stop",
            json!({"session_id":session()?,"submission_id":args.required("--submission-id")?}),
        ),
        "shutdown" => ("server.shutdown", json!({})),
        "restart-worker" => ("server.restart_worker", json!({})),
        _ => ("system.hello", json!({"api_version":1})),
    })
}

fn input() -> Result<String, RpcError> {
    let (send, receive) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = io::stdin()
            .take((MAX_INPUT + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = send.send(result);
    });
    loop {
        if process::interrupted() {
            return Err(RpcError::app("not_ready", "Client interrupted"));
        }
        match receive.recv_timeout(Duration::from_millis(100)) {
            Ok(result) => {
                let bytes = result?;
                if bytes.len() > MAX_INPUT {
                    return Err(RpcError::app("resource_limit", "Input exceeds 1 MiB"));
                }
                return String::from_utf8(bytes)
                    .map_err(|_| RpcError::invalid("Standard input must contain UTF-8 text"));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(RpcError::app("not_ready", "Cannot read standard input"));
            }
        }
    }
}

fn output(value: &Value) -> Result<(), RpcError> {
    client::write_stdout(&crate::protocol::encode(value)?)
}

fn answer(client: &mut Client, session: &str, outcome: &Value) -> Result<(), RpcError> {
    let entry = outcome["answer_entry_id"]
        .as_str()
        .ok_or_else(|| RpcError::app("not_ready", "Final answer has no entry id"))?;
    let mut offset = 0;
    loop {
        let chunk = client.request(
            "entry.read",
            json!({"session_id":session,"entry_id":entry,"offset":offset,"limit":MAX_CHUNK}),
        )?;
        let text = chunk["text"]
            .as_str()
            .ok_or_else(|| RpcError::app("not_ready", "Invalid answer text"))?;
        if text.len() > MAX_CHUNK || !chunk["end"].is_boolean() {
            return Err(RpcError::app("not_ready", "Invalid answer chunk"));
        }
        client::write_stdout(text.as_bytes())?;
        if chunk["end"] == true {
            break;
        }
        let next = chunk["next_offset"]
            .as_u64()
            .filter(|next| *next > offset)
            .ok_or_else(|| RpcError::app("not_ready", "Invalid answer offset"))?;
        offset = next;
    }
    Ok(())
}
