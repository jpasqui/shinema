//! Pinned request contracts: Sonarr 4.0.20.3014 (API v3) and
//! 5.0.0.2635 beta (API v5). Product major and HTTP API version are distinct.
//! Source: https://github.com/Sonarr/Sonarr/tree/a2b6054a8f3746d149a811bddea2a8d063efc35e/src/Sonarr.Api.V5
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ApiVersion {
    V3,
    V5,
}

impl ApiVersion {
    pub(super) fn path(self) -> &'static str {
        match self {
            Self::V3 => "v3",
            Self::V5 => "v5",
        }
    }
}

pub(super) struct Release {
    pub(super) version: String,
    pub(super) api: ApiVersion,
}

pub(super) enum Failure {
    Unavailable,
    // Only a validated numeric version can be retained. Never echo a raw body.
    Unsupported(Option<String>),
}

impl Release {
    pub(super) fn parse(status: &Value) -> Result<Self, Failure> {
        if status.get("appName").and_then(Value::as_str) != Some("Sonarr") {
            return Err(Failure::Unsupported(None));
        }
        let version = status
            .get("version")
            .and_then(Value::as_str)
            .filter(|value| value.len() <= 43)
            .ok_or(Failure::Unsupported(None))?;
        let parts = version.split('.').collect::<Vec<_>>();
        if parts.len() != 4
            || parts.iter().any(|part| {
                part.is_empty()
                    || !part.bytes().all(|b| b.is_ascii_digit())
                    || (part.len() > 1 && part.starts_with('0'))
                    || part.parse::<i32>().is_err()
            })
        {
            return Err(Failure::Unsupported(None));
        }
        let api = match parts[0] {
            "4" => ApiVersion::V3,
            "5" => ApiVersion::V5,
            _ => return Err(Failure::Unsupported(Some(version.into()))),
        };
        Ok(Self {
            version: version.into(),
            api,
        })
    }
}
