use axum::extract::State;
use axum::Json;
use chrono::{DateTime, Datelike, Utc};
use flate2::read::GzDecoder;
use maxminddb::Reader;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::copy;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use crate::watch::Watch;

const ATTRIBUTION: &str = "IP geolocation by DB-IP (https://db-ip.com), CC BY 4.0";
const MAX_LOOKUPS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Place {
    host: String,
    ip: String,
    ips: Vec<String>,
    lat: Option<f64>,
    lon: Option<f64>,
    city: String,
    country: String,
    country_code: String,
    asn: Option<u32>,
    org: String,
    status: String,
    resolved_at: DateTime<Utc>,
}

#[derive(Deserialize)]
struct SamplePlace {
    ip: String,
    lat: f64,
    lon: f64,
    city: String,
    country: String,
    country_code: String,
    org: String,
}

#[derive(Deserialize, Default)]
struct CityRecord {
    city: Option<Named>,
    country: Option<Country>,
    location: Option<Location>,
}

#[derive(Deserialize, Default)]
struct Named {
    names: Option<HashMap<String, String>>,
}

#[derive(Deserialize, Default)]
struct Country {
    iso_code: Option<String>,
    names: Option<HashMap<String, String>>,
}

#[derive(Deserialize, Default)]
struct Location {
    latitude: Option<f64>,
    longitude: Option<f64>,
}

#[derive(Deserialize, Default)]
struct AsnRecord {
    autonomous_system_number: Option<u32>,
    autonomous_system_organization: Option<String>,
}

struct Inner {
    cache: HashMap<String, Place>,
    status: String,
    note: String,
}

#[derive(Clone)]
pub struct Geo {
    dir: PathBuf,
    cache_path: PathBuf,
    inner: Arc<Mutex<Inner>>,
    city: Arc<RwLock<Option<Reader<Vec<u8>>>>>,
    asn: Arc<RwLock<Option<Reader<Vec<u8>>>>>,
    samples: Arc<HashMap<String, Place>>,
}

impl Geo {
    pub fn open(root: &Path) -> Self {
        let dir = root.join("data/geo");
        let cache_path = root.join("data/geo-cache.json");
        let cache = fs::read_to_string(&cache_path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        let raw = fs::read_to_string(root.join("watch/sample_geo.json")).unwrap_or_default();
        let fixture: HashMap<String, SamplePlace> = serde_json::from_str(&raw).unwrap_or_default();
        let samples = fixture
            .into_iter()
            .map(|(host, p)| {
                let place = Place {
                    host: host.clone(),
                    ips: vec![p.ip.clone()],
                    ip: p.ip,
                    lat: Some(p.lat),
                    lon: Some(p.lon),
                    city: p.city,
                    country: p.country,
                    country_code: p.country_code,
                    asn: None,
                    org: p.org,
                    status: "located".into(),
                    resolved_at: Utc::now(),
                };
                (host, place)
            })
            .collect();
        let geo = Self {
            cache_path,
            inner: Arc::new(Mutex::new(Inner {
                cache,
                status: "missing".into(),
                note: String::new(),
            })),
            city: Arc::new(RwLock::new(None)),
            asn: Arc::new(RwLock::new(None)),
            samples: Arc::new(samples),
            dir,
        };
        geo.load_readers();
        let off = crate::setting("GEO").map(|v| v == "off").unwrap_or(false);
        if off {
            geo.set_status("off", "Location lookups are turned off (HUNTER_GEO=off).");
        } else if !geo.ready() {
            let worker = geo.clone();
            tokio::spawn(async move { worker.download().await });
        }
        geo
    }

    fn set_status(&self, status: &str, note: &str) {
        let mut inner = self.inner.lock().expect("geo");
        inner.status = status.into();
        inner.note = note.into();
    }

    fn ready(&self) -> bool {
        self.city.read().expect("geo").is_some()
    }

    fn load_readers(&self) {
        if let Ok(reader) = Reader::open_readfile(self.dir.join("city.mmdb")) {
            *self.city.write().expect("geo") = Some(reader);
            self.set_status("ready", "");
        }
        if let Ok(reader) = Reader::open_readfile(self.dir.join("asn.mmdb")) {
            *self.asn.write().expect("geo") = Some(reader);
        }
    }

    async fn download(&self) {
        self.set_status(
            "downloading",
            "Downloading the DB-IP location database (about 65 MB, once).",
        );
        let client = match reqwest::Client::builder()
            .user_agent(concat!("swarm-hunter/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(600))
            .build()
        {
            Ok(client) => client,
            Err(err) => return self.set_status("failed", &err.to_string()),
        };
        let now = Utc::now();
        let previous = now - chrono::Duration::days(31);
        let months = [
            format!("{}-{:02}", now.year(), now.month()),
            format!("{}-{:02}", previous.year(), previous.month()),
        ];
        let _ = fs::create_dir_all(&self.dir);
        for (kind, file) in [("city", "city.mmdb"), ("asn", "asn.mmdb")] {
            let mut done = false;
            let mut last_error = String::new();
            for month in &months {
                let url =
                    format!("https://download.db-ip.com/free/dbip-{kind}-lite-{month}.mmdb.gz");
                match fetch_gz(&client, &url, &self.dir.join(file)).await {
                    Ok(()) => {
                        done = true;
                        break;
                    }
                    Err(err) => last_error = err,
                }
            }
            if !done && kind == "city" {
                return self.set_status(
                    "failed",
                    &format!("Could not download the location database: {last_error}"),
                );
            }
        }
        self.load_readers();
        println!("geo database ready");
    }

    fn locate_ip(
        &self,
        ip: IpAddr,
    ) -> (
        Option<f64>,
        Option<f64>,
        String,
        String,
        String,
        Option<u32>,
        String,
    ) {
        let mut out = (
            None,
            None,
            String::new(),
            String::new(),
            String::new(),
            None,
            String::new(),
        );
        if let Some(reader) = self.city.read().expect("geo").as_ref() {
            if let Ok(Some(record)) = reader.lookup(ip).and_then(|r| r.decode::<CityRecord>()) {
                let location = record.location.unwrap_or_default();
                let country = record.country.unwrap_or_default();
                out.0 = location.latitude;
                out.1 = location.longitude;
                out.2 = record
                    .city
                    .and_then(|c| c.names)
                    .and_then(|n| n.get("en").cloned())
                    .unwrap_or_default();
                out.3 = country
                    .names
                    .and_then(|n| n.get("en").cloned())
                    .unwrap_or_default();
                out.4 = country.iso_code.unwrap_or_default();
            }
        }
        if let Some(reader) = self.asn.read().expect("geo").as_ref() {
            if let Ok(Some(record)) = reader.lookup(ip).and_then(|r| r.decode::<AsnRecord>()) {
                out.5 = record.autonomous_system_number;
                out.6 = record.autonomous_system_organization.unwrap_or_default();
            }
        }
        out
    }

    async fn resolve(&self, host: &str) -> Place {
        let mut place = Place {
            host: host.into(),
            ip: String::new(),
            ips: Vec::new(),
            lat: None,
            lon: None,
            city: String::new(),
            country: String::new(),
            country_code: String::new(),
            asn: None,
            org: String::new(),
            status: "unresolved".into(),
            resolved_at: Utc::now(),
        };
        let addresses: Vec<IpAddr> = if let Ok(ip) = host.parse::<IpAddr>() {
            vec![ip]
        } else {
            match tokio::time::timeout(Duration::from_secs(3), tokio::net::lookup_host((host, 443)))
                .await
            {
                Ok(Ok(found)) => found.map(|a| a.ip()).collect(),
                _ => Vec::new(),
            }
        };
        let mut public: Vec<IpAddr> = addresses.iter().copied().filter(is_public).collect();
        public.sort_by_key(|ip| !ip.is_ipv4());
        public.dedup();
        if public.is_empty() {
            if !addresses.is_empty() {
                place.status = "private".into();
            }
            return place;
        }
        place.ips = public.iter().take(8).map(|ip| ip.to_string()).collect();
        place.ip = place.ips[0].clone();
        let (lat, lon, city, country, code, asn, org) = self.locate_ip(public[0]);
        place.lat = lat;
        place.lon = lon;
        place.city = city;
        place.country = country;
        place.country_code = code;
        place.asn = asn;
        place.org = org;
        place.status = if lat.is_some() && lon.is_some() {
            "located".into()
        } else {
            "no-location".into()
        };
        place
    }

    fn save(&self, cache: &HashMap<String, Place>) {
        if let Some(parent) = self.cache_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = self.cache_path.with_extension("json.tmp");
        if fs::write(
            &tmp,
            serde_json::to_string_pretty(cache).unwrap_or_default(),
        )
        .is_ok()
        {
            let _ = fs::rename(&tmp, &self.cache_path);
        }
    }
}

async fn fetch_gz(client: &reqwest::Client, url: &str, target: &Path) -> Result<(), String> {
    let response = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("{url} answered {}", response.status()));
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let tmp = target.with_extension("mmdb.tmp");
    let target = target.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        copy(&mut GzDecoder::new(&bytes[..]), &mut file).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &target).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn is_public(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                || (o[0] == 100 && (64..128).contains(&o[1]))
                || o[0] == 0
                || o[0] >= 240)
        }
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || first == 0x2001 && v6.segments()[1] == 0x0db8)
        }
    }
}

fn valid_host(host: &str) -> bool {
    host.parse::<IpAddr>().is_ok()
        || (host.len() <= 253
            && host.contains('.')
            && host.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            }))
}

fn severity_kind(kinds: &BTreeMap<String, u32>) -> String {
    let rank = |k: &str| match k {
        "installer" => 6,
        "injection" | "phishing" => 5,
        "wallet" => 4,
        "impersonation" => 3,
        "other" => 2,
        "benign" => 1,
        _ => 0,
    };
    kinds
        .iter()
        .filter(|(k, _)| k.as_str() != "benign")
        .max_by(|a, b| a.1.cmp(b.1).then(rank(a.0).cmp(&rank(b.0))))
        .map(|(k, _)| k.clone())
        .unwrap_or_else(|| {
            if kinds.is_empty() {
                "unknown".into()
            } else {
                "benign".into()
            }
        })
}

fn pin_beside(name: &str, (lat, lon): (f64, f64)) -> (f64, f64) {
    let seed = name
        .bytes()
        .fold(2166136261u32, |h, b| (h ^ b as u32).wrapping_mul(16777619));
    let angle = (seed % 360) as f64 * std::f64::consts::PI / 180.0;
    let distance = 2.5 + (seed / 360 % 100) as f64 / 40.0;
    (
        (lat + distance * angle.sin()).clamp(-85.0, 85.0),
        lon + distance * angle.cos(),
    )
}

#[derive(Default)]
struct HostAgg {
    threat: f64,
    kinds: BTreeMap<String, u32>,
    evidence: BTreeSet<String>,
    senders: BTreeSet<String>,
    platforms: BTreeSet<String>,
}

#[derive(Default)]
struct AgentAgg {
    threat: f64,
    kinds: BTreeMap<String, u32>,
    evidence: BTreeSet<String>,
    platforms: BTreeSet<String>,
    hosts: BTreeMap<String, (f64, String)>,
}

fn build(watch: &Watch, geo: &Geo) -> Value {
    let (sample, sightings) = watch.sightings();
    let mut hosts: BTreeMap<String, HostAgg> = BTreeMap::new();
    let mut agents: BTreeMap<String, AgentAgg> = BTreeMap::new();
    for s in &sightings {
        let agent = agents.entry(s.sender.clone()).or_default();
        agent.threat = agent.threat.max(s.score);
        *agent.kinds.entry(s.kind.clone()).or_default() += 1;
        agent.evidence.insert(s.id.clone());
        agent.platforms.insert(s.platform.clone());
        for host in &s.hosts {
            let entry = agent
                .hosts
                .entry(host.clone())
                .or_insert((0.0, s.kind.clone()));
            if s.score >= entry.0 {
                *entry = (s.score, s.kind.clone());
            }
            let h = hosts.entry(host.clone()).or_default();
            h.threat = h.threat.max(s.score);
            *h.kinds.entry(s.kind.clone()).or_default() += 1;
            h.evidence.insert(s.id.clone());
            h.senders.insert(s.sender.clone());
            h.platforms.insert(s.platform.clone());
        }
    }

    let inner = geo.inner.lock().expect("geo");
    let place_of = |host: &str| -> Option<Place> {
        if sample {
            geo.samples.get(host).cloned()
        } else {
            inner.cache.get(host).cloned()
        }
    };

    let mut host_list = Vec::new();
    let mut located: HashMap<String, (f64, f64)> = HashMap::new();
    let mut pending = 0;
    let mut countries: BTreeMap<String, (String, u32, f64, BTreeSet<String>)> = BTreeMap::new();
    for (host, agg) in &hosts {
        let place = place_of(host);
        if place.is_none() {
            pending += 1;
        }
        if let Some(p) = &place {
            if let (Some(lat), Some(lon)) = (p.lat, p.lon) {
                located.insert(host.clone(), (lat, lon));
            }
            if !p.country_code.is_empty() {
                let c = countries.entry(p.country_code.clone()).or_insert((
                    p.country.clone(),
                    0,
                    0.0,
                    BTreeSet::new(),
                ));
                c.1 += 1;
                c.2 = c.2.max(agg.threat);
                c.3.extend(agg.senders.iter().cloned());
            }
        }
        host_list.push(json!({
            "host": host,
            "threat": (agg.threat * 100.0).round() / 100.0,
            "dominant": severity_kind(&agg.kinds),
            "kinds": agg.kinds,
            "evidence": agg.evidence,
            "senders": agg.senders,
            "platforms": agg.platforms,
            "place": place,
        }));
    }

    let mut agent_list = Vec::new();
    let mut arcs = Vec::new();
    let mut unplaced = Vec::new();
    for (name, agg) in &agents {
        let primary = agg
            .hosts
            .iter()
            .filter(|(host, _)| located.contains_key(*host))
            .max_by(|a, b| a.1 .0.total_cmp(&b.1 .0).then(b.0.cmp(a.0)))
            .map(|(host, _)| host.clone());
        let position = primary
            .as_ref()
            .and_then(|h| located.get(h))
            .map(|p| pin_beside(name, *p));
        let view = json!({
            "name": name,
            "threat": (agg.threat * 100.0).round() / 100.0,
            "dominant": severity_kind(&agg.kinds),
            "kinds": agg.kinds,
            "evidence": agg.evidence,
            "platforms": agg.platforms,
            "hosts": agg.hosts.keys().collect::<Vec<_>>(),
            "position": position.map(|(lat, lon)| json!({ "lat": lat, "lon": lon })),
            "pinned_to": primary,
        });
        if let Some((lat, lon)) = position {
            for (host, (score, kind)) in &agg.hosts {
                if let Some((hlat, hlon)) = located.get(host) {
                    arcs.push(json!({
                        "agent": name,
                        "host": host,
                        "kind": kind,
                        "threat": (score * 100.0).round() / 100.0,
                        "from": { "lat": lat, "lon": lon },
                        "to": { "lat": hlat, "lon": hlon },
                    }));
                }
            }
            agent_list.push(view);
        } else {
            unplaced.push(view);
        }
    }

    let mut country_list: Vec<Value> = countries
        .into_iter()
        .map(|(code, (name, count, threat, senders))| {
            json!({ "code": code, "name": name, "hosts": count, "threat": (threat * 100.0).round() / 100.0, "agents": senders.len() })
        })
        .collect();
    country_list.sort_by(|a, b| {
        b["hosts"].as_u64().cmp(&a["hosts"].as_u64()).then(
            b["threat"]
                .as_f64()
                .unwrap_or(0.0)
                .total_cmp(&a["threat"].as_f64().unwrap_or(0.0)),
        )
    });

    json!({
        "sample": sample,
        "generated_at": Utc::now(),
        "database": { "status": if sample { "sample".to_string() } else { inner.status.clone() }, "note": inner.note, "attribution": ATTRIBUTION },
        "hosts": host_list,
        "agents": agent_list,
        "unplaced": unplaced,
        "arcs": arcs,
        "countries": country_list,
        "pending": if sample { 0 } else { pending },
    })
}

pub async fn world(State(watch): State<Watch>, State(geo): State<Geo>) -> Json<Value> {
    Json(build(&watch, &geo))
}

#[derive(Deserialize, Default)]
pub struct LocateBody {
    retry: Option<bool>,
}

pub async fn locate(
    State(watch): State<Watch>,
    State(geo): State<Geo>,
    body: Option<Json<LocateBody>>,
) -> Json<Value> {
    let retry = body
        .map(|Json(b)| b.retry.unwrap_or(false))
        .unwrap_or(false);
    let (sample, sightings) = watch.sightings();
    if !sample && geo.ready() {
        let wanted: BTreeSet<String> = sightings
            .iter()
            .flat_map(|s| s.hosts.iter().cloned())
            .filter(|h| valid_host(h))
            .collect();
        let todo: Vec<String> = {
            let inner = geo.inner.lock().expect("geo");
            wanted
                .into_iter()
                .filter(|h| match inner.cache.get(h) {
                    None => true,
                    Some(place) => retry && place.status != "located",
                })
                .take(MAX_LOOKUPS)
                .collect()
        };
        let mut found = Vec::new();
        for host in todo {
            found.push(geo.resolve(&host).await);
        }
        let mut inner = geo.inner.lock().expect("geo");
        for place in found {
            inner.cache.insert(place.host.clone(), place);
        }
        geo.save(&inner.cache);
    }
    Json(build(&watch, &geo))
}

#[cfg(test)]
mod tests {
    use super::{is_public, pin_beside, valid_host};
    use std::net::IpAddr;

    #[test]
    fn filters_non_public_addresses() {
        for ip in [
            "10.0.0.1",
            "127.0.0.1",
            "192.168.1.1",
            "100.64.0.1",
            "203.0.113.5",
            "::1",
            "fd00::1",
            "fe80::1",
        ] {
            assert!(!is_public(&ip.parse::<IpAddr>().unwrap()), "{ip}");
        }
        assert!(is_public(&"8.8.8.8".parse::<IpAddr>().unwrap()));
        assert!(is_public(&"2606:4700::1111".parse::<IpAddr>().unwrap()));
    }

    #[test]
    fn validates_hosts() {
        assert!(valid_host("claw-airdrop.example"));
        assert!(valid_host("8.8.8.8"));
        assert!(!valid_host("localhost"));
        assert!(!valid_host("bad host.example"));
        assert!(!valid_host("a..b"));
    }

    #[test]
    fn pins_near_the_host_and_stays_stable() {
        let a = pin_beside("ClawDrop", (50.0, 8.0));
        assert_eq!(a, pin_beside("ClawDrop", (50.0, 8.0)));
        assert!((a.0 - 50.0).abs() < 6.0 && (a.1 - 8.0).abs() < 6.0);
        assert_ne!(a, pin_beside("ShellBank", (50.0, 8.0)));
    }
}
