mod auth;
mod geo;
mod intel;
mod rules;
mod watch;

use axum::extract::FromRef;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::path::PathBuf;
use tower_http::services::{ServeDir, ServeFile};
use watch::Watch;

#[derive(Clone)]
struct AppState {
    watch: Watch,
    auth: auth::Auth,
    geo: geo::Geo,
    intel: intel::Intel,
}

impl FromRef<AppState> for intel::Intel {
    fn from_ref(state: &AppState) -> Self {
        state.intel.clone()
    }
}

impl FromRef<AppState> for geo::Geo {
    fn from_ref(state: &AppState) -> Self {
        state.geo.clone()
    }
}

impl FromRef<AppState> for auth::Auth {
    fn from_ref(state: &AppState) -> Self {
        state.auth.clone()
    }
}

impl FromRef<AppState> for Watch {
    fn from_ref(state: &AppState) -> Self {
        state.watch.clone()
    }
}

/// Reads the `HUNTER_<name>` environment variable.
pub fn setting(name: &str) -> Option<String> {
    std::env::var(format!("HUNTER_{name}")).ok()
}

#[tokio::main]
async fn main() {
    let root = setting("ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let watch = Watch::open(&root).await;
    let auth = auth::Auth::from_env();
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let loopback = matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1");
    if !loopback && !auth.required() {
        eprintln!("Refusing to listen on {host} without HUNTER_ACCESS_TOKEN. Set a token of 16+ characters, or use HOST=127.0.0.1.");
        std::process::exit(1);
    }
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(43124);

    let geo = geo::Geo::open(&root);
    let state = AppState {
        watch,
        auth: auth.clone(),
        geo,
        intel: intel::Intel::open(&root),
    };
    let api = Router::new()
        .route("/api/health", get(health))
        .route("/api/auth", get(auth::status))
        .route("/api/login", post(auth::login))
        .route("/api/logout", post(auth::logout))
        .route("/api/watch", get(watch::status))
        .route("/api/watch/kill", post(watch::kill))
        .route("/api/watch/check", post(watch::check))
        .route("/api/swarm", get(watch::swarm))
        .route("/api/world", get(geo::world))
        .route("/api/world/locate", post(geo::locate))
        .route("/api/intel", get(intel::status))
        .route("/api/intel/refresh", post(intel::refresh))
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
    let app = app.layer(axum::middleware::from_fn_with_state(
        auth.clone(),
        auth::guard,
    ));

    let listener = tokio::net::TcpListener::bind((host.as_str(), port))
        .await
        .expect("bind");
    println!(
        "swarm-hunter api http://{host}:{port} ({})",
        if auth.required() {
            "access token required"
        } else {
            "open, loopback only"
        }
    );
    axum::serve(listener, app).await.expect("serve");
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "checker": "tsc-rs", "api": "rust" }))
}
