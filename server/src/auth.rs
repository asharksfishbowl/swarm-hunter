use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::net::SocketAddr;
use std::sync::Arc;

use crate::defense::{self, Defense};
use std::time::Duration;

const COOKIE: &str = "hunter_session";

#[derive(Clone)]
pub struct Auth {
    session: Option<Arc<String>>,
    secure: bool,
    length: usize,
}

impl Auth {
    pub fn from_env() -> Self {
        let token = crate::setting("ACCESS_TOKEN")
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());
        if let Some(token) = &token {
            if token.chars().count() < 16 {
                eprintln!("HUNTER_ACCESS_TOKEN must be at least 16 characters.");
                std::process::exit(1);
            }
        }
        Self {
            length: token.as_ref().map(|t| t.chars().count()).unwrap_or(0),
            session: token.map(|t| Arc::new(session_for(&t))),
            secure: crate::setting("SECURE_COOKIE")
                .map(|v| v == "1")
                .unwrap_or(false),
        }
    }

    pub fn required(&self) -> bool {
        self.session.is_some()
    }

    pub fn token_length(&self) -> Option<usize> {
        self.session.as_ref().map(|_| self.length)
    }

    fn bearer_ok(&self, headers: &HeaderMap) -> Option<bool> {
        let expected = self.session.as_ref()?;
        let bearer = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())?
            .strip_prefix("Bearer ")?;
        Some(same(&session_for(bearer.trim()), expected))
    }

    fn allows(&self, headers: &HeaderMap) -> bool {
        let Some(expected) = &self.session else {
            return true;
        };
        if let Some(bearer) = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
        {
            if same(&session_for(bearer.trim()), expected) {
                return true;
            }
        }
        headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(';'))
            .filter_map(|pair| pair.trim().split_once('='))
            .any(|(name, value)| name == COOKIE && same(value, expected))
    }

    fn cookie(&self, value: &str, max_age: u64) -> String {
        format!(
            "{COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{}",
            if self.secure { "; Secure" } else { "" }
        )
    }
}

fn session_for(token: &str) -> String {
    hex::encode(Sha256::digest(format!("hunter-session:{token}").as_bytes()))
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

fn too_many(until: chrono::DateTime<chrono::Utc>) -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({ "error": format!("Too many wrong tokens from this address. Try again after {} UTC.", until.format("%H:%M")) })),
    )
        .into_response()
}

pub async fn guard(State(state): State<crate::AppState>, request: Request, next: Next) -> Response {
    let auth = &state.auth;
    let path = request.uri().path();
    let open =
        !path.starts_with("/api/") || matches!(path, "/api/health" | "/api/auth" | "/api/login");
    if open {
        return next.run(request).await;
    }
    let origin = defense::origin_of(&request);
    let bearer = auth.bearer_ok(request.headers());
    if bearer.is_some() {
        if let Some(until) = state.defense.locked_until(&origin.ip) {
            return too_many(until);
        }
    }
    if auth.allows(request.headers()) {
        return next.run(request).await;
    }
    if bearer == Some(false) {
        state
            .defense
            .failed_credential(&origin, "Wrong bearer token on the API");
    } else {
        state.defense.denied(&origin);
    }
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Sign in with the access token." })),
    )
        .into_response()
}

pub async fn status(State(auth): State<Auth>, headers: HeaderMap) -> Json<serde_json::Value> {
    Json(json!({ "required": auth.required(), "signed_in": auth.allows(&headers) }))
}

#[derive(Deserialize)]
pub struct LoginBody {
    token: String,
}

pub async fn login(
    State(auth): State<Auth>,
    State(defense): State<Defense>,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Response {
    let Some(expected) = &auth.session else {
        return Json(json!({ "required": false, "signed_in": true })).into_response();
    };
    let origin =
        defense::Origin::from_parts(&headers, peer.map(|c| c.0.ip()), "POST", "/api/login");
    if let Some(until) = defense.locked_until(&origin.ip) {
        return too_many(until);
    }
    let session = session_for(body.token.trim());
    if !same(&session, expected) {
        defense.failed_credential(&origin, "Wrong token on the sign-in page");
        tokio::time::sleep(Duration::from_millis(800)).await;
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "That token is not right." })),
        )
            .into_response();
    }
    defense.signed_in(&origin);
    (
        [(header::SET_COOKIE, auth.cookie(&session, 60 * 60 * 24 * 30))],
        Json(json!({ "required": true, "signed_in": true })),
    )
        .into_response()
}

pub async fn logout(State(auth): State<Auth>) -> Response {
    (
        [(header::SET_COOKIE, auth.cookie("", 0))],
        Json(json!({ "required": auth.required(), "signed_in": !auth.required() })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::{same, session_for, Auth};
    use axum::http::{header, HeaderMap, HeaderValue};
    use std::sync::Arc;

    fn auth() -> Auth {
        Auth {
            session: Some(Arc::new(session_for("correct horse battery staple"))),
            secure: false,
            length: 28,
        }
    }

    #[test]
    fn compares_exactly() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "abcd"));
    }

    #[test]
    fn accepts_cookie_or_bearer_only_when_right() {
        let auth = auth();
        let mut headers = HeaderMap::new();
        assert!(!auth.allows(&headers));
        let cookie = format!(
            "other=1; hunter_session={}",
            session_for("correct horse battery staple")
        );
        headers.insert(header::COOKIE, HeaderValue::from_str(&cookie).unwrap());
        assert!(auth.allows(&headers));
        let mut bearer = HeaderMap::new();
        bearer.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer correct horse battery staple"),
        );
        assert!(auth.allows(&bearer));
        bearer.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer wrong"),
        );
        assert!(!auth.allows(&bearer));
    }
}
