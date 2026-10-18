use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{self, BufRead};

pub const API_VERSION: u64 = 1;
pub const MAX_RECORD: usize = 4 * 1024 * 1024;
pub const MAX_INPUT: usize = 1024 * 1024;
pub const MAX_SNAPSHOT: usize = 512 * 1024;
pub const MAX_PREVIEW: usize = 8 * 1024;
pub const MAX_CHUNK: usize = 64 * 1024;
pub const MAX_CLIENTS: usize = 32;
pub const MAX_PENDING: usize = 32;
pub const MAX_WATCHES: usize = 8;
pub const MAX_ACTIVE: usize = 4;
pub const MAX_OUTPUT: usize = MAX_RECORD;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn app(kind: &str, message: impl Into<String>) -> Self {
        Self {
            code: -32000,
            message: message.into(),
            data: Some(json!({"kind":kind})),
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: message.into(),
            data: None,
        }
    }
    pub fn io(error: io::Error) -> Self {
        Self::app("not_ready", error.to_string())
    }
    pub fn kind(&self) -> Option<&str> {
        self.data.as_ref()?.get("kind")?.as_str()
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for RpcError {}
impl From<io::Error> for RpcError {
    fn from(error: io::Error) -> Self {
        Self::io(error)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub jsonrpc: String,
    pub id: String,
    pub method: String,
    #[serde(default = "empty_object")]
    pub params: Value,
}

fn empty_object() -> Value {
    json!({})
}

impl Request {
    pub fn new(id: impl Into<String>, method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id: id.into(),
            method: method.into(),
            params,
        }
    }
    pub fn parse(bytes: &[u8]) -> Result<Self, RpcError> {
        let value: Value = serde_json::from_slice(bytes).map_err(|_| RpcError {
            code: -32700,
            message: "Invalid JSON record".into(),
            data: None,
        })?;
        let request: Self = serde_json::from_value(value).map_err(|_| RpcError {
            code: -32600,
            message: "Expected one JSON-RPC request with a string id".into(),
            data: None,
        })?;
        if request.jsonrpc != "2.0" || request.id.is_empty() || request.id.len() > 128 {
            return Err(RpcError {
                code: -32600,
                message: "Invalid jsonrpc or id".into(),
                data: None,
            });
        }
        validate(&request.method, &request.params)?;
        Ok(request)
    }
}

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
    let (required, optional): (&[&str], &[&str]) = match method {
        "system.hello" => (&["api_version"], &[]),
        "configuration.get" => (&[], &[]),
        "session.create" => (&["session_id", "workspace"], &[]),
        "session.list" => (&[], &["cursor", "limit"]),
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
    for key in ["session_id", "request_id"] {
        if object.contains_key(key) && !identifier(string(params, key)?) {
            return Err(RpcError::invalid(format!("Invalid {key}")));
        }
    }
    for key in [
        "submission_id",
        "entry_id",
        "watch_id",
        "cursor",
        "workspace",
    ] {
        if object.contains_key(key) {
            let value = string(params, key)?;
            if value.is_empty() || value.len() > 4096 || value.contains('\0') {
                return Err(RpcError::invalid(format!("Invalid {key}")));
            }
        }
    }
    if method == "system.hello" {
        integer(params, "api_version", 0, 9_007_199_254_740_991)?;
    }
    integer(params, "timeout_ms", 0, 9_007_199_254_740_991)?;
    integer(params, "offset", 0, 9_007_199_254_740_991)?;
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
    if method == "input.submit" {
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
            if item.path.is_empty()
                || item.path.contains('\0')
                || std::path::Path::new(&item.path).is_absolute()
                || item.changedtick > 9_007_199_254_740_991
                || !matches!(item.kind.as_str(), "buffer" | "selection")
                || (item.kind == "buffer" && (item.start_line.is_some() || item.end_line.is_some()))
                || (item.kind == "selection"
                    && !matches!((item.start_line,item.end_line), (Some(a),Some(b)) if a > 0 && b >= a && b <= 9_007_199_254_740_991))
            {
                return Err(RpcError::invalid(
                    "Invalid context path, kind, or line range",
                ));
            }
        }
        if size > MAX_INPUT {
            return Err(RpcError::app("resource_limit", "Input text exceeds 1 MiB"));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Context {
    pub kind: String,
    pub path: String,
    pub text: String,
    pub modified: bool,
    pub changedtick: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Session {
    pub session_id: String,
    pub workspace: String,
    pub provider: String,
    pub model: String,
    pub instructions: String,
    pub schema_version: u64,
    pub tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preview {
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub entry_id: String,
    pub kind: String,
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tool {
    pub name: String,
    pub status: String,
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub session: Session,
    pub state: String,
    pub active_submission_id: Option<String>,
    pub assistant: Preview,
    pub tools: Vec<Tool>,
    pub entries: Vec<Entry>,
    pub history_cursor: Option<String>,
    pub truncated: bool,
    pub activity: Option<Value>,
    pub usage: Option<Value>,
    pub error: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Outcome {
    pub session_id: String,
    pub request_id: String,
    pub submission_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_entry_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub fn limits() -> Value {
    json!({"record_bytes":MAX_RECORD,"input_bytes":MAX_INPUT,"context_items":16,"snapshot_bytes":MAX_SNAPSHOT,"recent_items":50,"preview_bytes":MAX_PREVIEW,"chunk_bytes":MAX_CHUNK,"clients":MAX_CLIENTS,"pending_requests":MAX_PENDING,"watches":MAX_WATCHES,"active_sessions":MAX_ACTIVE,"output_bytes":MAX_OUTPUT})
}

pub fn response(id: Value, result: Result<Value, RpcError>) -> Value {
    match result {
        Ok(value) => json!({"jsonrpc":"2.0","id":id,"result":value}),
        Err(error) => json!({"jsonrpc":"2.0","id":id,"error":error}),
    }
}

pub fn encode(value: &Value) -> Result<Vec<u8>, RpcError> {
    let mut bytes = serde_json::to_vec(value)
        .map_err(|_| RpcError::app("internal_error", "Cannot encode record"))?;
    bytes.push(b'\n');
    if bytes.len() > MAX_RECORD {
        return Err(RpcError::app("resource_limit", "Record exceeds 4 MiB"));
    }
    Ok(bytes)
}

#[derive(Default)]
pub struct Framer {
    bytes: Vec<u8>,
}

impl Framer {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>, RpcError> {
        let mut records = Vec::new();
        for part in bytes.split_inclusive(|byte| *byte == b'\n') {
            if self.bytes.len() + part.len() > MAX_RECORD {
                return Err(RpcError::app("resource_limit", "Record exceeds 4 MiB"));
            }
            self.bytes.extend_from_slice(part);
            if self.bytes.last() == Some(&b'\n') {
                self.bytes.pop();
                records.push(std::mem::take(&mut self.bytes));
            }
        }
        Ok(records)
    }
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

pub fn read_frame(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, RpcError> {
    let mut record = Vec::new();
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            return if record.is_empty() {
                Ok(None)
            } else {
                Err(RpcError::invalid("Incomplete record at EOF"))
            };
        }
        let count = bytes
            .iter()
            .position(|b| *b == b'\n')
            .map_or(bytes.len(), |n| n + 1);
        if record.len() + count > MAX_RECORD {
            return Err(RpcError::app("resource_limit", "Record exceeds 4 MiB"));
        }
        let complete = bytes[count - 1] == b'\n';
        record.extend_from_slice(&bytes[..count]);
        reader.consume(count);
        if complete {
            record.pop();
            std::str::from_utf8(&record).map_err(|_| RpcError::invalid("Record must use UTF-8"))?;
            return Ok(Some(record));
        }
    }
}
