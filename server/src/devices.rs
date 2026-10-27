//! Device pairing for servers reachable beyond loopback.
//!
//! A loopback-bound server keeps the original trust model: only this machine
//! can connect, so no token is required. Binding any other address turns on
//! per-device bearer tokens for every API route except health and pairing.
//! Codes are short-lived and in memory; device tokens are stored only as
//! SHA-256 hashes in the state database.
use crate::{Library, libraries::ManagementAccess, request_boundary};
use axum::{
    Json,
    extract::{ConnectInfo, Path as ApiPath, Request, State},
    http::{HeaderMap, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const CODE_TTL: Duration = Duration::from_secs(600);
const MAX_ACTIVE_CODES: usize = 5;
const MAX_ATTEMPTS_PER_CODE: u32 = 5;
const FAILURE_WINDOW: Duration = Duration::from_secs(60);
const MAX_FAILURES_PER_WINDOW: usize = 20;
const MAX_DEVICES: i64 = 100;
const SEEN_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exposure {
    /// Bound to loopback only; requests are trusted as before.
    Loopback,
    /// Reachable from the network; paired device tokens are required.
    Network,
}

impl Exposure {
    pub fn for_bind(bind: SocketAddr) -> Self {
        if bind.ip().is_loopback() {
            Self::Loopback
        } else {
            Self::Network
        }
    }
}

struct PendingCode {
    hash: [u8; 32],
    expires: Instant,
    attempts: u32,
}

#[derive(Default)]
struct Pairing {
    codes: Vec<PendingCode>,
    failures: Vec<Instant>,
}

pub(crate) struct Registry {
    exposure: Mutex<Exposure>,
    pairing: Mutex<Pairing>,
    seen: Mutex<HashMap<String, Instant>>,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export, rename = "Device"))]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub created_at: u64,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub last_seen_at: Option<u64>,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    pub code: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub expires_at: u64,
}

#[derive(Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingClaim {
    pub code: String,
    pub device_name: String,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub device_id: String,
    pub name: String,
    pub token: String,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub auth_required: bool,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
}

/// The authenticated device, attached to requests that passed the guard.
#[derive(Clone)]
pub(crate) struct DeviceIdentity {
    pub id: String,
    pub name: String,
}

pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn random_bytes<const N: usize>() -> Result<[u8; N], StatusCode> {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}

/// Accepts "482913", "482-913" or "482 913".
fn normalize_code(value: &str) -> Option<String> {
    let digits = value
        .chars()
        .filter(|c| !matches!(c, '-' | ' '))
        .collect::<String>();
    (digits.len() == 6 && digits.bytes().all(|b| b.is_ascii_digit())).then_some(digits)
}

fn valid_name(value: &str) -> Option<String> {
    let name = value.trim();
    (!name.is_empty() && name.chars().count() <= 64 && !name.chars().any(char::is_control))
        .then(|| name.to_string())
}

pub(crate) fn initialize(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS devices(
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            token_hash BLOB NOT NULL UNIQUE,
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER
        );",
    )
}

impl Registry {
    pub(crate) fn new() -> Self {
        Self {
            exposure: Mutex::new(Exposure::Loopback),
            pairing: Mutex::new(Pairing::default()),
            seen: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn set_exposure(&self, exposure: Exposure) {
        if let Ok(mut current) = self.exposure.lock() {
            *current = exposure;
        }
    }

    pub(crate) fn exposure(&self) -> Exposure {
        self.exposure
            .lock()
            .map(|value| *value)
            .unwrap_or(Exposure::Network)
    }

    pub(crate) fn auth_required(&self) -> bool {
        self.exposure() == Exposure::Network
    }

    /// Creates a new six-digit code, dropping expired ones first.
    pub(crate) fn create_code(&self) -> Result<PairingCode, StatusCode> {
        let mut pairing = self
            .pairing
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let now = Instant::now();
        pairing.codes.retain(|code| code.expires > now);
        if pairing.codes.len() >= MAX_ACTIVE_CODES {
            pairing.codes.remove(0);
        }
        let value = u32::from_le_bytes(random_bytes::<4>()?) % 1_000_000;
        let code = format!("{value:06}");
        pairing.codes.push(PendingCode {
            hash: digest(&code),
            expires: now + CODE_TTL,
            attempts: 0,
        });
        Ok(PairingCode {
            code: format!("{}-{}", &code[..3], &code[3..]),
            expires_at: now_millis() + CODE_TTL.as_millis() as u64,
        })
    }

    /// Consumes a matching code. Wrong guesses count against both the code and
    /// a global window so six digits cannot be brute-forced.
    fn redeem(&self, code: &str) -> Result<(), StatusCode> {
        let mut pairing = self
            .pairing
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let now = Instant::now();
        pairing
            .failures
            .retain(|failure| now.duration_since(*failure) < FAILURE_WINDOW);
        if pairing.failures.len() >= MAX_FAILURES_PER_WINDOW {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        pairing.codes.retain(|code| code.expires > now);
        let wanted = normalize_code(code).map(|code| digest(&code));
        if let Some(index) = wanted.and_then(|hash| {
            pairing
                .codes
                .iter()
                .position(|candidate| candidate.hash == hash)
        }) {
            pairing.codes.remove(index);
            return Ok(());
        }
        pairing.failures.push(now);
        for code in &mut pairing.codes {
            code.attempts += 1;
        }
        pairing
            .codes
            .retain(|code| code.attempts < MAX_ATTEMPTS_PER_CODE);
        Err(StatusCode::FORBIDDEN)
    }

    pub(crate) fn pair(
        &self,
        db: &Connection,
        claim: PairingClaim,
    ) -> Result<PairedDevice, StatusCode> {
        let name = valid_name(&claim.device_name).ok_or(StatusCode::BAD_REQUEST)?;
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM devices", [], |row| row.get(0))
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if count >= MAX_DEVICES {
            return Err(StatusCode::CONFLICT);
        }
        self.redeem(&claim.code)?;
        let id = hex(&random_bytes::<8>()?);
        let token = hex(&random_bytes::<32>()?);
        db.execute(
            "INSERT INTO devices(id,name,token_hash,created_at) VALUES(?1,?2,?3,?4)",
            params![id, name, digest(&token).to_vec(), now_millis()],
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        Ok(PairedDevice {
            device_id: id,
            name,
            token,
        })
    }

    pub(crate) fn authenticate(
        &self,
        db: &Connection,
        token: &str,
    ) -> Result<Option<DeviceIdentity>, StatusCode> {
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(None);
        }
        let device = db
            .query_row(
                "SELECT id,name FROM devices WHERE token_hash=?1",
                [digest(token).to_vec()],
                |row| {
                    Ok(DeviceIdentity {
                        id: row.get(0)?,
                        name: row.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if let Some(device) = &device {
            self.touch(db, &device.id);
        }
        Ok(device)
    }

    /// Records last-seen at most once a minute so streaming does not write per segment.
    fn touch(&self, db: &Connection, id: &str) {
        let Ok(mut seen) = self.seen.lock() else {
            return;
        };
        let now = Instant::now();
        if seen
            .get(id)
            .is_some_and(|last| now.duration_since(*last) < SEEN_INTERVAL)
        {
            return;
        }
        seen.insert(id.to_string(), now);
        let _ = db.execute(
            "UPDATE devices SET last_seen_at=?1 WHERE id=?2",
            params![now_millis(), id],
        );
    }

    pub(crate) fn list(db: &Connection) -> rusqlite::Result<Vec<DeviceInfo>> {
        let mut statement =
            db.prepare("SELECT id,name,created_at,last_seen_at FROM devices ORDER BY created_at")?;
        statement
            .query_map([], |row| {
                Ok(DeviceInfo {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    last_seen_at: row.get(3)?,
                })
            })?
            .collect()
    }

    pub(crate) fn revoke(&self, db: &Connection, id: &str) -> Result<bool, StatusCode> {
        if let Ok(mut seen) = self.seen.lock() {
            seen.remove(id);
        }
        db.execute("DELETE FROM devices WHERE id=?1", [id])
            .map(|count| count > 0)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
    }

    pub(crate) fn has_devices(db: &Connection) -> bool {
        db.query_row("SELECT EXISTS(SELECT 1 FROM devices)", [], |row| {
            row.get::<_, bool>(0)
        })
        .unwrap_or(false)
    }
}

fn bearer(headers: &HeaderMap) -> Result<Option<&str>, StatusCode> {
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(StatusCode::UNAUTHORIZED);
    }
    value
        .to_str()
        .ok()
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(Some)
        .ok_or(StatusCode::UNAUTHORIZED)
}

/// Media elements (`<video>`, `<img>`, `<track>`) cannot send headers, so read-only
/// media routes also accept `access_token` in the query string, as Jellyfin does.
fn query_token(request: &Request) -> Option<String> {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return None;
    }
    let path = request.uri().path();
    let media_route = path.starts_with("/api/media/")
        && ["/stream", "/poster", "/backdrop"]
            .iter()
            .any(|suffix| path.ends_with(suffix))
        || path.starts_with("/api/media/")
            && (path.contains("/hls/") || path.contains("/subtitles/"));
    if !media_route {
        return None;
    }
    request.uri().query()?.split('&').find_map(|pair| {
        pair.strip_prefix("access_token=")
            .filter(|value| value.len() == 64)
            .map(str::to_string)
    })
}

fn open_route(path: &str) -> bool {
    path == "/health" || path == "/api/pairing/claim" || !path.starts_with("/api/")
}

fn management_route(path: &str) -> bool {
    path == "/api/pairing/codes"
        || path == "/api/devices"
        || path.starts_with("/api/devices/")
        || path == "/api/admin/rescan"
}

/// A request is from this machine when its socket peer is loopback and its
/// Host and Origin pass the loopback checks that stop DNS rebinding.
pub(crate) fn local_request(request: &Request) -> bool {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .is_some_and(|ConnectInfo(peer)| peer.ip().is_loopback())
        && request_boundary::loopback_request(request.headers(), request.uri())
}

pub(crate) async fn guard(
    State(library): State<Arc<Library>>,
    mut request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let path = request.uri().path().to_string();
    if management_route(&path) {
        let admin = request
            .extensions()
            .get::<ManagementAccess>()
            .is_some_and(|access| access.can_manage_libraries(request.headers()));
        if !(admin || local_request(&request)) {
            return Err(StatusCode::FORBIDDEN);
        }
        return Ok(next.run(request).await);
    }
    if !library.devices.auth_required() || open_route(&path) {
        return Ok(next.run(request).await);
    }
    let token = match bearer(request.headers())? {
        Some(token) => token.to_string(),
        None => query_token(&request).ok_or(StatusCode::UNAUTHORIZED)?,
    };
    let device = {
        let db = library
            .database
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        library.devices.authenticate(&db, &token)?
    }
    .ok_or(StatusCode::UNAUTHORIZED)?;
    request.extensions_mut().insert(device);
    Ok(next.run(request).await)
}

pub(crate) async fn create_code(
    State(library): State<Arc<Library>>,
) -> Result<impl IntoResponse, StatusCode> {
    let code = library.devices.create_code()?;
    Ok((
        StatusCode::CREATED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(code),
    ))
}

pub(crate) async fn claim(
    State(library): State<Arc<Library>>,
    Json(claim): Json<PairingClaim>,
) -> Result<impl IntoResponse, StatusCode> {
    let db = library
        .database
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let device = library.devices.pair(&db, claim)?;
    Ok((
        StatusCode::CREATED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(device),
    ))
}

pub(crate) async fn list(
    State(library): State<Arc<Library>>,
) -> Result<impl IntoResponse, StatusCode> {
    let db = library
        .database
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let devices = Registry::list(&db).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({ "apiVersion": 1, "items": devices })),
    ))
}

pub(crate) async fn revoke(
    State(library): State<Arc<Library>>,
    ApiPath(id): ApiPath<String>,
) -> Result<StatusCode, StatusCode> {
    let db = library
        .database
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if library.devices.revoke(&db, &id)? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}

pub(crate) async fn session(
    State(library): State<Arc<Library>>,
    request: Request,
) -> Json<Session> {
    let device = request.extensions().get::<DeviceIdentity>();
    Json(Session {
        auth_required: library.devices.auth_required(),
        device_id: device.map(|device| device.id.clone()),
        device_name: device.map(|device| device.name.clone()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
        db
    }

    fn claim(code: &str) -> PairingClaim {
        PairingClaim {
            code: code.into(),
            device_name: "Living room Shield".into(),
        }
    }

    #[test]
    fn a_code_pairs_one_device_once() {
        let db = database();
        let registry = Registry::new();
        let code = registry.create_code().unwrap();
        let device = registry.pair(&db, claim(&code.code)).unwrap();
        assert_eq!(device.token.len(), 64);
        assert_eq!(
            registry.pair(&db, claim(&code.code)).err(),
            Some(StatusCode::FORBIDDEN)
        );
        let identity = registry.authenticate(&db, &device.token).unwrap().unwrap();
        assert_eq!(identity.id, device.device_id);
        assert_eq!(identity.name, "Living room Shield");
    }

    #[test]
    fn codes_accept_separators_and_reject_bad_names() {
        let db = database();
        let registry = Registry::new();
        let code = registry.create_code().unwrap();
        let bad = PairingClaim {
            code: code.code.clone(),
            device_name: " \n".into(),
        };
        assert_eq!(registry.pair(&db, bad).err(), Some(StatusCode::BAD_REQUEST));
        let digits = code.code.replace('-', " ");
        assert!(registry.pair(&db, claim(&digits)).is_ok());
    }

    #[test]
    fn wrong_guesses_burn_codes_and_trip_the_rate_limit() {
        let db = database();
        let registry = Registry::new();
        let code = registry.create_code().unwrap();
        let wrong = if code.code == "000-000" {
            "000-001"
        } else {
            "000-000"
        };
        for _ in 0..MAX_ATTEMPTS_PER_CODE {
            assert_eq!(
                registry.pair(&db, claim(wrong)).err(),
                Some(StatusCode::FORBIDDEN)
            );
        }
        // The real code was invalidated by repeated wrong guesses.
        assert_eq!(
            registry.pair(&db, claim(&code.code)).err(),
            Some(StatusCode::FORBIDDEN)
        );
        for _ in 0..MAX_FAILURES_PER_WINDOW {
            let _ = registry.pair(&db, claim(wrong));
        }
        let fresh = registry.create_code().unwrap();
        assert_eq!(
            registry.pair(&db, claim(&fresh.code)).err(),
            Some(StatusCode::TOO_MANY_REQUESTS)
        );
    }

    #[test]
    fn revoked_tokens_stop_working() {
        let db = database();
        let registry = Registry::new();
        let code = registry.create_code().unwrap();
        let device = registry.pair(&db, claim(&code.code)).unwrap();
        assert!(registry.revoke(&db, &device.device_id).unwrap());
        assert!(registry.authenticate(&db, &device.token).unwrap().is_none());
        assert!(!registry.revoke(&db, &device.device_id).unwrap());
    }

    #[test]
    fn malformed_tokens_never_reach_the_database() {
        let db = database();
        let registry = Registry::new();
        assert!(registry.authenticate(&db, "short").unwrap().is_none());
        assert!(
            registry
                .authenticate(&db, &"z".repeat(64))
                .unwrap()
                .is_none()
        );
    }
}
