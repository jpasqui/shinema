//! Paged queries over the complete local SQLite index. Source paths never leave
//! the server. Filename-derived grouping is intentionally separate from future
//! external metadata matching.
use crate::Media;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

pub(crate) const CONTAINERS: &[&str] = &[
    "mp4", "m4v", "mkv", "webm", "avi", "ts", "m2ts", "mov", "mpg", "mpeg", "wmv", "vob",
];

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Classification {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub season: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub episode: Option<u32>,
}

fn text(value: &str) -> String {
    value.chars().take(200).collect()
}

/// Parse the common S01E02 form without regex dependencies or lossy path IDs.
fn numbers(value: &str) -> Option<(u32, u32)> {
    let bytes = value.as_bytes();
    for start in 0..bytes.len() {
        if !matches!(bytes[start], b'S' | b's') {
            continue;
        }
        let mut end = start + 1;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end == start + 1 || end >= bytes.len() || !matches!(bytes[end], b'E' | b'e') {
            continue;
        }
        let season = value[start + 1..end].parse().ok()?;
        let episode_start = end + 1;
        end = episode_start;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end > episode_start {
            return Some((season, value[episode_start..end].parse().ok()?));
        }
    }
    None
}

pub(crate) fn classify(relative: &Path) -> Classification {
    let parts = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let kind = parts
        .first()
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if kind == "movies" {
        return Classification {
            collection: Some(kind),
            ..Default::default()
        };
    }
    if kind != "tv" {
        return Classification::default();
    }
    let series = if parts.len() > 2 {
        &parts[1]
    } else {
        "Ungrouped episodes"
    };
    let id = format!(
        "{:x}",
        Sha256::digest(format!("shinema-series-v1\0tv\0{series}").as_bytes())
    );
    let pair = relative
        .file_name()
        .and_then(|s| s.to_str())
        .and_then(numbers)
        .filter(|(season, episode)| *season <= 10000 && *episode <= 10000);
    let season = pair.map(|p| p.0).or_else(|| {
        parts.iter().find_map(|s| {
            s.to_ascii_lowercase()
                .strip_prefix("season ")
                .and_then(|n| n.trim().parse().ok())
        })
    });
    let season = season.filter(|n| *n <= 10000);
    Classification {
        collection: Some(kind),
        series_id: Some(id),
        series_title: Some(text(series)),
        season,
        episode: pair.map(|p| p.1),
    }
}

pub(crate) fn replace_index(
    db: &mut Connection,
    items: impl Iterator<Item = Media>,
) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS media_catalog(id TEXT PRIMARY KEY, title TEXT NOT NULL, collection TEXT, series_id TEXT, series_title TEXT, season INTEGER, episode INTEGER, media_json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS media_browse ON media_catalog(collection,series_id,season,episode,title,id);")?;
    let transaction = db.transaction()?;
    transaction.execute("DELETE FROM media_catalog", [])?;
    {
        let mut statement =
            transaction.prepare("INSERT INTO media_catalog VALUES (?1,?2,?3,?4,?5,?6,?7,?8)")?;
        for item in items {
            let json = serde_json::to_string(&item).expect("Media serialization cannot fail");
            statement.execute(params![
                item.id,
                item.title,
                item.classification.collection,
                item.classification.series_id,
                item.classification.series_title,
                item.classification.season,
                item.classification.episode,
                json
            ])?;
        }
    }
    transaction.commit()
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection: Option<String>,
    pub series: Option<String>,
    pub season: Option<u32>,
    pub search: Option<String>,
    pub offset: Option<u32>,
    pub limit: Option<u32>,
}
impl CatalogQuery {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self
            .collection
            .as_deref()
            .is_some_and(|s| !["all", "tv", "movies"].contains(&s))
            || self.series.as_deref().is_some_and(|s| {
                s.len() != 64
                    || !s
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            })
            || self
                .search
                .as_ref()
                .is_some_and(|s| s.chars().count() > 200)
            || self.limit.is_some_and(|n| n == 0 || n > 500)
            || self.offset.is_some_and(|n| n > 10_000_000)
            || self.season.is_some_and(|n| n > 10000)
        {
            return Err("Invalid catalog query");
        }
        Ok(())
    }
}

pub(crate) fn page(
    db: &Connection,
    query: CatalogQuery,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    query.validate()?;
    let collection = query.collection.filter(|s| s != "all");
    let search = query.search.unwrap_or_default();
    let offset = query.offset.unwrap_or(0);
    let limit = query.limit.unwrap_or(500);
    let filter = "(?1 IS NULL OR collection=?1) AND (?2 IS NULL OR series_id=?2) AND (?3 IS NULL OR season=?3) AND (?4='' OR instr(lower(title),lower(?4))>0 OR instr(lower(coalesce(series_title,'')),lower(?4))>0)";
    let total: u32 = db.query_row(
        &format!("SELECT count(*) FROM media_catalog WHERE {filter}"),
        params![collection, query.series, query.season, search],
        |row| row.get(0),
    )?;
    let mut statement = db.prepare(&format!("SELECT media_json FROM media_catalog WHERE {filter} ORDER BY CASE WHEN series_id IS NULL THEN title ELSE series_title END COLLATE NOCASE, season, episode, title COLLATE NOCASE,id LIMIT ?5 OFFSET ?6"))?;
    let items = statement
        .query_map(
            params![
                collection,
                query.series,
                query.season,
                search,
                limit,
                offset
            ],
            |row| row.get::<_, String>(0),
        )?
        .map(|row| Ok(serde_json::from_str::<Media>(&row?)?))
        .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
    let next = offset.saturating_add(items.len() as u32);
    Ok(
        serde_json::json!({"apiVersion":1,"items":items,"total":total,"offset":offset,"limit":limit,"nextOffset":if next<total {Some(next)} else {None}}),
    )
}

pub(crate) fn summary(db: &Connection) -> rusqlite::Result<serde_json::Value> {
    let total: u32 = db.query_row("SELECT count(*) FROM media_catalog", [], |row| row.get(0))?;
    let tv: u32 = db.query_row(
        "SELECT count(*) FROM media_catalog WHERE collection='tv'",
        [],
        |row| row.get(0),
    )?;
    let movies: u32 = db.query_row(
        "SELECT count(*) FROM media_catalog WHERE collection='movies'",
        [],
        |row| row.get(0),
    )?;
    let series: u32 = db.query_row(
        "SELECT count(DISTINCT series_id) FROM media_catalog",
        [],
        |row| row.get(0),
    )?;
    Ok(serde_json::json!({"total":total,"tv":tv,"movies":movies,"series":series}))
}

pub(crate) fn series(
    db: &Connection,
    query: CatalogQuery,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    query.validate()?;
    let search = query.search.unwrap_or_default();
    let offset = query.offset.unwrap_or(0);
    let limit = query.limit.unwrap_or(60);
    let total: u32=db.query_row("SELECT count(DISTINCT series_id) FROM media_catalog WHERE collection='tv' AND (?1='' OR instr(lower(series_title),lower(?1))>0)", [&search], |row|row.get(0))?;
    let mut statement=db.prepare("SELECT series_id,series_title,count(*),count(DISTINCT season) FROM media_catalog WHERE collection='tv' AND (?1='' OR instr(lower(series_title),lower(?1))>0) GROUP BY series_id ORDER BY series_title COLLATE NOCASE,series_id LIMIT ?2 OFFSET ?3")?;
    let items=statement.query_map(params![search,limit,offset],|row|Ok(serde_json::json!({"id":row.get::<_,String>(0)?,"title":row.get::<_,String>(1)?,"episodes":row.get::<_,u32>(2)?,"seasons":row.get::<_,u32>(3)?})))?.collect::<Result<Vec<_>,_>>()?;
    let next = offset.saturating_add(items.len() as u32);
    Ok(
        serde_json::json!({"items":items,"total":total,"offset":offset,"limit":limit,"nextOffset":if next<total {Some(next)} else {None}}),
    )
}

pub(crate) fn seasons(db: &Connection, id: &str) -> rusqlite::Result<serde_json::Value> {
    let mut statement=db.prepare("SELECT season,count(*) FROM media_catalog WHERE series_id=?1 GROUP BY season ORDER BY season")?;
    let items=statement.query_map([id],|row|Ok(serde_json::json!({"season":row.get::<_,Option<u32>>(0)?,"episodes":row.get::<_,u32>(1)?})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(serde_json::json!({"items":items}))
}
