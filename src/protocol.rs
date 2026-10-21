mod validation;
pub use validation::{identifier, validate};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{self, BufRead};

pub const API_VERSION: u64 = 1;
pub const API_REVISION: u64 = 4;
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

pub fn check_revision(hello: &Value, allow_legacy: bool) -> Result<(), RpcError> {
    if hello["api_revision"].as_u64() == Some(API_REVISION) {
        return Ok(());
    }
    let legacy = hello.get("api_revision").is_none()
        || matches!(hello["api_revision"].as_u64(), Some(1..=3));
    if legacy && allow_legacy {
        return Ok(());
    }
    Err(RpcError::app(
        "incompatible_version",
        if legacy {
            "Server uses an older chat interface. Run harness upgrade with the same configuration after active work finishes"
        } else {
            "Server uses an unsupported chat interface. Update Harness to a compatible version before connecting"
        },
    ))
}

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
        Self::from_value(decode(bytes)?)
    }

    pub(crate) fn from_value(value: Value) -> Result<Self, RpcError> {
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

pub(crate) fn decode(bytes: &[u8]) -> Result<Value, RpcError> {
    serde_json::from_slice(bytes).map_err(|_| RpcError {
        code: -32700,
        message: "Invalid JSON record".into(),
        data: None,
    })
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
    pub provider: Option<String>,
    pub model: Option<String>,
    pub parent_session_id: Option<String>,
    pub name: Option<String>,
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
