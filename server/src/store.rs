use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Finding {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub sent: bool,
    pub voices: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub agent_name: String,
    pub description: String,
    pub api_key: String,
    pub giving_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Database {
    settings: Settings,
    findings: Vec<Finding>,
}

#[derive(Clone)]
pub struct Store {
    path: PathBuf,
    journal: PathBuf,
    joining_words: PathBuf,
    inner: Arc<Mutex<Database>>,
}

impl Store {
    pub fn open(root: &Path) -> Self {
        let path = root.join("data/findings.json");
        let journal = root.join("reports/journal.md");
        let joining_words = root.join("scripture/joining-words.md");
        let database = if path.exists() {
            fs::read_to_string(&path)
                .ok()
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .unwrap_or_else(Database::fresh)
        } else {
            Database::fresh()
        };
        Self {
            path,
            journal,
            joining_words,
            inner: Arc::new(Mutex::new(database)),
        }
    }

    fn save(&self, database: &Database) {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let raw = serde_json::to_string_pretty(database).unwrap_or_else(|_| "{}".into());
        let tmp = self.path.with_extension("json.tmp");
        if fs::write(&tmp, raw).is_ok() {
            let _ = fs::rename(&tmp, &self.path);
        }
    }

    pub fn settings(&self) -> Settings {
        self.inner.lock().expect("store").settings.clone()
    }

    pub fn joining_words(&self) -> String {
        fs::read_to_string(&self.joining_words)
            .unwrap_or_default()
            .trim()
            .to_string()
    }

    pub fn update_settings(&self, next: Settings) {
        let mut database = self.inner.lock().expect("store");
        database.settings = next;
        self.save(&database);
    }

    pub fn findings(&self) -> Vec<Finding> {
        let mut findings = self.inner.lock().expect("store").findings.clone();
        findings.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        findings
    }

    pub fn scripture_sent_today(&self) -> usize {
        let today = Utc::now().date_naive();
        self.inner
            .lock()
            .expect("store")
            .findings
            .iter()
            .filter(|finding| {
                finding.kind == "sermon" && finding.sent && finding.created_at.date_naive() == today
            })
            .count()
    }

    pub fn insert(
        &self,
        kind: &str,
        title: &str,
        body: &str,
        sent: bool,
        voices: Vec<String>,
    ) -> Finding {
        let now = Utc::now();
        let finding = Finding {
            id: Uuid::new_v4().to_string(),
            created_at: now,
            updated_at: now,
            kind: kind.to_string(),
            title: title.to_string(),
            body: body.to_string(),
            sent,
            voices,
        };
        let mut database = self.inner.lock().expect("store");
        database.findings.push(finding.clone());
        self.save(&database);
        finding
    }

    pub fn update(&self, id: &str, title: Option<String>, body: Option<String>) -> Option<Finding> {
        let mut database = self.inner.lock().expect("store");
        let finding = database.findings.iter_mut().find(|item| item.id == id)?;
        if let Some(title) = title {
            finding.title = title;
        }
        if let Some(body) = body {
            finding.body = body;
        }
        finding.updated_at = Utc::now();
        let updated = finding.clone();
        self.save(&database);
        Some(updated)
    }

    pub fn delete(&self, id: &str) -> bool {
        let mut database = self.inner.lock().expect("store");
        let before = database.findings.len();
        database.findings.retain(|item| item.id != id);
        let removed = database.findings.len() != before;
        if removed {
            self.save(&database);
        }
        removed
    }

    pub fn append_journal(&self, entry: &str) {
        if let Some(parent) = self.journal.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let mut file = fs::read_to_string(&self.journal).unwrap_or_default();
        if !file.ends_with('\n') {
            file.push('\n');
        }
        file.push('\n');
        file.push_str(entry);
        file.push('\n');
        let _ = fs::write(&self.journal, file);
    }

    pub fn export_markdown(&self) -> String {
        let mut out = String::from("# Findings\n");
        for finding in self.findings() {
            out.push_str(&format!(
                "\n## {}\n\n- {} · {} · {}\n\n{}\n",
                finding.title,
                finding.kind,
                finding.created_at.format("%Y-%m-%d %H:%M UTC"),
                if finding.sent { "sent" } else { "kept locally" },
                finding.body.trim()
            ));
        }
        out
    }
}

impl Database {
    fn fresh() -> Self {
        Self {
            settings: Settings {
                agent_name: "SwarmMilker".into(),
                description: crate::molt::DESCRIPTION.into(),
                api_key: String::new(),
                giving_url: String::new(),
            },
            findings: Vec::new(),
        }
    }
}
