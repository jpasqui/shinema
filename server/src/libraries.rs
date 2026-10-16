//! Library configuration changes indexed membership, never the approved source
//! roots, source identity, filesystem permissions, or saved playback progress.
use crate::{Entry, Media, catalog, metadata};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::Path};

/// Transitional operator authorization for the loopback development server.
/// Future owner/account authorization belongs behind can_manage_libraries;
/// library configuration itself never reads credentials or assumes a profile.
#[derive(Clone)]
pub(crate) struct ManagementAccess(Option<String>);

impl ManagementAccess {
    pub(crate) fn new(token: Option<String>) -> Self {
        Self(token.filter(|token| {
            token.len() >= 32
                && token.len() <= 256
                && token.bytes().all(|byte| byte.is_ascii_graphic())
        }))
    }

    pub(crate) fn can_manage_libraries(&self, headers: &axum::http::HeaderMap) -> bool {
        let Some(expected) = &self.0 else {
            return false;
        };
        let mut values = headers.get_all(axum::http::header::AUTHORIZATION).iter();
        let Some(provided) = values
            .next()
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
        else {
            return false;
        };
        if values.next().is_some() || provided.len() > 256 {
            return false;
        }
        let expected = Sha256::digest(expected.as_bytes());
        let provided = Sha256::digest(provided.as_bytes());
        expected
            .iter()
            .zip(provided.iter())
            .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
            == 0
    }
}

pub(crate) async fn management_guard(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, axum::http::StatusCode> {
    if !request
        .extensions()
        .get::<ManagementAccess>()
        .is_some_and(|access| access.can_manage_libraries(request.headers()))
    {
        return Err(axum::http::StatusCode::FORBIDDEN);
    }
    Ok(next.run(request).await)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LibraryConfig {
    pub id: String,
    pub name: String,
    pub media_type: MediaType,
    pub visible: bool,
    pub order: u32,
    pub source_folders: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MediaType {
    Movies,
    Tv,
    Mixed,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Update {
    pub revision: u64,
    pub libraries: Vec<LibraryConfig>,
}

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 48
        && id.as_bytes()[0].is_ascii_lowercase()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn invalid_name_char(value: char) -> bool {
    value.is_control()
        || matches!(value, '\u{ad}' | '\u{600}'..='\u{605}' | '\u{61c}' | '\u{6dd}' | '\u{70f}' | '\u{890}'..='\u{891}' | '\u{8e2}' | '\u{180e}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206f}' | '\u{feff}' | '\u{fff9}'..='\u{fffb}' | '\u{110bd}' | '\u{110cd}' | '\u{13430}'..='\u{1343f}' | '\u{1bca0}'..='\u{1bca3}' | '\u{1d173}'..='\u{1d17a}' | '\u{e0001}' | '\u{e0020}'..='\u{e007f}')
}

fn valid_folder(folder: &str) -> bool {
    folder == "."
        || (!folder.is_empty()
            && folder.chars().count() <= 512
            && !folder.contains(['\\', ':'])
            && !folder.chars().any(char::is_control)
            && folder
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != ".."))
}

fn validate(libraries: &[LibraryConfig]) -> Result<(), &'static str> {
    if libraries.is_empty() || libraries.len() > 64 {
        return Err("Use between one and 64 libraries");
    }
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    let mut folders = BTreeSet::new();
    let mut catchall = false;
    for library in libraries {
        if !valid_id(&library.id) || !ids.insert(&library.id) {
            return Err("Library IDs must be unique stable lowercase identifiers");
        }
        if library.name.trim() != library.name
            || library.name.is_empty()
            || library.name.chars().count() > 80
            || library.name.chars().any(invalid_name_char)
            || !names.insert(library.name.to_lowercase())
        {
            return Err("Library names must be unique, nonblank, and at most 80 characters");
        }
        if library.order > 10000 || library.source_folders.len() > 64 {
            return Err("Library order or folder count exceeds its limit");
        }
        if library.id == "other" {
            if library.media_type != MediaType::Mixed || !library.source_folders.is_empty() {
                return Err("The Other library must retain mixed type and automatic membership");
            }
            catchall = true;
        }
        for folder in &library.source_folders {
            if !valid_folder(folder) || !folders.insert(folder) {
                return Err("Source folders must be unique approved relative folders");
            }
        }
    }
    if !catchall {
        return Err("Keep the Other library to retain media outside selected folders");
    }
    Ok(())
}

fn defaults(
    entries: &std::collections::BTreeMap<String, Entry>,
    folders: &BTreeSet<String>,
) -> Vec<LibraryConfig> {
    let uncovered = entries.values().any(|entry| {
        !matches!(
            entry.media.classification.collection.as_deref(),
            Some("tv" | "movies")
        )
    });
    [
        ("movies", "Movies", MediaType::Movies, true),
        ("tv", "TV shows", MediaType::Tv, true),
        ("other", "Other videos", MediaType::Mixed, uncovered),
    ]
    .into_iter()
    .enumerate()
    .map(|(order, (id, name, media_type, visible))| LibraryConfig {
        id: id.into(),
        name: name.into(),
        media_type,
        visible,
        order: order as u32,
        source_folders: if id == "other" {
            vec![]
        } else {
            let matching = folders
                .iter()
                .filter(|folder| !folder.contains('/') && folder.eq_ignore_ascii_case(id))
                .cloned()
                .collect::<Vec<_>>();
            if matching.is_empty() {
                vec![id.into()]
            } else {
                matching
            }
        },
    })
    .collect()
}

pub(crate) fn initialize(
    db: &Connection,
    entries: &std::collections::BTreeMap<String, Entry>,
    folders: &BTreeSet<String>,
) -> Result<Vec<LibraryConfig>, Box<dyn std::error::Error>> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS library_configuration(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,revision INTEGER NOT NULL,config_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS library_membership(media_id TEXT PRIMARY KEY,library_id TEXT NOT NULL); CREATE INDEX IF NOT EXISTS library_membership_library ON library_membership(library_id,media_id);")?;
    let saved: Option<(u32, u64, String)> = db
        .query_row(
            "SELECT version,revision,config_json FROM library_configuration WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if let Some((version, revision, json)) = saved {
        if version != 1 || revision == 0 || revision > 9_007_199_254_740_991 {
            return Err("Unsupported saved library configuration version".into());
        }
        let libraries: Vec<LibraryConfig> = serde_json::from_str(&json)?;
        validate(&libraries)?;
        Ok(libraries)
    } else {
        let libraries = defaults(entries, folders);
        db.execute(
            "INSERT INTO library_configuration VALUES(1,1,1,?1)",
            [serde_json::to_string(&libraries)?],
        )?;
        Ok(libraries)
    }
}

pub(crate) fn read(
    db: &Connection,
    admin: bool,
    folders: &BTreeSet<String>,
) -> rusqlite::Result<serde_json::Value> {
    let (revision, json): (u64, String) = db.query_row(
        "SELECT revision,config_json FROM library_configuration WHERE singleton=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let mut libraries: Vec<LibraryConfig> =
        serde_json::from_str(&json).map_err(|_| rusqlite::Error::InvalidQuery)?;
    libraries.sort_by(|a, b| a.order.cmp(&b.order).then(a.id.cmp(&b.id)));
    let rows = libraries
        .into_iter()
        .map(|library| {
            let mut value = serde_json::to_value(library).expect("Library serialization");
            if !admin {
                value
                    .as_object_mut()
                    .expect("Library object")
                    .remove("sourceFolders");
            }
            value
        })
        .collect::<Vec<_>>();
    let mut result = serde_json::json!({"version":1,"revision":revision,"libraries":rows});
    if admin {
        result["availableFolders"] = serde_json::to_value(
            folders
                .iter()
                .filter(|folder| valid_folder(folder))
                .take(10000)
                .collect::<Vec<_>>(),
        )
        .expect("Folder serialization");
        result["availableFoldersTruncated"] = (folders.len() > 10000).into();
    }
    Ok(result)
}

pub(crate) fn update(
    db: &mut Connection,
    value: Update,
    entries: &std::collections::BTreeMap<String, Entry>,
    folders: &BTreeSet<String>,
) -> Result<(), axum::http::StatusCode> {
    use axum::http::StatusCode;
    validate(&value.libraries).map_err(|_| StatusCode::BAD_REQUEST)?;
    let current = read(db, true, folders).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if current["revision"].as_u64() != Some(value.revision) {
        return Err(StatusCode::CONFLICT);
    }
    // A previously selected folder can temporarily disappear. Retaining it is
    // harmless: configuration only assigns entries from the successful scan.
    let previous: Vec<LibraryConfig> = serde_json::from_value(current["libraries"].clone())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    for library in &value.libraries {
        for folder in &library.source_folders {
            if !folders.contains(folder)
                && !previous
                    .iter()
                    .any(|old| old.id == library.id && old.source_folders.contains(folder))
            {
                return Err(StatusCode::BAD_REQUEST);
            }
        }
    }
    let next = value
        .revision
        .checked_add(1)
        .filter(|next| *next <= 9_007_199_254_740_991)
        .ok_or(StatusCode::CONFLICT)?;
    let transaction = db
        .transaction()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let membership = |libraries: &[LibraryConfig]| {
        libraries
            .iter()
            .map(|library| {
                (
                    library.id.clone(),
                    (
                        library.media_type,
                        library
                            .source_folders
                            .iter()
                            .cloned()
                            .collect::<BTreeSet<_>>(),
                    ),
                )
            })
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    if membership(&previous) != membership(&value.libraries) {
        let items = assign(entries, &value.libraries);
        catalog::update_membership(&transaction, items.into_iter())
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    transaction
        .execute(
            "UPDATE library_configuration SET revision=?1,config_json=?2 WHERE singleton=1",
            params![
                next,
                serde_json::to_string(&value.libraries)
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            ],
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    transaction
        .commit()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn source_match(relative: &Path, folder: &str) -> bool {
    folder == "." || relative.starts_with(Path::new(folder))
}

pub(crate) fn assign(
    entries: &std::collections::BTreeMap<String, Entry>,
    libraries: &[LibraryConfig],
) -> Vec<Media> {
    let catchall = libraries
        .iter()
        .find(|library| library.id == "other")
        .expect("Validated catchall");
    entries
        .values()
        .map(|entry| {
            // Most specific source wins, so tv/Anime can be split from tv without
            // manually enumerating every sibling folder. Equal sources are invalid.
            let selected = libraries
                .iter()
                .flat_map(|library| {
                    library
                        .source_folders
                        .iter()
                        .map(move |folder| (library, folder))
                })
                .filter(|(_, folder)| source_match(&entry.relative, folder))
                .max_by_key(|(_, folder)| {
                    if folder.as_str() == "." {
                        0
                    } else {
                        folder.split('/').count()
                    }
                });
            let (library, folder) = selected
                .map(|(library, folder)| (library, Some(folder)))
                .unwrap_or((catchall, None));
            let mut item = entry.media.clone();
            item.presentation = Default::default();
            item.title = entry
                .relative
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .chars()
                .take(200)
                .collect::<String>()
                .replace('_', " ");
            match library.media_type {
                MediaType::Mixed => (),
                MediaType::Movies => {
                    item.classification = catalog::Classification {
                        collection: Some("movies".into()),
                        ..Default::default()
                    }
                }
                MediaType::Tv => {
                    let folder = folder.expect("TV source folder");
                    if !(library.id == "tv"
                        && folder.eq_ignore_ascii_case("tv")
                        && item.classification.collection.as_deref() == Some("tv"))
                    {
                        let relative = if folder == "." {
                            entry.relative.as_path()
                        } else {
                            entry.relative.strip_prefix(folder).expect("Matched folder")
                        };
                        item.classification = catalog::classify(&Path::new("tv").join(relative));
                        if let Some(series) = &item.classification.series_id {
                            item.classification.series_id = Some(format!(
                                "{:x}",
                                Sha256::digest(
                                    format!(
                                        "shinema-library-series-v1\0{}\0{}\0{}",
                                        library.id, folder, series
                                    )
                                    .as_bytes()
                                )
                            ));
                        }
                    }
                }
            }
            // A mixed library may contain legacy TV rows; split series remain
            // scoped to the selected library rather than merging back into TV.
            if library.media_type == MediaType::Mixed
                && let Some(series) = &item.classification.series_id
            {
                item.classification.series_id = Some(format!(
                    "{:x}",
                    Sha256::digest(
                        format!(
                            "shinema-library-series-v1\0{}\0{}\0{}",
                            library.id,
                            folder.map(String::as_str).unwrap_or(""),
                            series
                        )
                        .as_bytes()
                    )
                ));
            }
            item.classification.library_id = Some(library.id.clone());
            metadata::prepare(&mut item);
            if item.classification.collection.as_deref() == Some("movies")
                && item.presentation.year.is_none()
            {
                item.presentation.year = entry
                    .relative
                    .parent()
                    .and_then(Path::file_name)
                    .and_then(|part| part.to_str())
                    .and_then(|part| metadata::title_year(part).1);
            }
            item
        })
        .collect()
}
