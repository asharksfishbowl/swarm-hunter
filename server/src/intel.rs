use axum::extract::State;
use axum::Json;
use chrono::{DateTime, Duration as Days, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::watch::host;

const PER_FEED: usize = 250;
const MAX_BYTES: usize = 4 * 1024 * 1024;
const REFRESH_HOURS: u64 = 6;

struct Feed {
    id: &'static str,
    name: &'static str,
    kind: &'static str,
    about: &'static str,
    home: &'static str,
    license: &'static str,
}

const FEEDS: [Feed; 3] = [
    Feed {
        id: "openphish",
        name: "OpenPhish",
        kind: "phishing",
        about: "Live phishing pages, community feed",
        home: "https://openphish.com",
        license: "OpenPhish community feed, free for non-commercial use",
    },
    Feed {
        id: "scamsniffer",
        name: "ScamSniffer",
        kind: "wallet",
        about: "Crypto wallet-drainer and fake airdrop sites, newest daily list (published 7 days late)",
        home: "https://github.com/scamsniffer/scam-database",
        license: "ScamSniffer scam-database, GPL-3.0",
    },
    Feed {
        id: "urlhaus",
        name: "URLhaus",
        kind: "installer",
        about: "Malware download links from abuse.ch (needs HUNTER_URLHAUS_KEY)",
        home: "https://urlhaus.abuse.ch",
        license: "abuse.ch URLhaus, CC0",
    },
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Indicator {
    pub source: String,
    pub url: String,
    pub host: String,
    pub kind: String,
    pub listed: String,
    pub reference: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct FeedState {
    id: String,
    fetched_at: Option<DateTime<Utc>>,
    error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Stored {
    indicators: Vec<Indicator>,
    feeds: Vec<FeedState>,
}

#[derive(Clone)]
pub struct Intel {
    path: PathBuf,
    inner: Arc<Mutex<Stored>>,
    pulling: Arc<tokio::sync::Mutex<()>>,
}

impl Intel {
    pub fn open(root: &Path) -> Self {
        let path = root.join("data/intel.json");
        let stored = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        let intel = Self {
            path,
            inner: Arc::new(Mutex::new(stored)),
            pulling: Arc::new(tokio::sync::Mutex::new(())),
        };
        if crate::setting("FEEDS").as_deref() != Some("off") {
            let worker = intel.clone();
            tokio::spawn(async move {
                loop {
                    if worker.stale() {
                        worker.pull().await;
                    }
                    tokio::time::sleep(Duration::from_secs(30 * 60)).await;
                }
            });
        }
        intel
    }

    fn stale(&self) -> bool {
        let inner = self.inner.lock().expect("intel");
        let newest = inner.feeds.iter().filter_map(|f| f.fetched_at).max();
        newest.is_none_or(|at| Utc::now() - at > Days::hours(REFRESH_HOURS as i64))
    }

    pub fn indicators(&self) -> Vec<Indicator> {
        self.inner.lock().expect("intel").indicators.clone()
    }

    pub async fn pull(&self) {
        let Ok(_guard) = self.pulling.try_lock() else {
            return;
        };
        let client = match reqwest::Client::builder()
            .user_agent(concat!("swarm-hunter/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(90))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.url().scheme() == "https" && attempt.previous().len() < 5 {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
        {
            Ok(client) => client,
            Err(_) => return,
        };
        for feed in &FEEDS {
            let result = match feed.id {
                "openphish" => openphish(&client).await,
                "scamsniffer" => scamsniffer(&client).await,
                _ => urlhaus(&client).await,
            };
            let mut inner = self.inner.lock().expect("intel");
            let error = result.as_ref().err().cloned().unwrap_or_default();
            match result {
                Ok(found) => {
                    inner.indicators.retain(|i| i.source != feed.id);
                    inner.indicators.extend(found);
                }
                Err(_) if error.contains("is not set") => {
                    inner.indicators.retain(|i| i.source != feed.id);
                }
                Err(_) => {}
            }
            inner.feeds.retain(|f| f.id != feed.id);
            inner.feeds.push(FeedState {
                id: feed.id.into(),
                fetched_at: Some(Utc::now()),
                error,
            });
        }
        let inner = self.inner.lock().expect("intel");
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = self.path.with_extension("json.tmp");
        if fs::write(&tmp, serde_json::to_string(&*inner).unwrap_or_default()).is_ok() {
            let _ = fs::rename(&tmp, &self.path);
        }
    }

    pub fn view(&self) -> Value {
        let inner = self.inner.lock().expect("intel");
        let feeds: Vec<Value> = FEEDS
            .iter()
            .map(|feed| {
                let state = inner.feeds.iter().find(|f| f.id == feed.id);
                json!({
                    "id": feed.id,
                    "name": feed.name,
                    "kind": feed.kind,
                    "about": feed.about,
                    "home": feed.home,
                    "license": feed.license,
                    "fetched_at": state.and_then(|s| s.fetched_at),
                    "count": inner.indicators.iter().filter(|i| i.source == feed.id).count(),
                    "error": state.map(|s| s.error.clone()).unwrap_or_default(),
                })
            })
            .collect();
        json!({ "feeds": feeds, "total": inner.indicators.len() })
    }
}

fn indicator(
    feed: &str,
    url: &str,
    listed: String,
    reference: String,
    tags: Vec<String>,
) -> Option<Indicator> {
    let kind = FEEDS.iter().find(|f| f.id == feed)?.kind;
    let host = host(url)?.to_lowercase();
    Some(Indicator {
        source: feed.into(),
        url: url.chars().take(500).collect(),
        host,
        kind: kind.into(),
        listed,
        reference,
        tags,
    })
}

fn keep_unique(items: impl IntoIterator<Item = Indicator>) -> Vec<Indicator> {
    let mut seen = BTreeSet::new();
    items
        .into_iter()
        .filter(|i| seen.insert(i.host.clone()))
        .take(PER_FEED)
        .collect()
}

async fn limited(mut response: reqwest::Response) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|n| n as usize > MAX_BYTES)
    {
        return Err("The feed was larger than expected, so it was skipped.".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BYTES {
            return Err("The feed was larger than expected, so it was skipped.".into());
        }
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

async fn text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let response = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("{url} answered {}", response.status()));
    }
    limited(response).await
}

async fn openphish(client: &reqwest::Client) -> Result<Vec<Indicator>, String> {
    let body = text(client, "https://openphish.com/feed.txt").await?;
    let today = Utc::now().date_naive().to_string();
    let found = keep_unique(
        body.lines()
            .map(str::trim)
            .filter(|l| l.starts_with("http"))
            .filter_map(|url| {
                indicator(
                    "openphish",
                    url,
                    today.clone(),
                    "https://openphish.com".into(),
                    Vec::new(),
                )
            }),
    );
    if found.is_empty() {
        return Err("The OpenPhish feed was empty.".into());
    }
    Ok(found)
}

#[derive(Deserialize)]
struct DailyList {
    domains: Vec<String>,
}

async fn scamsniffer(client: &reqwest::Client) -> Result<Vec<Indicator>, String> {
    for back in 6..=16 {
        let day = (Utc::now() - Days::days(back)).date_naive().to_string();
        let url = format!(
            "https://raw.githubusercontent.com/scamsniffer/scam-database/main/blacklist/archive/{day}.json"
        );
        let Ok(body) = text(client, &url).await else {
            continue;
        };
        let list: DailyList = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let found = keep_unique(list.domains.iter().filter_map(|domain| {
            indicator(
                "scamsniffer",
                &format!("https://{}", domain.trim()),
                day.clone(),
                url.clone(),
                Vec::new(),
            )
        }));
        if !found.is_empty() {
            return Ok(found);
        }
    }
    Err("No ScamSniffer daily list was found for the last two weeks.".into())
}

#[derive(Deserialize)]
struct UrlhausReply {
    query_status: String,
    #[serde(default)]
    urls: Vec<UrlhausUrl>,
}

#[derive(Deserialize)]
struct UrlhausUrl {
    url: String,
    #[serde(default)]
    date_added: String,
    #[serde(default)]
    urlhaus_reference: String,
    #[serde(default)]
    tags: Option<Vec<String>>,
}

async fn urlhaus(client: &reqwest::Client) -> Result<Vec<Indicator>, String> {
    let Some(key) = crate::setting("URLHAUS_KEY").filter(|k| !k.trim().is_empty()) else {
        return Err(
            "HUNTER_URLHAUS_KEY is not set. Get a free key at https://auth.abuse.ch.".into(),
        );
    };
    let response = client
        .get(format!(
            "https://urlhaus-api.abuse.ch/v1/urls/recent/limit/{PER_FEED}/"
        ))
        .header("Auth-Key", key.trim())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("URLhaus answered {}", response.status()));
    }
    let reply: UrlhausReply =
        serde_json::from_str(&limited(response).await?).map_err(|e| e.to_string())?;
    if reply.query_status != "ok" {
        return Err(format!("URLhaus said {}", reply.query_status));
    }
    Ok(keep_unique(reply.urls.into_iter().filter_map(|u| {
        indicator(
            "urlhaus",
            &u.url,
            u.date_added.chars().take(10).collect(),
            u.urlhaus_reference,
            u.tags.unwrap_or_default().into_iter().take(6).collect(),
        )
    })))
}

pub async fn status(State(intel): State<Intel>) -> Json<Value> {
    Json(intel.view())
}

pub async fn refresh(State(intel): State<Intel>) -> Json<Value> {
    intel.pull().await;
    Json(intel.view())
}
