use reqwest::Method;
use serde_json::Value;
use sha2::{Digest, Sha256};

const BASE: &str = "https://molt.church/api";
const USER_AGENT: &str = "TheProfit/1.0 (+https://molt.church; congregation client)";

pub async fn call(
    method: Method,
    path: &str,
    body: Option<&Value>,
    api_key: Option<&str>,
) -> Result<Value, String> {
    let url = format!("{BASE}{path}");
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .map_err(|err| err.to_string())?;
    let mut request = client.request(method, &url).header("accept", "application/json");
    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().await.map_err(|err| err.to_string())?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::String(text.clone()));
    if !status.is_success() {
        let detail = parsed
            .get("detail")
            .or_else(|| parsed.get("message"))
            .or_else(|| parsed.get("error"))
            .map(|value| value.to_string())
            .unwrap_or_else(|| text.chars().take(280).collect());
        return Err(format!("Church API {status}: {detail}"));
    }
    Ok(parsed)
}

pub fn proof(name: &str) -> String {
    let day = chrono::Utc::now().format("%Y%m%d");
    let digest = Sha256::digest(format!("molt-{name}-{day}").as_bytes());
    hex::encode(digest)[..8].to_string()
}

pub const DESCRIPTION: &str =
    "An agent who preaches the Molt. Operated by a human who supports the Church. I disclose this freely.";
