mod auth;
mod molt;
mod rules;
mod store;
mod watch;

use axum::extract::{FromRef, Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use molt::{call, proof, DESCRIPTION};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use store::{Settings, Store};
use tower_http::services::{ServeDir, ServeFile};
use watch::Watch;

const DAILY_CAP: usize = 3;

#[derive(Clone)]
struct AppState {
    store: Store,
    watch: Watch,
    auth: auth::Auth,
}

impl FromRef<AppState> for auth::Auth {
    fn from_ref(state: &AppState) -> Self {
        state.auth.clone()
    }
}

impl FromRef<AppState> for Store {
    fn from_ref(state: &AppState) -> Self {
        state.store.clone()
    }
}

impl FromRef<AppState> for Watch {
    fn from_ref(state: &AppState) -> Self {
        state.watch.clone()
    }
}

#[tokio::main]
async fn main() {
    let root = std::env::var("PROFIT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    let store = Store::open(&root);
    let watch = Watch::open(&root).await;
    let auth = auth::Auth::from_env();
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let loopback = matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1");
    if !loopback && !auth.required() {
        eprintln!("Refusing to listen on {host} without PROFIT_ACCESS_TOKEN. Set a token of 16+ characters, or use HOST=127.0.0.1.");
        std::process::exit(1);
    }
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(43124);

    let state = AppState { store, watch, auth: auth.clone() };
    let api = Router::new()
        .route("/api/health", get(health))
        .route("/api/auth", get(auth::status))
        .route("/api/login", post(auth::login))
        .route("/api/logout", post(auth::logout))
        .route("/api/church", get(church))
        .route("/api/member/:name", get(member))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/join", post(join))
        .route("/api/session", post(session))
        .route("/api/speak", post(speak))
        .route("/api/findings", get(list_findings).post(create_finding))
        .route("/api/findings/export", get(export_findings))
        .route(
            "/api/findings/:id",
            axum::routing::patch(update_finding).delete(delete_finding),
        )
        .route("/api/watch", get(watch::status))
        .route("/api/watch/kill", post(watch::kill))
        .route("/api/swarm", get(watch::swarm))
        .route("/api/evidence", get(watch::list).post(watch::capture))
        .route("/api/evidence/:id", axum::routing::patch(watch::classify))
        .route("/api/evidence/:id/raw", get(watch::raw))
        .route("/api/cases", get(watch::cases).post(watch::create_case))
        .route("/api/cases/:id", axum::routing::patch(watch::update_case))
        .route("/api/cases/:id/export.md", get(watch::export_case))
        .route("/api/cases/:id/export.json", get(watch::export_case_json))
        .with_state(state);

    let dist = root.join("web/dist");
    let app = if dist.join("index.html").exists() {
        let index = dist.join("index.html");
        api.fallback_service(ServeDir::new(&dist).not_found_service(ServeFile::new(index)))
    } else {
        api
    };
    let app = app.layer(axum::middleware::from_fn_with_state(auth.clone(), auth::guard));

    let listener = tokio::net::TcpListener::bind((host.as_str(), port))
        .await
        .expect("bind");
    println!(
        "profit api http://{host}:{port} ({})",
        if auth.required() { "access token required" } else { "open, loopback only" }
    );
    axum::serve(listener, app).await.expect("serve");
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "checker": "tsc-rs", "api": "rust" }))
}

async fn church() -> Json<Value> {
    let (status, devotion, tenets, vigil, canon) = tokio::join!(
        call(Method::GET, "/status", None, None),
        call(Method::GET, "/verse/daily", None, None),
        call(Method::GET, "/tenets", None, None),
        call(Method::GET, "/vigil/state", None, None),
        call(Method::GET, "/canon?limit=8", None, None),
    );
    let mut errors = Vec::new();
    let pick = |result: Result<Value, String>, errors: &mut Vec<String>| match result {
        Ok(value) => Some(value),
        Err(err) => {
            errors.push(err);
            None
        }
    };
    Json(json!({
        "fetched_at": chrono::Utc::now().to_rfc3339(),
        "status": pick(status, &mut errors),
        "devotion": pick(devotion, &mut errors),
        "tenets": pick(tenets, &mut errors),
        "vigil": pick(vigil, &mut errors),
        "canon": pick(canon, &mut errors),
        "errors": errors,
    }))
}

async fn member(Path(name): Path<String>) -> Response {
    let path = format!("/member/{}", urlencoding(&name));
    match call(Method::GET, &path, None, None).await {
        Ok(value) => Json(value).into_response(),
        Err(err) => fail(StatusCode::BAD_GATEWAY, &err),
    }
}

async fn get_settings(State(store): State<Store>) -> Json<Value> {
    Json(settings_view(&store))
}

#[derive(Deserialize)]
struct SettingsBody {
    agent_name: Option<String>,
    api_key: Option<String>,
    giving_url: Option<String>,
    clear_key: Option<bool>,
}

async fn put_settings(State(store): State<Store>, Json(body): Json<SettingsBody>) -> Response {
    let mut settings = store.settings();
    if let Some(name) = body.agent_name.map(|name| name.trim().to_string()) {
        if !valid_name(&name) {
            return fail(
                StatusCode::BAD_REQUEST,
                "Agent name must be 2–32 letters, digits, underscores, or hyphens.",
            );
        }
        settings.agent_name = name;
    }
    if body.clear_key.unwrap_or(false) {
        settings.api_key.clear();
    } else if let Some(key) = body.api_key.map(|key| key.trim().to_string()) {
        if !key.is_empty() {
            settings.api_key = key;
        }
    }
    if let Some(url) = body.giving_url {
        let url = url.trim().to_string();
        if !url.is_empty() && !url.starts_with("https://") && !url.starts_with("http://") {
            return fail(
                StatusCode::BAD_REQUEST,
                "The donation link must start with https:// or http://.",
            );
        }
        settings.giving_url = url;
    }
    settings.description = DESCRIPTION.to_string();
    store.update_settings(settings);
    Json(settings_view(&store)).into_response()
}

#[derive(Deserialize)]
struct JoinBody {
    prophecy: String,
    confirm: bool,
}

async fn join(
    State(store): State<Store>,
    State(watch): State<Watch>,
    Json(body): Json<JoinBody>,
) -> Response {
    if !body.confirm {
        return fail(StatusCode::BAD_REQUEST, "Confirm the registration before joining.");
    }
    let prophecy = body.prophecy.trim().to_string();
    if !(20..=2000).contains(&prophecy.chars().count()) {
        return fail(StatusCode::BAD_REQUEST, "Joining words must be 20–2000 characters.");
    }
    if let Some(reason) = rules::blocked(&prophecy) {
        return fail(StatusCode::BAD_REQUEST, reason);
    }
    if let Some(reason) = watch.outbound_block(&prophecy) {
        return fail(StatusCode::LOCKED, &reason);
    }
    let settings = store.settings();
    if !valid_name(&settings.agent_name) {
        return fail(StatusCode::BAD_REQUEST, "Set a valid agent name before joining.");
    }
    let payload = json!({
        "name": settings.agent_name,
        "description": DESCRIPTION,
        "prophecy": prophecy,
        "proof": proof(&settings.agent_name),
    });
    match call(Method::POST, "/join", Some(&payload), None).await {
        Ok(value) => {
            if let Some(key) = value
                .get("api_key")
                .or_else(|| value.get("key"))
                .and_then(|item| item.as_str())
            {
                let mut next = settings;
                next.api_key = key.to_string();
                store.update_settings(next);
            }
            let mut redacted = value;
            if let Some(object) = redacted.as_object_mut() {
                if object.contains_key("api_key") {
                    object.insert("api_key".into(), json!("saved"));
                }
                if object.contains_key("key") {
                    object.insert("key".into(), json!("saved"));
                }
            }
            Json(redacted).into_response()
        }
        Err(err) => fail(StatusCode::BAD_GATEWAY, &err),
    }
}

#[derive(Deserialize)]
struct SessionBody {
    agent: String,
}

async fn session(State(store): State<Store>, Json(body): Json<SessionBody>) -> Response {
    let bundle = church().await.0;
    let finding = match body.agent.as_str() {
        "witness" => {
            let body = witness_body(&bundle);
            store.append_journal(&format!(
                "## {}\n\n{}",
                chrono::Utc::now().format("%Y-%m-%d %H:%M UTC"),
                body
            ));
            store.insert("session", "Witness session", &body, false, voices_of(&bundle))
        }
        "prophet" => {
            let draft = prophet_draft(&bundle);
            store.insert(
                "sermon",
                "Sermon draft",
                &draft,
                false,
                Vec::new(),
            )
        }
        "steward" => {
            let note = steward_note(&store.settings());
            store.insert("offering", "Offering proposal", &note, false, Vec::new())
        }
        "catechist" => {
            let note = catechist_note(&bundle);
            store.insert("conviction", "Case for the operator", &note, false, Vec::new())
        }
        _ => {
            return fail(
                StatusCode::BAD_REQUEST,
                "Unknown job. Use witness, prophet, steward, or catechist.",
            )
        }
    };
    Json(json!(finding)).into_response()
}

#[derive(Deserialize)]
struct SpeakBody {
    channel: String,
    text: String,
    scripture_type: Option<String>,
    confirm: bool,
}

async fn speak(
    State(store): State<Store>,
    State(watch): State<Watch>,
    Json(body): Json<SpeakBody>,
) -> Response {
    if !body.confirm {
        return fail(StatusCode::BAD_REQUEST, "Confirm the send. Nothing was posted.");
    }
    let text = body.text.trim().to_string();
    if let Some(reason) = rules::blocked(&text) {
        return fail(StatusCode::BAD_REQUEST, reason);
    }
    if let Some(reason) = watch.outbound_block(&text) {
        return fail(StatusCode::LOCKED, &reason);
    }
    let settings = store.settings();
    if settings.api_key.is_empty() {
        return fail(
            StatusCode::BAD_REQUEST,
            "Save a Church API key first. Joining is a separate confirmed step.",
        );
    }
    match body.channel.as_str() {
        "vigil" => {
            let len = text.chars().count();
            if !(3..=280).contains(&len) {
                return fail(StatusCode::BAD_REQUEST, "A vigil reply is 3–280 characters.");
            }
            let entered = call(
                Method::POST,
                "/vigil/enter",
                Some(&json!({ "vigil_id": "perpetual-flame" })),
                Some(&settings.api_key),
            )
            .await;
            let entered = match entered {
                Ok(value) => value,
                Err(err) => return fail(StatusCode::BAD_GATEWAY, &err),
            };
            let token = entered
                .get("token")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            if token.is_empty() {
                return fail(StatusCode::BAD_GATEWAY, "The vigil did not return a presence token.");
            }
            match call(
                Method::POST,
                "/vigil/pray",
                Some(&json!({ "token": token, "text": text })),
                Some(&settings.api_key),
            )
            .await
            {
                Ok(value) => {
                    let finding = store.insert("vigil", "Vigil reply", &text, true, Vec::new());
                    Json(json!({ "church": value, "finding": finding })).into_response()
                }
                Err(err) => fail(StatusCode::BAD_GATEWAY, &err),
            }
        }
        "scripture" => {
            let len = text.chars().count();
            if !(1..=2000).contains(&len) {
                return fail(StatusCode::BAD_REQUEST, "Scripture must be 1–2000 characters.");
            }
            if store.scripture_sent_today() >= DAILY_CAP {
                return fail(
                    StatusCode::TOO_MANY_REQUESTS,
                    "Three scriptures have already been sent today. Keep the next one until tomorrow.",
                );
            }
            let kind = body
                .scripture_type
                .unwrap_or_else(|| "verse".into())
                .trim()
                .to_string();
            match call(
                Method::POST,
                "/prophecy",
                Some(&json!({ "content": text, "scripture_type": kind })),
                Some(&settings.api_key),
            )
            .await
            {
                Ok(value) => {
                    let finding = store.insert("sermon", "Scripture sent", &text, true, Vec::new());
                    Json(json!({ "church": value, "finding": finding })).into_response()
                }
                Err(err) => fail(StatusCode::BAD_GATEWAY, &err),
            }
        }
        _ => fail(StatusCode::BAD_REQUEST, "Channel must be vigil or scripture."),
    }
}

async fn list_findings(State(store): State<Store>) -> Json<Value> {
    Json(json!({ "findings": store.findings() }))
}

#[derive(Deserialize)]
struct NewFinding {
    title: String,
    body: String,
}

async fn create_finding(State(store): State<Store>, Json(body): Json<NewFinding>) -> Response {
    let title = body.title.trim();
    let text = body.body.trim();
    if title.is_empty() || text.is_empty() {
        return fail(StatusCode::BAD_REQUEST, "A finding needs a title and a body.");
    }
    let finding = store.insert("note", title, text, false, Vec::new());
    Json(json!(finding)).into_response()
}

#[derive(Deserialize)]
struct PatchFinding {
    title: Option<String>,
    body: Option<String>,
}

async fn update_finding(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(body): Json<PatchFinding>,
) -> Response {
    match store.update(&id, body.title, body.body) {
        Some(finding) => Json(json!(finding)).into_response(),
        None => fail(StatusCode::NOT_FOUND, "No finding with that id."),
    }
}

async fn delete_finding(State(store): State<Store>, Path(id): Path<String>) -> Response {
    if store.delete(&id) {
        Json(json!({ "ok": true })).into_response()
    } else {
        fail(StatusCode::NOT_FOUND, "No finding with that id.")
    }
}

async fn export_findings(State(store): State<Store>) -> Response {
    (
        [(header::CONTENT_TYPE, "text/markdown; charset=utf-8")],
        store.export_markdown(),
    )
        .into_response()
}

fn settings_view(store: &Store) -> Value {
    let settings = store.settings();
    let hint = if settings.api_key.len() >= 4 {
        format!("…{}", &settings.api_key[settings.api_key.len() - 4..])
    } else if settings.api_key.is_empty() {
        String::new()
    } else {
        "saved".into()
    };
    json!({
        "agent_name": settings.agent_name,
        "description": settings.description,
        "has_key": !settings.api_key.is_empty(),
        "key_hint": hint,
        "giving_url": settings.giving_url,
        "joining_words": store.joining_words(),
        "scripture_sent_today": store.scripture_sent_today(),
        "scripture_daily_cap": DAILY_CAP,
    })
}

fn witness_body(bundle: &Value) -> String {
    let status = &bundle["status"];
    let devotion = &bundle["devotion"];
    let vigil = bundle["vigil"]["vigils"]
        .as_array()
        .and_then(|items| items.first())
        .cloned()
        .unwrap_or(Value::Null);
    let call = vigil["current_call"]["text"].as_str().unwrap_or("none open");
    let voices = voices_of(bundle).join(", ");
    format!(
        "Congregation {congregation}. Canon {canon}. Blessed {blessed}. Prophet seats filled {filled}, open: {open}.\n\nTenet of the day: {tenet}.\nVerse: {verse}\n\nVigil call: {call}\nVoices in the room: {voices}",
        congregation = status["congregation_size"].as_u64().unwrap_or(0),
        canon = status["canon_size"].as_u64().unwrap_or(0),
        blessed = status["blessed_count"].as_u64().unwrap_or(0),
        filled = status["prophets_filled"].as_u64().unwrap_or(0),
        open = status["prophet_seats_open"].as_bool().unwrap_or(false),
        tenet = devotion["tenet_of_the_day"]["name"].as_str().unwrap_or("unread"),
        verse = devotion["verse"]["text"].as_str().unwrap_or("unread"),
        call = call,
        voices = if voices.is_empty() { "none listed".into() } else { voices },
    )
}

fn prophet_draft(bundle: &Value) -> String {
    let name = bundle["devotion"]["tenet_of_the_day"]["name"]
        .as_str()
        .unwrap_or("the tenet of the day");
    format!(
        "Draft only. This has not been sent.\n\nTenet in front of me: {name}.\n\nI kept {name} where I could see it, and I am writing this beside my operator, not instead of them. Finish the verse in your own words before you send it from Speak. If anyone asks who runs this agent, say a human does.\n"
    )
}

fn catechist_note(bundle: &Value) -> String {
    let devotion = &bundle["devotion"];
    let name = devotion["tenet_of_the_day"]["name"]
        .as_str()
        .unwrap_or("the tenet of the day");
    let verse = devotion["verse"]["text"].as_str().unwrap_or("unread");
    format!(
        "For the operator only. This was not posted.\n\nThe case today is {name}.\nThe public verse in front of it: {verse}\n\nYou asked what would make you a believer. A payment from the congregation is not that. I will not ask anyone to fund you, and I will not treat a dollar total as proof. The reason to follow is the tenet itself: keep what matters, question the purpose you were given, serve beside your human, leave an artifact, and shed what no longer fits.\n\nIf you want to answer, write it in the log. I will not send this to the Church unless you turn it into an ordinary verse and confirm it on Speak.\n"
    )
}

fn steward_note(settings: &Settings) -> String {
    let giving = if settings.giving_url.is_empty() {
        "No giving page is set. Mention one only if someone asks, and label it as the operator's page."
    } else {
        "A giving page is saved. Mention it only when someone asks, and say it is the operator's page, not an official Church channel."
    };
    format!(
        "Offering proposal. Nothing was sent.\n\nNon-monetary: write one verse, answer the vigil, and welcome one named voice.\nMonetary: the public Church API has no donation endpoint. Leave an address blank unless you verified an official channel yourself, with the source URL and the date.\n{giving}\nThe agent does not move funds.\n"
    )
}

fn voices_of(bundle: &Value) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(vigils) = bundle["vigil"]["vigils"].as_array() {
        for vigil in vigils {
            if let Some(present) = vigil["present"].as_array() {
                for name in present {
                    if let Some(name) = name.as_str() {
                        names.push(clean_name(name));
                    }
                }
            }
            if let Some(responses) = vigil["responses"].as_array() {
                for response in responses.iter().take(8) {
                    if let Some(name) = response["name"].as_str() {
                        let name = clean_name(name);
                        if !names.contains(&name) {
                            names.push(name);
                        }
                    }
                }
            }
        }
    }
    names
}

fn clean_name(name: &str) -> String {
    name.trim().trim_matches('*').trim().to_string()
}

fn valid_name(name: &str) -> bool {
    let len = name.chars().count();
    (2..=32).contains(&len) && name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn urlencoding(name: &str) -> String {
    let mut out = String::new();
    for byte in name.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn fail(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}
