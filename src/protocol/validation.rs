use super::{Context, MAX_CHUNK, MAX_INPUT, RpcError};
use serde_json::{Map, Value};

const MAX_INTEGER: u64 = 9_007_199_254_740_991;

pub fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

fn string<'a>(params: &'a Value, name: &str) -> Result<&'a str, RpcError> {
    params
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::invalid(format!("{name} must be a string")))
}

fn integer(params: &Value, name: &str, min: u64, max: u64) -> Result<(), RpcError> {
    if let Some(value) = params.get(name)
        && !value.as_u64().is_some_and(|n| n >= min && n <= max)
    {
        return Err(RpcError::invalid(format!("Invalid {name}")));
    }
    Ok(())
}

pub fn validate(method: &str, params: &Value) -> Result<(), RpcError> {
    let object = check_fields(method, params)?;
    check_identifiers(params)?;
    check_settings(params)?;
    if method == "session.configure"
        && (object.len() == 1 || object.contains_key("provider") != object.contains_key("model"))
    {
        return Err(RpcError::invalid(
            "Supply settings; provider and model must be supplied together",
        ));
    }
    check_login(method, params)?;
    check_paths(params)?;
    check_bounds(method, params)?;
    if method == "input.submit" {
        check_input(params)?;
    }
    Ok(())
}

fn check_fields<'a>(method: &str, params: &'a Value) -> Result<&'a Map<String, Value>, RpcError> {
    let (required, optional): (&[&str], &[&str]) = match method {
        "system.hello" => (&["api_version"], &[]),
        "configuration.get" => (&[], &["session_id"]),
        "auth.login" => (&["provider", "method", "terminal"], &["remote"]),
        "auth.logout" => (&["provider"], &[]),
        "session.create" => (&["session_id", "workspace"], &["parent_session_id", "name"]),
        "session.configure" => (
            &["session_id"],
            &["provider", "model", "instructions", "name"],
        ),
        "session.list" => (&[], &["cursor", "limit", "workspace"]),
        "session.get" | "session.watch" => (&["session_id"], &[]),
        "session.unwatch" => (&["watch_id"], &[]),
        "input.submit" => (&["session_id", "request_id", "text", "context"], &[]),
        "submission.get" => (&["session_id", "request_id"], &[]),
        "submission.wait" => (&["session_id", "request_id"], &["timeout_ms"]),
        "run.stop" => (&["session_id", "submission_id"], &[]),
        "transcript.list" => (&["session_id"], &["cursor", "limit"]),
        "entry.read" => (&["session_id", "entry_id"], &["offset", "limit"]),
        "server.shutdown" | "server.restart_worker" => (&[], &[]),
        _ => {
            return Err(RpcError {
                code: -32601,
                message: "Unknown method".into(),
                data: None,
            });
        }
    };
    let object = params
        .as_object()
        .ok_or_else(|| RpcError::invalid("params must be an object"))?;
    for key in required {
        if !object.contains_key(*key) {
            return Err(RpcError::invalid(format!("Missing {key}")));
        }
    }
    for key in object.keys() {
        if !required.contains(&key.as_str()) && !optional.contains(&key.as_str()) {
            return Err(RpcError::invalid("Unknown parameter field"));
        }
    }
    Ok(object)
}

fn check_identifiers(params: &Value) -> Result<(), RpcError> {
    for key in ["session_id", "request_id", "parent_session_id"] {
        if key == "parent_session_id" && params[key].is_null() {
            continue;
        }
        if params.get(key).is_some() && !identifier(string(params, key)?) {
            return Err(RpcError::invalid(format!("Invalid {key}")));
        }
    }
    Ok(())
}

fn check_settings(params: &Value) -> Result<(), RpcError> {
    for key in ["provider", "model", "name"] {
        if params.get(key).is_some() {
            let value = string(params, key)?;
            if value
                .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
                .is_empty()
                || value.len() > 128
                || value.chars().any(char::is_control)
            {
                return Err(RpcError::invalid(format!("Invalid {key}")));
            }
        }
    }
    if params.get("instructions").is_some() {
        let value = string(params, "instructions")?;
        if value.len() > MAX_INPUT || value.contains('\0') {
            return Err(RpcError::invalid("Invalid instructions"));
        }
    }
    Ok(())
}

fn check_login(method: &str, params: &Value) -> Result<(), RpcError> {
    if method == "auth.login"
        && (!matches!(params["method"].as_str(), Some("api_key" | "oauth"))
            || !string(params, "terminal")?.starts_with("/dev/"))
    {
        return Err(RpcError::invalid("Invalid login method or terminal"));
    }
    if params.get("remote").is_some() && !params["remote"].is_boolean() {
        return Err(RpcError::invalid("remote must be a boolean"));
    }
    Ok(())
}

fn check_paths(params: &Value) -> Result<(), RpcError> {
    for key in [
        "submission_id",
        "entry_id",
        "watch_id",
        "cursor",
        "workspace",
        "terminal",
    ] {
        if params.get(key).is_some() {
            let value = string(params, key)?;
            if value.is_empty() || value.len() > 4096 || value.contains('\0') {
                return Err(RpcError::invalid(format!("Invalid {key}")));
            }
        }
    }
    Ok(())
}

fn check_bounds(method: &str, params: &Value) -> Result<(), RpcError> {
    if method == "system.hello" {
        integer(params, "api_version", 0, MAX_INTEGER)?;
    }
    integer(params, "timeout_ms", 0, MAX_INTEGER)?;
    integer(params, "offset", 0, MAX_INTEGER)?;
    integer(
        params,
        "limit",
        1,
        if method == "entry.read" {
            MAX_CHUNK as u64
        } else {
            100
        },
    )?;
    Ok(())
}

fn check_input(params: &Value) -> Result<(), RpcError> {
    let text = string(params, "text")?;
    let context: Vec<Context> = serde_json::from_value(params["context"].clone())
        .map_err(|_| RpcError::invalid("Invalid context attachment"))?;
    if context.len() > 16 {
        return Err(RpcError::app(
            "resource_limit",
            "At most 16 attachments are permitted",
        ));
    }
    let mut size = text.len();
    for item in context {
        size = size.saturating_add(item.text.len());
        check_context(&item)?;
    }
    if size > MAX_INPUT {
        return Err(RpcError::app("resource_limit", "Input text exceeds 1 MiB"));
    }
    Ok(())
}

fn check_context(item: &Context) -> Result<(), RpcError> {
    let valid_lines = match item.kind.as_str() {
        "buffer" => item.start_line.is_none() && item.end_line.is_none(),
        "selection" => matches!((item.start_line, item.end_line),
            (Some(start), Some(end)) if start > 0 && end >= start && end <= MAX_INTEGER),
        _ => false,
    };
    if item.path.is_empty()
        || item.path.contains('\0')
        || std::path::Path::new(&item.path).is_absolute()
        || item.changedtick > MAX_INTEGER
        || !valid_lines
    {
        return Err(RpcError::invalid(
            "Invalid context path, kind, or line range",
        ));
    }
    Ok(())
}
