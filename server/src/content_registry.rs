//! Declarative identifiers describe installed capabilities, never commands,
//! launch URLs, provider credentials, or additional filesystem authority.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, sync::OnceLock};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Capabilities {
    pub metadata: bool,
    pub play: bool,
    pub view: bool,
    pub launch: bool,
}

impl Capabilities {
    fn any(self) -> bool {
        self.metadata || self.play || self.view || self.launch
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Availability {
    Available,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ContentType {
    pub id: String,
    pub name: String,
    pub availability: Availability,
    pub capabilities: Capabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Format {
    pub id: String,
    pub name: String,
    pub extensions: Vec<String>,
    pub mime_types: Vec<String>,
    pub availability: Availability,
    pub capabilities: Capabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Registry {
    pub version: u32,
    pub content_types: Vec<ContentType>,
    pub formats: Vec<Format>,
}

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 48
        && id.as_bytes()[0].is_ascii_lowercase()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_extension(extension: &str) -> bool {
    !extension.is_empty()
        && extension.len() <= 48
        && extension.as_bytes()[0].is_ascii_alphanumeric()
        && extension
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_mime(mime: &str) -> bool {
    if mime.len() > 127 {
        return false;
    }
    let Some((kind, subtype)) = mime.split_once('/') else {
        return false;
    };
    [kind, subtype].iter().all(|part| {
        !part.is_empty()
            && part.as_bytes()[0].is_ascii_alphanumeric()
            && part.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"!#$&^_.+-".contains(&byte)
            })
    })
}

fn valid_descriptor(
    id: &str,
    name: &str,
    availability: Availability,
    capabilities: Capabilities,
    reason: Option<&str>,
) -> bool {
    valid_id(id)
        && !name.is_empty()
        && name.trim() == name
        && name.chars().count() <= 80
        && !name.chars().any(char::is_control)
        && reason.is_none_or(|reason| {
            !reason.is_empty()
                && reason.chars().count() <= 512
                && !reason.chars().any(char::is_control)
        })
        && (availability != Availability::Unavailable || (!capabilities.any() && reason.is_some()))
}

impl Registry {
    fn parse(source: &str) -> Result<Self, &'static str> {
        let registry: Self =
            serde_json::from_str(source).map_err(|_| "Invalid content registry JSON")?;
        if registry.version != 1
            || registry.content_types.len() > 128
            || registry.formats.len() > 128
        {
            return Err("Invalid content registry bounds");
        }
        let mut ids = BTreeSet::new();
        for kind in &registry.content_types {
            if !valid_descriptor(
                &kind.id,
                &kind.name,
                kind.availability,
                kind.capabilities,
                kind.reason.as_deref(),
            ) || !ids.insert(&kind.id)
            {
                return Err("Invalid content type descriptor");
            }
        }
        let mut ids = BTreeSet::new();
        let mut extensions = BTreeSet::new();
        for format in &registry.formats {
            if !valid_descriptor(
                &format.id,
                &format.name,
                format.availability,
                format.capabilities,
                format.reason.as_deref(),
            ) || !ids.insert(&format.id)
                || format.extensions.is_empty()
                || format.extensions.len() > 32
                || format.mime_types.is_empty()
                || format.mime_types.len() > 32
                || format
                    .extensions
                    .iter()
                    .any(|extension| !valid_extension(extension) || !extensions.insert(extension))
                || format.mime_types.iter().any(|mime| !valid_mime(mime))
                || format.mime_types.iter().collect::<BTreeSet<_>>().len()
                    != format.mime_types.len()
            {
                return Err("Invalid format descriptor");
            }
        }
        Ok(registry)
    }
}

pub(crate) fn builtin() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        Registry::parse(include_str!(
            "../../packages/contracts/content-registry.json"
        ))
        .expect("Validated builtin registry")
    })
}

pub(crate) fn for_types<'a>(ids: impl Iterator<Item = &'a str>) -> Registry {
    let mut registry = builtin().clone();
    let unknown = ids
        .filter(|id| valid_id(id) && !registry.content_types.iter().any(|kind| kind.id == *id))
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    for id in unknown {
        registry.content_types.push(ContentType {
            name: id.clone(),
            id,
            availability: Availability::Unavailable,
            capabilities: Capabilities::default(),
            reason: Some("No installed adapter supports this content type".into()),
        });
    }
    registry
}

pub(crate) fn format(extension: &str) -> Option<&'static Format> {
    builtin().formats.iter().find(|format| {
        format
            .extensions
            .iter()
            .any(|candidate| candidate == extension)
    })
}

pub(crate) fn scan_extensions() -> Vec<&'static str> {
    builtin()
        .formats
        .iter()
        .filter(|format| format.availability == Availability::Available && format.capabilities.play)
        .flat_map(|format| format.extensions.iter().map(String::as_str))
        .collect()
}

pub(crate) fn supports_play(content_type: Option<&str>, extension: &str) -> bool {
    let supported_type = content_type.is_none_or(|id| {
        builtin().content_types.iter().any(|kind| {
            kind.id == id && kind.availability == Availability::Available && kind.capabilities.play
        })
    });
    supported_type
        && format(extension).is_some_and(|format| {
            format.availability == Availability::Available && format.capabilities.play
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_registry_is_data_only_and_keeps_exact_existing_inventory() {
        assert_eq!(builtin().content_types.len(), 2);
        assert_eq!(
            scan_extensions(),
            [
                "mp4", "m4v", "mkv", "webm", "avi", "ts", "m2ts", "mov", "mpg", "mpeg", "wmv",
                "vob"
            ]
        );
        assert!(format("docx").is_none());
        assert!(format("mp3").is_none());
        assert!(format("exe").is_none());
        assert!(!supports_play(Some("games"), "mp4"));
        assert!(supports_play(None, "mp4"));
        let registry = for_types(["games", "games"].into_iter());
        let games = registry.content_types.last().unwrap();
        assert_eq!(games.availability, Availability::Unavailable);
        assert!(!games.capabilities.any());
    }

    #[test]
    fn unsafe_or_ambiguous_manifest_identifiers_are_rejected() {
        let original = serde_json::to_value(builtin()).unwrap();
        for (field, invalid) in [
            ("extensions", serde_json::json!(["../mp4"])),
            ("extensions", serde_json::json!([".mp4"])),
            ("mimeTypes", serde_json::json!(["video/mp4\r\nX-Test:yes"])),
            ("mimeTypes", serde_json::json!(["text/html; charset=utf-8"])),
        ] {
            let mut value = original.clone();
            value["formats"][0][field] = invalid;
            assert!(Registry::parse(&value.to_string()).is_err());
        }
        let mut value = original.clone();
        value["formats"][0]["id"] = "../unsafe".into();
        assert!(Registry::parse(&value.to_string()).is_err());
        let mut value = original.clone();
        value["formats"][1]["extensions"] = serde_json::json!(["mp4"]);
        assert!(Registry::parse(&value.to_string()).is_err());
        let mut value = original;
        value["contentTypes"][0]["launchCommand"] = "execute-me".into();
        assert!(Registry::parse(&value.to_string()).is_err());
    }
}
