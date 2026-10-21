use crate::{
    config::Config,
    process,
    protocol::{self, Request, RpcError},
    worker::Worker,
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::time::{Duration, Instant};

pub enum Delivery {
    Record(u64, Value),
    Close(u64),
}

#[derive(Default)]
struct Client {
    hello: bool,
    pending: HashSet<String>,
    watches: HashSet<String>,
    sequence: u64,
}

struct Pending {
    client: u64,
    id: String,
    method: String,
}

pub struct Application {
    config: Config,
    // Drop the worker and collect its children before the server releases ownership.
    worker: Option<Worker>,
    lock: File,
    clients: HashMap<u64, Client>,
    pending: HashMap<String, Pending>,
    next_id: u64,
    instance_id: String,
    handshake: Option<Value>,
    started: Instant,
    restarts: VecDeque<Instant>,
    retry_at: Option<Instant>,
    shutdown: Option<(u64, String)>,
    pub finished: bool,
    deliveries: Vec<Delivery>,
    release_requests: HashSet<String>,
    release_watches: HashSet<String>,
}

fn mutation(method: &str) -> bool {
    matches!(
        method,
        "session.create"
            | "session.configure"
            | "input.submit"
            | "run.stop"
            | "auth.login"
            | "auth.logout"
    )
}

impl Application {
    pub fn new(config: Config, lock: File) -> Result<Self, RpcError> {
        let worker = Worker::spawn(&config, &lock)?;
        Ok(Self {
            config,
            lock,
            worker: Some(worker),
            clients: HashMap::new(),
            pending: HashMap::new(),
            next_id: 0,
            instance_id: process::random_id()?,
            handshake: None,
            started: Instant::now(),
            restarts: VecDeque::new(),
            retry_at: None,
            shutdown: None,
            finished: false,
            deliveries: Vec::new(),
            release_requests: HashSet::new(),
            release_watches: HashSet::new(),
        })
    }

    pub fn add_client(&mut self, id: u64) {
        self.clients.insert(id, Client::default());
    }

    pub fn remove_client(&mut self, id: u64) {
        if let Some(client) = self.clients.remove(&id) {
            self.release_requests.extend(
                self.pending
                    .iter()
                    .filter(|(_, p)| p.client == id)
                    .map(|(key, _)| key.clone()),
            );
            self.release_watches.extend(client.watches);
        }
    }

    fn reply(&mut self, client: u64, id: String, result: Result<Value, RpcError>) {
        if let Some(state) = self.clients.get_mut(&client) {
            state.pending.remove(&id);
            self.deliveries.push(Delivery::Record(
                client,
                protocol::response(Value::String(id), result),
            ));
        }
    }

    fn hello(&self) -> Value {
        json!({"api_version":protocol::API_VERSION,"api_revision":protocol::API_REVISION,"instance_id":self.instance_id,"state_dir":self.config.state_dir,"ready":self.handshake.as_ref().is_some_and(|v|v["ready"]==true),"storage_ready":self.handshake.is_some(),"versions":{"rust":"1.94.1","node":"v26.10.0","durable":"1.3.0","ai":"1.3.0","chord":"1.3.0"},"limits":protocol::limits()})
    }

    pub fn request(&mut self, client: u64, request: Request) {
        if !self.admit(client, &request) {
            return;
        }
        match request.method.as_str() {
            "system.hello" => self.client_hello(client, request),
            "server.restart_worker" => self.restart(client, request.id),
            _ => {
                if let Err(error) = self.check_available(&request.method) {
                    self.reply(client, request.id, Err(error));
                    return;
                }
                match request.method.as_str() {
                    "server.shutdown" => self.request_shutdown(client, request.id),
                    "session.watch" => self.request_watch(client, request),
                    "session.unwatch" => self.request_unwatch(client, request),
                    _ => self.forward(client, request),
                }
            }
        }
    }

    fn admit(&mut self, client: u64, request: &Request) -> bool {
        let Some(state) = self.clients.get_mut(&client) else {
            return false;
        };
        if state.pending.contains(&request.id) {
            self.deliveries.push(Delivery::Close(client));
            return false;
        }
        if state.pending.len() >= protocol::MAX_PENDING {
            self.reply(
                client,
                request.id.clone(),
                Err(RpcError::app(
                    "resource_limit",
                    "At most 32 requests may be pending",
                )),
            );
            return false;
        }
        state.pending.insert(request.id.clone());
        if request.method != "system.hello" && !state.hello {
            self.reply(
                client,
                request.id.clone(),
                Err(RpcError::app(
                    "incompatible_version",
                    "Call system.hello first",
                )),
            );
            return false;
        }
        true
    }

    fn client_hello(&mut self, client: u64, request: Request) {
        let result = if request.params["api_version"] == protocol::API_VERSION {
            if let Some(state) = self.clients.get_mut(&client) {
                state.hello = true;
            }
            Ok(self.hello())
        } else {
            Err(RpcError::app(
                "incompatible_version",
                "This server requires api_version 1",
            ))
        };
        self.reply(client, request.id, result);
    }

    fn check_available(&self, method: &str) -> Result<(), RpcError> {
        if self.shutdown.is_some() && (mutation(method) || method == "server.shutdown") {
            return Err(RpcError::app("busy", "Server shutdown is in progress"));
        }
        if self.handshake.is_none() {
            return Err(RpcError::app("not_ready", "Worker storage is unavailable"));
        }
        Ok(())
    }

    fn request_shutdown(&mut self, client: u64, id: String) {
        if self.pending.values().any(|p| p.method == "auth.login") {
            self.reply(
                client,
                id,
                Err(RpcError::app(
                    "busy",
                    "Finish or cancel the open login before shutdown",
                )),
            );
            return;
        }
        self.shutdown = Some((client, id));
    }

    fn request_watch(&mut self, client: u64, request: Request) {
        let count = self.clients[&client].watches.len()
            + self
                .pending
                .values()
                .filter(|p| p.client == client && p.method == "session.watch")
                .count();
        if count >= protocol::MAX_WATCHES {
            self.reply(
                client,
                request.id,
                Err(RpcError::app(
                    "resource_limit",
                    "At most 8 watches are permitted",
                )),
            );
            return;
        }
        self.forward(client, request);
    }

    fn request_unwatch(&mut self, client: u64, request: Request) {
        let watch = request.params["watch_id"].as_str().unwrap_or_default();
        if !self
            .clients
            .get_mut(&client)
            .is_some_and(|state| state.watches.remove(watch))
        {
            self.reply(client, request.id, Ok(json!({})));
            return;
        }
        self.forward(client, request);
    }

    fn forward(&mut self, client: u64, mut request: Request) {
        if self.pending.len() >= protocol::MAX_CLIENTS * protocol::MAX_PENDING {
            if request.method == "server.shutdown" {
                self.shutdown = None;
            }
            self.reply(
                client,
                request.id,
                Err(RpcError::app(
                    "resource_limit",
                    "Worker request limit reached",
                )),
            );
            return;
        }
        let original = Pending {
            client,
            id: request.id.clone(),
            method: request.method.clone(),
        };
        self.next_id += 1;
        request.id = format!("w{}", self.next_id);
        if request.method == "server.shutdown" {
            request.method = "worker.shutdown".into();
        }
        let result = match self.worker.as_mut() {
            Some(worker) => worker.send(json!(&request)),
            None => Err(RpcError::app("not_ready", "Worker unavailable")),
        };
        match result {
            Ok(()) => {
                self.pending.insert(request.id, original);
            }
            Err(e) => {
                if original.method == "server.shutdown" {
                    self.shutdown = None;
                }
                self.reply(client, original.id, Err(e));
            }
        }
    }

    fn restart(&mut self, client: u64, id: String) {
        if self.shutdown.is_some()
            || self.worker.is_some()
                && self
                    .handshake
                    .as_ref()
                    .is_none_or(|v| v["scheduling_enabled"] != false)
        {
            self.reply(
                client,
                id,
                Err(RpcError::app(
                    "busy",
                    "Worker must be absent or fully paused",
                )),
            );
            return;
        }
        self.close();
        self.fail_pending();
        match self.config.reload().and_then(|config| {
            let worker = Worker::spawn(&config, &self.lock)?;
            self.config = config;
            Ok(worker)
        }) {
            Ok(worker) => {
                self.worker = Some(worker);
                self.handshake = None;
                self.started = Instant::now();
                self.retry_at = None;
                self.pending.insert(
                    "_restart".into(),
                    Pending {
                        client,
                        id,
                        method: "server.restart_worker".into(),
                    },
                );
            }
            Err(e) => self.reply(client, id, Err(e)),
        }
    }

    fn worker_record(&mut self, record: Value) -> Result<(), RpcError> {
        if record["method"] == "session.state" {
            return self.watch_notification(record);
        }
        let id = record["id"]
            .as_str()
            .ok_or_else(|| RpcError::app("internal_error", "Worker response has no id"))?;
        if id == "_hello" {
            self.worker_hello(&record["result"])
        } else {
            self.worker_response(id, &record)
        }
    }

    fn watch_notification(&mut self, mut record: Value) -> Result<(), RpcError> {
        let watch = record["params"]["watch_id"]
            .as_str()
            .ok_or_else(|| RpcError::app("internal_error", "Invalid worker watch"))?;
        for (id, client) in &mut self.clients {
            if client.watches.contains(watch) {
                client.sequence += 1;
                record["params"]["sequence"] = json!(client.sequence);
                self.deliveries.push(Delivery::Record(*id, record));
                break;
            }
        }
        Ok(())
    }

    fn worker_hello(&mut self, hello: &Value) -> Result<(), RpcError> {
        if hello["api_version"] != 1
            || hello["api_revision"] != protocol::API_REVISION
            || hello["node_version"] != "v26.10.0"
            || ["durable", "ai", "chord"]
                .iter()
                .any(|key| hello["artifacts"][key] != "1.3.0")
            || !hello["ready"].is_boolean()
            || !hello["scheduling_enabled"].is_boolean()
        {
            return Err(RpcError::app(
                "incompatible_version",
                "Worker runtime or artifact version does not match",
            ));
        }
        self.handshake = Some(hello.clone());
        if let Some(p) = self.pending.remove("_restart") {
            self.reply(p.client, p.id, Ok(self.hello()));
        }
        Ok(())
    }

    fn worker_response(&mut self, id: &str, record: &Value) -> Result<(), RpcError> {
        let Some(pending) = self.pending.remove(id) else {
            return Ok(());
        };
        let result = if let Some(error) = record.get("error") {
            Err(serde_json::from_value::<RpcError>(error.clone())
                .map_err(|_| RpcError::app("internal_error", "Invalid worker error"))?)
        } else {
            Ok(record
                .get("result")
                .ok_or_else(|| RpcError::app("internal_error", "Worker response has no result"))?
                .clone())
        };
        if result
            .as_ref()
            .is_err_and(|error| error.kind() == Some("internal_error"))
        {
            let _ = process::log(
                &self.config.state_dir,
                &format!("Internal error for worker request {id}"),
            );
        }
        if pending.method == "server.shutdown" {
            self.complete_shutdown(result.is_ok());
        }
        if let Ok(value) = &result {
            match pending.method.as_str() {
                "session.watch" => self.complete_watch(pending.client, value)?,
                "auth.login" | "auth.logout" => self.complete_auth(value),
                _ => {}
            }
        }
        self.reply(pending.client, pending.id, result);
        Ok(())
    }

    fn complete_watch(&mut self, client: u64, value: &Value) -> Result<(), RpcError> {
        let watch = value["watch_id"]
            .as_str()
            .ok_or_else(|| RpcError::app("internal_error", "Invalid watch receipt"))?;
        if let Some(client) = self.clients.get_mut(&client) {
            client.watches.insert(watch.into());
        } else {
            self.release_watches.insert(watch.into());
        }
        Ok(())
    }

    fn complete_shutdown(&mut self, succeeded: bool) {
        self.shutdown = None;
        if succeeded {
            self.close();
            self.finished = true;
        }
    }

    fn complete_auth(&mut self, value: &Value) {
        if let Some(ready) = value["worker_ready"].as_bool()
            && let Some(hello) = self.handshake.as_mut()
        {
            hello["ready"] = json!(ready);
            hello["scheduling_enabled"] = json!(ready);
        }
    }

    fn fail_pending(&mut self) {
        for (_, p) in std::mem::take(&mut self.pending) {
            self.reply(
                p.client,
                p.id,
                Err(RpcError::app(
                    "not_ready",
                    "Worker disconnected; query or retry the same target",
                )),
            );
        }
        for (id, client) in &self.clients {
            if !client.watches.is_empty() {
                self.deliveries.push(Delivery::Close(*id));
            }
        }
        self.handshake = None;
    }

    fn failed(&mut self) {
        let _ = process::log(
            &self.config.state_dir,
            "Worker unavailable; unfinished work is retained",
        );
        self.worker.take();
        self.fail_pending();
        self.release_requests.clear();
        self.release_watches.clear();
        if let Some((client, id)) = self.shutdown.take() {
            self.reply(
                client,
                id,
                Err(RpcError::app(
                    "not_ready",
                    "Worker disconnected during shutdown",
                )),
            );
        }
        let now = Instant::now();
        while self
            .restarts
            .front()
            .is_some_and(|t| now.duration_since(*t) > Duration::from_secs(60))
        {
            self.restarts.pop_front();
        }
        self.retry_at = if self.restarts.len() < 3 {
            Some(now + Duration::from_millis(100))
        } else {
            None
        };
    }

    pub fn tick(&mut self) -> Vec<Delivery> {
        if let Some(worker) = self.worker.as_mut() {
            let update = worker.poll();
            match update {
                Ok(update) => {
                    if update.diagnostics {
                        let _ = process::log(
                            &self.config.state_dir,
                            "Worker emitted a diagnostic; private content omitted",
                        );
                    }
                    for record in update.records {
                        if self.worker_record(record).is_err() {
                            self.failed();
                            break;
                        }
                    }
                    if update.exited && !self.finished && self.worker.is_some() {
                        self.failed();
                    }
                }
                Err(_) => self.failed(),
            }
        }
        if self.worker.is_some()
            && self.handshake.is_none()
            && self.started.elapsed() > Duration::from_secs(10)
        {
            self.failed();
        }
        if self.retry_at.is_some_and(|t| Instant::now() >= t) {
            self.retry_at = None;
            self.restarts.push_back(Instant::now());
            match Worker::spawn(&self.config, &self.lock) {
                Ok(worker) => {
                    self.worker = Some(worker);
                    self.started = Instant::now();
                }
                Err(_) => self.failed(),
            }
        }
        self.release();
        if let Some((client, id)) = &self.shutdown
            && !self
                .pending
                .values()
                .any(|p| mutation(&p.method) || p.method == "server.shutdown")
        {
            let (client, id) = (*client, id.clone());
            self.forward(client, Request::new(id, "server.shutdown", json!({})));
        }
        std::mem::take(&mut self.deliveries)
    }

    pub fn close(&mut self) {
        if let Some(mut worker) = self.worker.take() {
            worker.close();
        }
    }

    fn release(&mut self) {
        if self.release_requests.is_empty() && self.release_watches.is_empty() {
            return;
        }
        if let Some(worker) = self.worker.as_mut() {
            self.next_id += 1;
            let request = json!({"jsonrpc":"2.0","id":format!("_release{}",self.next_id),"method":"worker.release","params":{"request_ids":self.release_requests,"watch_ids":self.release_watches}});
            if worker.send(request).is_ok() {
                self.pending.retain(|id, p| {
                    !self.release_requests.contains(id)
                        || mutation(&p.method)
                        || p.method == "session.watch"
                        || p.method.starts_with("server.")
                });
                self.release_requests.clear();
                self.release_watches.clear();
            }
        }
    }
}
