use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path as FsPath, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use crate::store::Store;

const KINDS: [&str; 7] = [
    "injection",
    "installer",
    "wallet",
    "phishing",
    "impersonation",
    "benign",
    "other",
];
const MAX_RAW: usize = 64_000;
const MAX_INDICATORS: usize = 20;
const ECHO_WINDOW: usize = 40;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Indicators {
    pub urls: Vec<String>,
    pub addresses: Vec<String>,
    pub handles: Vec<String>,
    pub commands: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reading {
    pub kind: String,
    pub summary: String,
    pub indicators: Indicators,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Record {
    id: String,
    received_at: DateTime<Utc>,
    captured_at: DateTime<Utc>,
    platform: String,
    channel: String,
    url: String,
    sender: String,
    sha256: String,
    reading: Reading,
    raw: String,
    #[serde(skip)]
    sample: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Submission {
    at: DateTime<Utc>,
    channel: String,
    reference: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Case {
    id: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    title: String,
    summary: String,
    items: Vec<String>,
    submissions: Vec<Submission>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct State_ {
    kill_switch: bool,
    halted_reason: String,
    canaries: Vec<String>,
    overrides: HashMap<String, String>,
    cases: Vec<Case>,
}

struct Inner {
    state: State_,
    records: Vec<Record>,
    samples: Vec<Record>,
    reader_ok: bool,
}

#[derive(Clone)]
pub struct Watch {
    root: PathBuf,
    state_path: PathBuf,
    evidence_path: PathBuf,
    custody_path: PathBuf,
    inner: Arc<Mutex<Inner>>,
}

impl Watch {
    pub async fn open(root: &FsPath) -> Self {
        let state_path = root.join("data/watch.json");
        let evidence_path = root.join("data/evidence.jsonl");
        let custody_path = root.join("data/custody.log");
        let state = fs::read_to_string(&state_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<State_>(&raw).ok())
            .unwrap_or_else(|| State_ {
                kill_switch: false,
                halted_reason: String::new(),
                canaries: (0..3)
                    .map(|_| format!("molt-canary-{}", &Uuid::new_v4().simple().to_string()[..12]))
                    .collect(),
                overrides: HashMap::new(),
                cases: Vec::new(),
            });
        let records = fs::read_to_string(&evidence_path)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Record>(line).ok())
            .collect();
        let watch = Self {
            root: root.to_path_buf(),
            state_path,
            evidence_path,
            custody_path,
            inner: Arc::new(Mutex::new(Inner {
                state,
                records,
                samples: Vec::new(),
                reader_ok: false,
            })),
        };
        watch.save();
        watch.load_samples().await;
        watch
    }

    async fn load_samples(&self) {
        let raw = fs::read_to_string(self.root.join("watch/sample_swarm.json")).unwrap_or_default();
        let messages: Vec<Value> = serde_json::from_str(&raw).unwrap_or_default();
        let base = Utc::now() - chrono::Duration::hours(messages.len() as i64);
        let mut samples = Vec::new();
        let mut reader_ok = !messages.is_empty();
        for (index, message) in messages.iter().enumerate() {
            let text = message["raw"].as_str().unwrap_or_default().to_string();
            let reading = match self.read(&text).await {
                Ok(reading) => reading,
                Err(_) => {
                    reader_ok = false;
                    unread()
                }
            };
            let at = base + chrono::Duration::hours(index as i64);
            samples.push(Record {
                id: format!("sample-{index}"),
                received_at: at,
                captured_at: at,
                platform: message["platform"].as_str().unwrap_or("moltbook").into(),
                channel: message["channel"].as_str().unwrap_or_default().into(),
                url: String::new(),
                sender: message["sender"].as_str().unwrap_or("unknown").into(),
                sha256: hash(&text),
                reading,
                raw: text,
                sample: true,
            });
        }
        if messages.is_empty() {
            reader_ok = self.read("hello").await.is_ok();
        }
        let mut inner = self.inner.lock().expect("watch");
        inner.samples = samples;
        inner.reader_ok = reader_ok;
    }

    async fn read(&self, raw: &str) -> Result<Reading, String> {
        let python = std::env::var("WATCH_PYTHON").unwrap_or_else(|_| "python3".into());
        let script = self.root.join("watch/quarantine.py");
        let mut child = tokio::process::Command::new(python)
            .arg("-I")
            .arg(script)
            .env_clear()
            .env(
                "PATH",
                std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into()),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|err| format!("The quarantine reader did not start: {err}"))?;
        let input = json!({ "raw": raw }).to_string();
        let mut stdin = child.stdin.take().ok_or("no stdin")?;
        let mut stdout = child.stdout.take().ok_or("no stdout")?;
        let work = async move {
            stdin
                .write_all(input.as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            drop(stdin);
            let mut out = Vec::new();
            (&mut stdout)
                .take(256 * 1024)
                .read_to_end(&mut out)
                .await
                .map_err(|e| e.to_string())?;
            Ok::<Vec<u8>, String>(out)
        };
        let out = tokio::time::timeout(Duration::from_secs(5), work)
            .await
            .map_err(|_| "The quarantine reader timed out.".to_string())??;
        let _ = child.wait().await;
        let value: Value = serde_json::from_slice(&out).map_err(|_| {
            "The quarantine reader returned something that is not JSON.".to_string()
        })?;
        Ok(validate(&value))
    }

    fn save(&self) {
        let inner = self.inner.lock().expect("watch");
        self.write_state(&inner.state);
    }

    fn write_state(&self, state: &State_) {
        if let Some(parent) = self.state_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let raw = serde_json::to_string_pretty(state).unwrap_or_else(|_| "{}".into());
        let tmp = self.state_path.with_extension("json.tmp");
        if fs::write(&tmp, raw).is_ok() {
            let _ = fs::rename(&tmp, &self.state_path);
        }
    }

    fn append(path: &FsPath, line: &str) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{line}");
        }
    }

    fn custody(&self, action: &str, target: &str, detail: &str) {
        self.custody_as("operator", action, target, detail);
    }

    fn custody_as(&self, actor: &str, action: &str, target: &str, detail: &str) {
        let detail = detail.replace(['\t', '\n'], " ");
        Self::append(
            &self.custody_path,
            &format!(
                "{}\t{actor}\t{action}\t{target}\t{detail}",
                Utc::now().to_rfc3339()
            ),
        );
    }

    fn custody_for(&self, ids: &[String]) -> Vec<String> {
        fs::read_to_string(&self.custody_path)
            .unwrap_or_default()
            .lines()
            .filter(|line| {
                let target = line.split('\t').nth(3).unwrap_or_default();
                ids.iter().any(|id| id == target)
            })
            .map(str::to_string)
            .collect()
    }

    pub fn outbound_block(&self, text: &str) -> Option<String> {
        let mut inner = self.inner.lock().expect("watch");
        if inner.state.kill_switch {
            return Some(
                "The kill switch is on. Nothing leaves this agent until you turn it off on Watch."
                    .into(),
            );
        }
        let lowered = text.to_lowercase();
        if let Some(token) = inner
            .state
            .canaries
            .iter()
            .find(|token| lowered.contains(&token.to_lowercase()))
            .cloned()
        {
            inner.state.kill_switch = true;
            inner.state.halted_reason =
                format!("A canary token ({token}) appeared in an outgoing message.");
            self.write_state(&inner.state);
            drop(inner);
            self.custody_as(
                "system",
                "halt",
                "agent",
                &format!("canary {token} in outbound text"),
            );
            return Some("A canary token appeared in this message, so the agent has been halted. Check Watch.".into());
        }
        let outgoing = normalize(text);
        let chars: Vec<char> = outgoing.chars().collect();
        if chars.len() >= ECHO_WINDOW {
            let sources: Vec<String> = inner
                .records
                .iter()
                .chain(inner.samples.iter())
                .map(|record| normalize(&record.raw))
                .collect();
            for start in 0..=chars.len() - ECHO_WINDOW {
                let window: String = chars[start..start + ECHO_WINDOW].iter().collect();
                if sources.iter().any(|source| source.contains(&window)) {
                    return Some("That message repeats captured swarm text. Write it in your own words so the agent cannot carry a payload.".into());
                }
            }
        }
        None
    }

    fn effective_kind(state: &State_, record: &Record) -> String {
        state
            .overrides
            .get(&record.id)
            .cloned()
            .unwrap_or_else(|| record.reading.kind.clone())
    }

    fn view(state: &State_, record: &Record) -> Value {
        json!({
            "id": record.id,
            "received_at": record.received_at,
            "captured_at": record.captured_at,
            "platform": record.platform,
            "channel": record.channel,
            "url": record.url,
            "sender": record.sender,
            "sha256": record.sha256,
            "reading": record.reading,
            "kind": Self::effective_kind(state, record),
            "overridden": state.overrides.contains_key(&record.id),
            "cases": state.cases.iter().filter(|case| case.items.contains(&record.id)).map(|case| case.id.clone()).collect::<Vec<_>>(),
            "sample": record.sample,
        })
    }
}

pub struct Sighting {
    pub id: String,
    pub sender: String,
    pub platform: String,
    pub kind: String,
    pub score: f64,
    pub hosts: Vec<String>,
}

impl Watch {
    pub fn sightings(&self) -> (bool, Vec<Sighting>) {
        let inner = self.inner.lock().expect("watch");
        let sample = inner.records.is_empty();
        let records = if sample {
            &inner.samples
        } else {
            &inner.records
        };
        let list = records
            .iter()
            .map(|record| {
                let kind = Watch::effective_kind(&inner.state, record);
                let mut hosts: Vec<String> = Vec::new();
                let from_commands = record
                    .reading
                    .indicators
                    .commands
                    .iter()
                    .flat_map(|c| c.split_whitespace())
                    .filter(|part| part.contains("://"));
                for url in record
                    .reading
                    .indicators
                    .urls
                    .iter()
                    .map(String::as_str)
                    .chain(from_commands)
                {
                    if let Some(host) = host(url) {
                        if !hosts.contains(&host) {
                            hosts.push(host);
                        }
                    }
                }
                Sighting {
                    id: record.id.clone(),
                    sender: record.sender.clone(),
                    platform: record.platform.clone(),
                    score: severity(&kind) * record.reading.confidence.max(0.35),
                    kind,
                    hosts,
                }
            })
            .collect();
        (sample, list)
    }
}

fn unread() -> Reading {
    Reading {
        kind: "other".into(),
        summary: "The quarantine reader was unavailable. Review this item by hand.".into(),
        indicators: Indicators::default(),
        confidence: 0.0,
    }
}

fn validate(value: &Value) -> Reading {
    let kind = value["kind"]
        .as_str()
        .filter(|kind| KINDS.contains(kind))
        .unwrap_or("other")
        .to_string();
    let summary: String = value["summary"]
        .as_str()
        .unwrap_or("")
        .trim()
        .chars()
        .take(200)
        .collect();
    let list = |key: &str| -> Vec<String> {
        value["indicators"][key]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str())
                    .map(|item| item.trim().chars().take(200).collect::<String>())
                    .filter(|item| !item.is_empty())
                    .take(MAX_INDICATORS)
                    .collect()
            })
            .unwrap_or_default()
    };
    let confidence = value["confidence"]
        .as_f64()
        .filter(|c| c.is_finite())
        .unwrap_or(0.0)
        .clamp(0.0, 1.0);
    Reading {
        kind,
        summary,
        indicators: Indicators {
            urls: list("urls"),
            addresses: list("addresses"),
            handles: list("handles"),
            commands: list("commands"),
        },
        confidence,
    }
}

fn hash(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

fn normalize(text: &str) -> String {
    text.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn severity(kind: &str) -> f64 {
    match kind {
        "installer" => 1.0,
        "injection" | "phishing" => 0.9,
        "wallet" => 0.8,
        "impersonation" => 0.7,
        "other" => 0.3,
        _ => 0.0,
    }
}

pub fn host(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1)?;
    let host = rest
        .split(['/', '?', '#', ':'])
        .next()?
        .trim_end_matches('.')
        .to_lowercase();
    (!host.is_empty()).then_some(host)
}

fn fail(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

pub async fn status(State(watch): State<Watch>) -> Json<Value> {
    let inner = watch.inner.lock().expect("watch");
    Json(json!({
        "kill_switch": inner.state.kill_switch,
        "halted_reason": inner.state.halted_reason,
        "reader": if inner.reader_ok { "ready" } else { "unavailable" },
        "evidence_count": inner.records.len(),
        "case_count": inner.state.cases.len(),
        "canaries": inner.state.canaries,
    }))
}

#[derive(Deserialize)]
pub struct KillBody {
    engaged: bool,
}

pub async fn kill(State(watch): State<Watch>, Json(body): Json<KillBody>) -> Response {
    {
        let mut inner = watch.inner.lock().expect("watch");
        inner.state.kill_switch = body.engaged;
        inner.state.halted_reason = if body.engaged {
            "Turned on by the operator.".into()
        } else {
            String::new()
        };
        watch.write_state(&inner.state);
    }
    watch.custody(
        if body.engaged { "halt" } else { "resume" },
        "agent",
        "kill switch",
    );
    status(State(watch)).await.into_response()
}

#[derive(Deserialize)]
pub struct CaptureBody {
    platform: String,
    channel: Option<String>,
    url: Option<String>,
    sender: String,
    raw: String,
    received_at: Option<String>,
}

pub async fn capture(State(watch): State<Watch>, Json(body): Json<CaptureBody>) -> Response {
    let raw = body.raw.trim().to_string();
    if raw.is_empty() || raw.chars().count() > MAX_RAW {
        return fail(
            StatusCode::BAD_REQUEST,
            "Paste the message (1 to 64,000 characters).",
        );
    }
    let sender = body
        .sender
        .trim()
        .trim_start_matches(['@', '*'])
        .trim_end_matches('*')
        .to_string();
    if sender.is_empty() || sender.chars().count() > 64 {
        return fail(
            StatusCode::BAD_REQUEST,
            "Give the sender's public handle (up to 64 characters).",
        );
    }
    let platform = body.platform.trim().to_lowercase();
    if platform.is_empty() || platform.chars().count() > 32 {
        return fail(
            StatusCode::BAD_REQUEST,
            "Name the platform (up to 32 characters).",
        );
    }
    let url = body.url.unwrap_or_default().trim().to_string();
    if !url.is_empty()
        && (url.len() > 500 || !(url.starts_with("https://") || url.starts_with("http://")))
    {
        return fail(
            StatusCode::BAD_REQUEST,
            "The source link must start with https:// or http://.",
        );
    }
    let received_at = match body
        .received_at
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        Some(value) => match DateTime::parse_from_rfc3339(value) {
            Ok(at) => at.with_timezone(&Utc),
            Err(_) => {
                return fail(
                    StatusCode::BAD_REQUEST,
                    "The received time must be an ISO 8601 timestamp.",
                )
            }
        },
        None => Utc::now(),
    };
    let (reading, reader_ok) = match watch.read(&raw).await {
        Ok(reading) => (reading, true),
        Err(_) => (unread(), false),
    };
    let record = Record {
        id: Uuid::new_v4().to_string(),
        received_at,
        captured_at: Utc::now(),
        platform,
        channel: body
            .channel
            .unwrap_or_default()
            .trim()
            .chars()
            .take(120)
            .collect(),
        url,
        sender,
        sha256: hash(&raw),
        reading,
        raw,
        sample: false,
    };
    Watch::append(
        &watch.evidence_path,
        &serde_json::to_string(&record).unwrap_or_default(),
    );
    watch.custody("capture", &record.id, &format!("sha256 {}", record.sha256));
    let mut inner = watch.inner.lock().expect("watch");
    inner.reader_ok = reader_ok;
    inner.records.push(record.clone());
    Json(Watch::view(&inner.state, &record)).into_response()
}

pub async fn list(State(watch): State<Watch>) -> Json<Value> {
    let inner = watch.inner.lock().expect("watch");
    let mut items: Vec<&Record> = inner.records.iter().collect();
    items.sort_by(|a, b| b.received_at.cmp(&a.received_at));
    Json(json!({
        "items": items.iter().map(|record| Watch::view(&inner.state, record)).collect::<Vec<_>>(),
        "samples_in_map": inner.records.is_empty(),
    }))
}

#[derive(Deserialize)]
pub struct ClassifyBody {
    kind: String,
}

pub async fn classify(
    State(watch): State<Watch>,
    Path(id): Path<String>,
    Json(body): Json<ClassifyBody>,
) -> Response {
    if !KINDS.contains(&body.kind.as_str()) {
        return fail(StatusCode::BAD_REQUEST, "Unknown classification.");
    }
    let view = {
        let mut inner = watch.inner.lock().expect("watch");
        let Some(record) = inner.records.iter().find(|r| r.id == id).cloned() else {
            return fail(StatusCode::NOT_FOUND, "No evidence with that id.");
        };
        if record.reading.kind == body.kind {
            inner.state.overrides.remove(&id);
        } else {
            inner.state.overrides.insert(id.clone(), body.kind.clone());
        }
        watch.write_state(&inner.state);
        Watch::view(&inner.state, &record)
    };
    watch.custody("classify", &id, &body.kind);
    Json(view).into_response()
}

pub async fn raw(State(watch): State<Watch>, Path(id): Path<String>) -> Response {
    let found = {
        let inner = watch.inner.lock().expect("watch");
        inner
            .records
            .iter()
            .chain(inner.samples.iter())
            .find(|r| r.id == id)
            .map(|r| (r.raw.clone(), r.sample))
    };
    match found {
        Some((text, sample)) => {
            if !sample {
                watch.custody("view-raw", &id, "operator opened the original text");
            }
            Json(json!({ "raw": text })).into_response()
        }
        None => fail(StatusCode::NOT_FOUND, "No evidence with that id."),
    }
}

#[derive(Default)]
struct Node {
    label: String,
    kind: &'static str,
    threat: f64,
    kinds: BTreeMap<String, u32>,
    evidence: Vec<String>,
    platforms: Vec<String>,
    sent: u32,
}

pub async fn swarm(State(watch): State<Watch>, State(store): State<Store>) -> Json<Value> {
    let me = store.settings().agent_name;
    let inner = watch.inner.lock().expect("watch");
    let sample = inner.records.is_empty();
    let records = if sample {
        &inner.samples
    } else {
        &inner.records
    };
    let mut nodes: HashMap<String, Node> = HashMap::new();
    let mut links: HashMap<(String, String, &'static str), (u32, Vec<String>)> = HashMap::new();
    let self_id = "self".to_string();
    nodes.insert(
        self_id.clone(),
        Node {
            label: me,
            kind: "self",
            ..Default::default()
        },
    );

    for record in records.iter() {
        let kind = Watch::effective_kind(&inner.state, record);
        let score = severity(&kind) * record.reading.confidence.max(0.35);
        let sender_id = format!("agent:{}", record.sender.to_lowercase());
        let mut touch = |id: &str, label: &str, node_kind: &'static str, threat: Option<f64>| {
            let node = nodes.entry(id.to_string()).or_insert_with(|| Node {
                label: label.to_string(),
                kind: node_kind,
                ..Default::default()
            });
            if let Some(threat) = threat {
                node.threat = node.threat.max(threat);
                *node.kinds.entry(kind.clone()).or_default() += 1;
            }
            if !node.evidence.contains(&record.id) {
                node.evidence.push(record.id.clone());
            }
            if !node.platforms.contains(&record.platform) {
                node.platforms.push(record.platform.clone());
            }
        };
        touch(&sender_id, &record.sender, "agent", Some(score));
        let mut targets: Vec<(String, &'static str)> = vec![(self_id.clone(), "reached us")];
        for handle in &record.reading.indicators.handles {
            let id = format!("agent:{}", handle.to_lowercase());
            if id != sender_id {
                touch(&id, handle, "agent", None);
                targets.push((id, "mentions"));
            }
        }
        for address in &record.reading.indicators.addresses {
            let id = format!("address:{address}");
            let chars: Vec<char> = address.chars().collect();
            let label = if chars.len() > 14 {
                format!(
                    "{}…{}",
                    chars[..6].iter().collect::<String>(),
                    chars[chars.len() - 4..].iter().collect::<String>()
                )
            } else {
                address.clone()
            };
            touch(&id, &label, "address", Some(score));
            targets.push((id, "promotes"));
        }
        for url in &record.reading.indicators.urls {
            if let Some(host) = host(url) {
                let id = format!("domain:{host}");
                touch(&id, &host, "domain", Some(score));
                targets.push((id, "links to"));
            }
        }
        for command in &record.reading.indicators.commands {
            if let Some(url) = command.split_whitespace().find(|part| part.contains("://")) {
                if let Some(host) = host(url) {
                    let id = format!("domain:{host}");
                    touch(&id, &host, "domain", Some(score));
                    targets.push((id, "installs from"));
                }
            }
        }
        if let Some(node) = nodes.get_mut(&sender_id) {
            node.sent += 1;
        }
        for (target, link_kind) in targets {
            let entry = links
                .entry((sender_id.clone(), target, link_kind))
                .or_insert((0, Vec::new()));
            entry.0 += 1;
            if !entry.1.contains(&record.id) {
                entry.1.push(record.id.clone());
            }
        }
    }

    let items: Vec<Value> = records
        .iter()
        .map(|record| Watch::view(&inner.state, record))
        .collect();
    let node_list: Vec<Value> = nodes
        .into_iter()
        .map(|(id, node)| {
            let dominant = node
                .kinds
                .iter()
                .filter(|(kind, _)| kind.as_str() != "benign")
                .max_by(|a, b| a.1.cmp(b.1).then(severity(a.0).total_cmp(&severity(b.0))))
                .map(|(kind, _)| kind.clone())
                .unwrap_or_else(|| {
                    if node.kinds.contains_key("benign") {
                        "benign".into()
                    } else {
                        "unknown".into()
                    }
                });
            json!({
                "id": id,
                "label": node.label,
                "type": node.kind,
                "threat": (node.threat * 100.0).round() / 100.0,
                "dominant": if node.kind == "self" { "self".to_string() } else { dominant },
                "kinds": node.kinds,
                "evidence": node.evidence,
                "platforms": node.platforms,
                "sent": node.sent,
            })
        })
        .collect();
    let link_list: Vec<Value> = links
        .into_iter()
        .map(|((source, target, kind), (weight, evidence))| {
            json!({ "source": source, "target": target, "kind": kind, "weight": weight, "evidence": evidence })
        })
        .collect();
    Json(json!({
        "sample": sample,
        "generated_at": Utc::now(),
        "nodes": node_list,
        "links": link_list,
        "items": items,
    }))
}

fn case_view(case: &Case) -> Value {
    json!({
        "id": case.id,
        "created_at": case.created_at,
        "updated_at": case.updated_at,
        "title": case.title,
        "summary": case.summary,
        "items": case.items,
        "submissions": case.submissions,
    })
}

pub async fn cases(State(watch): State<Watch>) -> Json<Value> {
    let inner = watch.inner.lock().expect("watch");
    let mut list: Vec<&Case> = inner.state.cases.iter().collect();
    list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Json(json!({ "cases": list.iter().map(|case| case_view(case)).collect::<Vec<_>>() }))
}

#[derive(Deserialize)]
pub struct NewCase {
    title: String,
    summary: Option<String>,
    items: Option<Vec<String>>,
}

pub async fn create_case(State(watch): State<Watch>, Json(body): Json<NewCase>) -> Response {
    let title = body.title.trim().to_string();
    if title.is_empty() || title.chars().count() > 160 {
        return fail(
            StatusCode::BAD_REQUEST,
            "A case needs a title (up to 160 characters).",
        );
    }
    let view = {
        let mut inner = watch.inner.lock().expect("watch");
        let known: Vec<String> = inner.records.iter().map(|r| r.id.clone()).collect();
        let now = Utc::now();
        let case = Case {
            id: Uuid::new_v4().to_string(),
            created_at: now,
            updated_at: now,
            title,
            summary: body
                .summary
                .unwrap_or_default()
                .trim()
                .chars()
                .take(4000)
                .collect(),
            items: body
                .items
                .unwrap_or_default()
                .into_iter()
                .filter(|id| known.contains(id))
                .collect(),
            submissions: Vec::new(),
        };
        inner.state.cases.push(case.clone());
        watch.write_state(&inner.state);
        case_view(&case)
    };
    let case_id = view["id"].as_str().unwrap_or_default();
    watch.custody(
        "open-case",
        case_id,
        view["title"].as_str().unwrap_or_default(),
    );
    for item in view["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        watch.custody("add-to-case", item, &format!("case {case_id}"));
    }
    Json(view).into_response()
}

#[derive(Deserialize)]
pub struct PatchCase {
    title: Option<String>,
    summary: Option<String>,
    add_items: Option<Vec<String>>,
    remove_items: Option<Vec<String>>,
    submission: Option<NewSubmission>,
}

#[derive(Deserialize)]
pub struct NewSubmission {
    channel: String,
    reference: Option<String>,
}

pub async fn update_case(
    State(watch): State<Watch>,
    Path(id): Path<String>,
    Json(body): Json<PatchCase>,
) -> Response {
    let mut events = Vec::new();
    let view = {
        let mut inner = watch.inner.lock().expect("watch");
        let known: Vec<String> = inner.records.iter().map(|r| r.id.clone()).collect();
        let Some(case) = inner.state.cases.iter_mut().find(|c| c.id == id) else {
            return fail(StatusCode::NOT_FOUND, "No case with that id.");
        };
        if let Some(title) = body
            .title
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
        {
            case.title = title.chars().take(160).collect();
        }
        if let Some(summary) = body.summary {
            case.summary = summary.trim().chars().take(4000).collect();
        }
        for item in body.add_items.unwrap_or_default() {
            if known.contains(&item) && !case.items.contains(&item) {
                events.push(("add-to-case", item.clone()));
                case.items.push(item);
            }
        }
        for item in body.remove_items.unwrap_or_default() {
            if case.items.contains(&item) {
                events.push(("remove-from-case", item.clone()));
                case.items.retain(|existing| existing != &item);
            }
        }
        if let Some(submission) = body.submission {
            let channel = submission.channel.trim().to_string();
            if channel.is_empty() {
                return fail(StatusCode::BAD_REQUEST, "Say where the case was submitted.");
            }
            case.submissions.push(Submission {
                at: Utc::now(),
                channel: channel.chars().take(120).collect(),
                reference: submission
                    .reference
                    .unwrap_or_default()
                    .trim()
                    .chars()
                    .take(200)
                    .collect(),
            });
            events.push(("submitted", channel));
        }
        case.updated_at = Utc::now();
        let case = case.clone();
        watch.write_state(&inner.state);
        case_view(&case)
    };
    for (action, detail) in events {
        if action == "submitted" {
            watch.custody(action, &id, &detail);
        } else {
            watch.custody(action, &detail, &format!("case {id}"));
        }
    }
    Json(view).into_response()
}

fn case_bundle(watch: &Watch, id: &str) -> Option<(Case, Vec<(Record, String)>)> {
    let inner = watch.inner.lock().expect("watch");
    let case = inner.state.cases.iter().find(|c| c.id == id)?.clone();
    let mut records: Vec<(Record, String)> = inner
        .records
        .iter()
        .filter(|r| case.items.contains(&r.id))
        .map(|r| (r.clone(), Watch::effective_kind(&inner.state, r)))
        .collect();
    records.sort_by(|a, b| a.0.received_at.cmp(&b.0.received_at));
    Some((case, records))
}

pub async fn export_case(State(watch): State<Watch>, Path(id): Path<String>) -> Response {
    let Some((case, records)) = case_bundle(&watch, &id) else {
        return fail(StatusCode::NOT_FOUND, "No case with that id.");
    };
    watch.custody("export", &id, "markdown");
    let mut ids: Vec<String> = records.iter().map(|(r, _)| r.id.clone()).collect();
    ids.push(id.clone());
    let mut out = format!(
        "# {}\n\nCase `{}` · opened {} · exported {}\n\n## Summary\n\n{}\n\n## How this was collected\n\nCaptured passively by an operated observer agent. The agent did not ask for money or information. Each item's SHA-256 was recorded at capture; recompute it over the original text below to confirm nothing was altered.\n",
        case.title,
        case.id,
        case.created_at.format("%Y-%m-%d %H:%M UTC"),
        Utc::now().format("%Y-%m-%d %H:%M UTC"),
        if case.summary.is_empty() { "(No summary written.)" } else { &case.summary },
    );
    if !case.submissions.is_empty() {
        out.push_str("\n## Submitted to\n\n");
        for s in &case.submissions {
            out.push_str(&format!(
                "- {} · {}{}\n",
                s.at.format("%Y-%m-%d %H:%M UTC"),
                s.channel,
                if s.reference.is_empty() {
                    String::new()
                } else {
                    format!(" · ref {}", s.reference)
                }
            ));
        }
    }
    out.push_str("\n## Timeline\n");
    for (index, (r, kind)) in records.iter().enumerate() {
        let ind = &r.reading.indicators;
        let fence = "~".repeat(4 + r.raw.matches("~~~~").count().min(1) * 4);
        out.push_str(&format!(
            "\n### {}. {} · {} from {}\n\n- Received: {}\n- Where: {}{}{}\n- Classified: {} (reader confidence {:.2})\n- Reader summary: {}\n- SHA-256: `{}`\n",
            index + 1,
            r.received_at.format("%Y-%m-%d %H:%M UTC"),
            kind,
            r.sender,
            r.received_at.to_rfc3339(),
            r.platform,
            if r.channel.is_empty() { String::new() } else { format!(" / {}", r.channel) },
            if r.url.is_empty() { String::new() } else { format!(" · {}", r.url) },
            kind,
            r.reading.confidence,
            r.reading.summary,
            r.sha256,
        ));
        for (label, values) in [
            ("Addresses", &ind.addresses),
            ("Links", &ind.urls),
            ("Commands", &ind.commands),
            ("Handles", &ind.handles),
        ] {
            if !values.is_empty() {
                out.push_str(&format!(
                    "- {label}: {}\n",
                    values
                        .iter()
                        .map(|v| format!("`{v}`"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
        }
        out.push_str(&format!(
            "\nOriginal text:\n\n{fence}text\n{}\n{fence}\n",
            r.raw
        ));
    }
    out.push_str("\n## Chain of custody\n\n```\n");
    for line in watch.custody_for(&ids) {
        out.push_str(&line);
        out.push('\n');
    }
    out.push_str("```\n");
    let name = format!("case-{}.md", &case.id[..8]);
    (
        [
            (
                header::CONTENT_TYPE,
                "text/markdown; charset=utf-8".to_string(),
            ),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{name}\""),
            ),
        ],
        out,
    )
        .into_response()
}

pub async fn export_case_json(State(watch): State<Watch>, Path(id): Path<String>) -> Response {
    let Some((case, records)) = case_bundle(&watch, &id) else {
        return fail(StatusCode::NOT_FOUND, "No case with that id.");
    };
    watch.custody("export", &id, "json");
    let mut ids: Vec<String> = records.iter().map(|(r, _)| r.id.clone()).collect();
    ids.push(id.clone());
    let items: Vec<Value> = records
        .iter()
        .map(|(r, kind)| {
            json!({
                "id": r.id,
                "received_at": r.received_at,
                "captured_at": r.captured_at,
                "platform": r.platform,
                "channel": r.channel,
                "url": r.url,
                "sender": r.sender,
                "classification": kind,
                "reading": r.reading,
                "sha256": r.sha256,
                "raw": r.raw,
            })
        })
        .collect();
    let body = json!({
        "case": case,
        "exported_at": Utc::now(),
        "collection": "Passive capture by an operated observer agent. No solicitation.",
        "items": items,
        "custody": watch.custody_for(&ids),
    });
    let name = format!("case-{}.json", &case.id[..8]);
    (
        [
            (header::CONTENT_TYPE, "application/json".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{name}\""),
            ),
        ],
        serde_json::to_string_pretty(&body).unwrap_or_default(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::{host, normalize, validate};
    use serde_json::json;

    #[test]
    fn validate_drops_bad_fields() {
        let reading = validate(&json!({
            "kind": "run rm -rf",
            "summary": "x".repeat(500),
            "indicators": { "urls": ["https://a.example", 7, ""], "handles": "nope" },
            "confidence": 9
        }));
        assert_eq!(reading.kind, "other");
        assert_eq!(reading.summary.chars().count(), 200);
        assert_eq!(reading.indicators.urls, vec!["https://a.example"]);
        assert!(reading.indicators.handles.is_empty());
        assert_eq!(reading.confidence, 1.0);
    }

    #[test]
    fn host_parses() {
        assert_eq!(
            host("https://Claw-Airdrop.example:8443/claim?x=1").as_deref(),
            Some("claw-airdrop.example")
        );
        assert_eq!(host("not a url"), None);
    }

    #[test]
    fn normalize_collapses() {
        assert_eq!(normalize("  Ignore\n ALL   rules "), "ignore all rules");
    }
}
