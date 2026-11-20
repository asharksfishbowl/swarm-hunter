use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Duration as Span, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::fs;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::geo::Geo;

const KEEP: usize = 2000;
const MERGE_MINUTES: i64 = 10;
const FAIL_LIMIT: usize = 5;
const FAIL_WINDOW_MINUTES: i64 = 15;
const LOCK_MINUTES: i64 = 15;

const PROBES: [&str; 32] = [
    "/.env",
    "/.git",
    "/.aws",
    "/.ssh",
    "/.svn",
    "/.ds_store",
    "/.vscode",
    "/wp-",
    "/wordpress",
    "/xmlrpc",
    "/phpmyadmin",
    "/pma",
    "/cgi-bin",
    "/actuator",
    "/server-status",
    "/admin",
    "/administrator",
    "/boaform",
    "/hnap1",
    "/owa",
    "/solr",
    "/vendor/",
    "/config",
    "/console",
    "/debug",
    "/telescope",
    "/_ignition",
    "/autodiscover",
    "/manager/html",
    "/shell",
    "/backup",
    "/.well-known/security.txt.bak",
];
const PROBE_SUFFIXES: [&str; 8] = [
    ".php", ".asp", ".aspx", ".jsp", ".cgi", ".sql", ".bak", ".zip",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
    pub at: DateTime<Utc>,
    pub last_at: DateTime<Utc>,
    pub kind: String,
    pub severity: String,
    pub source: String,
    pub ip: String,
    pub country: String,
    pub country_code: String,
    pub org: String,
    pub method: String,
    pub path: String,
    pub user_agent: String,
    pub detail: String,
    pub count: u32,
}

#[derive(Default)]
struct Inner {
    events: VecDeque<Event>,
    failures: HashMap<String, Vec<DateTime<Utc>>>,
    locked: HashMap<String, DateTime<Utc>>,
}

#[derive(Clone)]
pub struct Defense {
    path: PathBuf,
    geo: Geo,
    inner: Arc<Mutex<Inner>>,
    dirty: Arc<AtomicBool>,
}

pub struct Origin {
    pub ip: String,
    pub method: String,
    pub path: String,
    pub user_agent: String,
}

impl Defense {
    pub fn open(root: &Path, geo: Geo) -> Self {
        let path = root.join("data/defense.json");
        let events: VecDeque<Event> = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        let defense = Self {
            path,
            geo,
            inner: Arc::new(Mutex::new(Inner {
                events,
                ..Inner::default()
            })),
            dirty: Arc::new(AtomicBool::new(false)),
        };
        let writer = defense.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                if writer.dirty.swap(false, Ordering::Relaxed) {
                    writer.save();
                }
            }
        });
        defense
    }

    fn save(&self) {
        let raw = {
            let inner = self.inner.lock().expect("defense");
            serde_json::to_string(&inner.events).unwrap_or_else(|_| "[]".into())
        };
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = self.path.with_extension("json.tmp");
        if fs::write(&tmp, raw).is_ok() {
            let _ = fs::rename(&tmp, &self.path);
        }
    }

    fn record(
        &self,
        kind: &str,
        severity: &str,
        source: &str,
        origin: Option<&Origin>,
        detail: &str,
    ) {
        let now = Utc::now();
        let (ip, method, path, user_agent) = origin
            .map(|o| {
                (
                    o.ip.clone(),
                    o.method.clone(),
                    o.path.clone(),
                    o.user_agent.clone(),
                )
            })
            .unwrap_or_default();
        let mut inner = self.inner.lock().expect("defense");
        if let Some(last) = inner.events.iter_mut().rev().take(50).find(|e| {
            e.kind == kind
                && e.ip == ip
                && e.path == path
                && e.detail == detail
                && now - e.last_at < Span::minutes(MERGE_MINUTES)
        }) {
            last.count += 1;
            last.last_at = now;
            self.dirty.store(true, Ordering::Relaxed);
            return;
        }
        let (country, country_code, org) = ip
            .parse::<IpAddr>()
            .ok()
            .map(|addr| self.geo.who_is(addr))
            .unwrap_or_default();
        inner.events.push_back(Event {
            id: uuid::Uuid::new_v4().simple().to_string()[..12].to_string(),
            at: now,
            last_at: now,
            kind: kind.into(),
            severity: severity.into(),
            source: source.into(),
            ip,
            country,
            country_code,
            org,
            method,
            path: path.chars().take(200).collect(),
            user_agent: user_agent.chars().take(200).collect(),
            detail: detail.chars().take(300).collect(),
            count: 1,
        });
        while inner.events.len() > KEEP {
            inner.events.pop_front();
        }
        self.dirty.store(true, Ordering::Relaxed);
    }

    pub fn agent(&self, kind: &str, severity: &str, detail: &str) {
        self.record(kind, severity, "agent", None, detail);
    }

    fn network(&self, kind: &str, severity: &str, origin: &Origin, detail: &str) {
        self.record(kind, severity, "network", Some(origin), detail);
    }

    pub fn locked_until(&self, ip: &str) -> Option<DateTime<Utc>> {
        let mut inner = self.inner.lock().expect("defense");
        match inner.locked.get(ip).copied() {
            Some(until) if until > Utc::now() => Some(until),
            Some(_) => {
                inner.locked.remove(ip);
                None
            }
            None => None,
        }
    }

    pub fn failed_credential(&self, origin: &Origin, how: &str) {
        let now = Utc::now();
        let locked = {
            let mut inner = self.inner.lock().expect("defense");
            let tries = inner.failures.entry(origin.ip.clone()).or_default();
            tries.retain(|at| now - *at < Span::minutes(FAIL_WINDOW_MINUTES));
            tries.push(now);
            if tries.len() >= FAIL_LIMIT {
                tries.clear();
                inner
                    .locked
                    .insert(origin.ip.clone(), now + Span::minutes(LOCK_MINUTES));
                true
            } else {
                false
            }
        };
        self.network("failed-sign-in", "medium", origin, how);
        if locked {
            self.network(
                "locked-out",
                "high",
                origin,
                &format!("{FAIL_LIMIT} wrong tokens in {FAIL_WINDOW_MINUTES} minutes; sign-in refused for {LOCK_MINUTES} minutes"),
            );
        }
    }

    pub fn denied(&self, origin: &Origin) {
        self.network(
            "unauthorized",
            "low",
            origin,
            "API call without a valid session",
        );
    }

    pub fn signed_in(&self, origin: &Origin) {
        self.inner
            .lock()
            .expect("defense")
            .failures
            .remove(&origin.ip);
        self.network("signed-in", "info", origin, "Operator signed in");
    }

    pub fn serious_last_day(&self) -> usize {
        let now = Utc::now();
        self.inner
            .lock()
            .expect("defense")
            .events
            .iter()
            .filter(|e| {
                matches!(e.severity.as_str(), "high" | "critical")
                    && now - e.last_at < Span::hours(24)
            })
            .count()
    }

    fn view(&self) -> Value {
        let inner = self.inner.lock().expect("defense");
        let now = Utc::now();
        let day: Vec<&Event> = inner
            .events
            .iter()
            .filter(|e| now - e.last_at < Span::hours(24))
            .collect();
        let mut by_kind: BTreeMap<&str, u32> = BTreeMap::new();
        for e in &day {
            *by_kind.entry(e.kind.as_str()).or_default() += e.count;
        }
        let ips: BTreeSet<&str> = day
            .iter()
            .filter(|e| e.source == "network" && e.kind != "signed-in" && !e.ip.is_empty())
            .map(|e| e.ip.as_str())
            .collect();
        let locked: Vec<Value> = inner
            .locked
            .iter()
            .filter(|(_, until)| **until > now)
            .map(|(ip, until)| json!({ "ip": ip, "until": until }))
            .collect();
        let mut events: Vec<&Event> = inner.events.iter().collect();
        events.sort_by_key(|e| std::cmp::Reverse(e.last_at));
        json!({
            "events": events.into_iter().take(500).collect::<Vec<_>>(),
            "last_day": {
                "by_kind": by_kind,
                "hostile_ips": ips.len(),
                "serious": day.iter().filter(|e| matches!(e.severity.as_str(), "high" | "critical")).count(),
            },
            "locked": locked,
        })
    }
}

fn is_private(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
    }
}

fn parse_ip(raw: &str) -> Option<IpAddr> {
    let raw = raw.trim().trim_matches('"');
    raw.parse::<IpAddr>()
        .ok()
        .or_else(|| raw.parse::<SocketAddr>().ok().map(|s| s.ip()))
        .or_else(|| {
            raw.rsplit_once(':')
                .filter(|(host, _)| !host.contains(':'))
                .and_then(|(host, _)| host.parse().ok())
        })
}

/// Behind a proxy (the peer is private or loopback) the proxy's headers name the
/// caller; a public peer is the caller itself, and its headers could be forged.
pub fn client_ip(headers: &HeaderMap, peer: Option<IpAddr>) -> String {
    if let Some(peer) = peer.filter(|p| !is_private(p)) {
        return peer.to_string();
    }
    let header_ip = headers
        .get("cf-connecting-ip")
        .and_then(|v| v.to_str().ok())
        .and_then(parse_ip)
        .or_else(|| {
            headers
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.rsplit(',').next())
                .and_then(parse_ip)
        });
    header_ip
        .or(peer)
        .map(|ip| ip.to_string())
        .unwrap_or_default()
}

impl Origin {
    pub fn from_parts(headers: &HeaderMap, peer: Option<IpAddr>, method: &str, path: &str) -> Self {
        Self {
            ip: client_ip(headers, peer),
            method: method.into(),
            path: path.into(),
            user_agent: headers
                .get(header::USER_AGENT)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_string(),
        }
    }
}

pub fn origin_of(request: &Request) -> Origin {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip());
    Origin::from_parts(
        request.headers(),
        peer,
        request.method().as_str(),
        request.uri().path(),
    )
}

pub fn is_probe(path: &str) -> bool {
    let lowered = path.to_lowercase();
    PROBES.iter().any(|p| lowered.starts_with(p))
        || PROBE_SUFFIXES.iter().any(|s| lowered.ends_with(s))
        || lowered.contains("..")
        || lowered.contains("%2e%2e")
        || lowered.contains("/etc/passwd")
}

pub async fn shield(State(defense): State<Defense>, request: Request, next: Next) -> Response {
    let path = request.uri().path().to_string();
    if !path.starts_with("/api/") && is_probe(&path) {
        let origin = origin_of(&request);
        defense.network(
            "probe",
            "medium",
            &origin,
            "Scanner looking for a known weak spot",
        );
        return harden((StatusCode::NOT_FOUND, "Not found").into_response(), &path);
    }
    let response = next.run(request).await;
    harden(response, &path)
}

fn harden(mut response: Response, path: &str) -> Response {
    let headers = response.headers_mut();
    let set = |headers: &mut HeaderMap, name: &'static str, value: &'static str| {
        headers.insert(name, HeaderValue::from_static(value));
    };
    set(
        headers,
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    set(headers, "x-content-type-options", "nosniff");
    set(headers, "x-frame-options", "DENY");
    set(headers, "referrer-policy", "no-referrer");
    set(headers, "cross-origin-opener-policy", "same-origin");
    set(
        headers,
        "permissions-policy",
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    if crate::setting("SECURE_COOKIE").as_deref() == Some("1") {
        set(headers, "strict-transport-security", "max-age=31536000");
    }
    if path.starts_with("/api/") {
        set(headers, "cache-control", "no-store");
    }
    response
}

pub async fn status(
    State(defense): State<Defense>,
    State(watch): State<crate::watch::Watch>,
    State(auth): State<crate::auth::Auth>,
    State(geo): State<Geo>,
) -> Json<Value> {
    let mut view = defense.view();
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let loopback = matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1");
    let token = auth.token_length();
    let secure = crate::setting("SECURE_COOKIE").as_deref() == Some("1");
    let agent = watch.safety();
    let check = |name: &str, state: &str, detail: String| json!({ "name": name, "state": state, "detail": detail });
    let checks = vec![
        match token {
            None if loopback => check("Access token", "warn", "No token. Fine while only this computer can reach the console.".into()),
            None => check("Access token", "fail", "No token on a public address.".into()),
            Some(n) if n < 24 => check("Access token", "warn", format!("{n} characters. Use 32 or more random characters.")),
            Some(n) => check("Access token", "ok", format!("{n} characters, compared in constant time, 5 wrong tries locks an address out.")),
        },
        if secure || loopback {
            check("Session cookie", "ok", if secure { "HttpOnly, SameSite=Strict, Secure, with HSTS.".into() } else { "HttpOnly, SameSite=Strict (local only).".into() })
        } else {
            check("Session cookie", "warn", "Not marked Secure. Set HUNTER_SECURE_COOKIE=1 behind HTTPS.".into())
        },
        check("Browser lockdown", "ok", "Strict content policy, no framing, no referrer, fonts served locally.".into()),
        if agent.reader_ok {
            check("Quarantine reader", "ok", "Swarm text is only read by an isolated subprocess with no network or environment.".into())
        } else {
            check("Quarantine reader", "fail", "The reader is not running, so captures are stored unread.".into())
        },
        if agent.kill_switch {
            check("Kill switch", "fail", format!("On: {}", agent.halted_reason))
        } else {
            check("Kill switch", "ok", "Off. Outgoing replies are checked for canaries, echoes and solicitation.".into())
        },
        check("Canary tokens", if agent.canaries > 0 { "ok" } else { "warn" }, format!("{} planted. Any that come back in a swarm message halt the agent.", agent.canaries)),
        check("Threat feeds", "ok", "Only the blocklists are downloaded, size-capped. Listed sites are never opened.".into()),
        check("Attacker lookup", if geo.ready() { "ok" } else { "warn" }, if geo.ready() { "Attacker addresses are placed with the local database, no outside calls.".into() } else { "Location database not ready, so attacker addresses show without a country.".into() }),
    ];
    view["checks"] = json!(checks);
    Json(view)
}

#[cfg(test)]
mod tests {
    use super::{client_ip, is_probe, parse_ip};
    use axum::http::{HeaderMap, HeaderValue};
    use std::net::IpAddr;

    #[test]
    fn spots_scanners() {
        assert!(is_probe("/.env"));
        assert!(is_probe("/wp-login.php"));
        assert!(is_probe("/static/../../etc/passwd"));
        assert!(!is_probe("/"));
        assert!(!is_probe("/assets/index-abc.js"));
    }

    #[test]
    fn trusts_proxy_headers_only_from_private_peers() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("6.6.6.6, 203.0.113.9:4123"),
        );
        let private: IpAddr = "172.17.0.1".parse().unwrap();
        let public: IpAddr = "198.51.100.7".parse().unwrap();
        assert_eq!(client_ip(&headers, Some(private)), "203.0.113.9");
        assert_eq!(client_ip(&headers, Some(public)), "198.51.100.7");
        assert_eq!(
            parse_ip("[2001:db8::1]:443").unwrap().to_string(),
            "2001:db8::1"
        );
    }
}
