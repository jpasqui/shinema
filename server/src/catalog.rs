//! Paged queries over the complete local SQLite index. Source paths never leave
//! the server. Filename-derived grouping is intentionally separate from future
//! external metadata matching.
use crate::Media;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Classification {
    pub content_type_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub library_id: Option<String>,
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
        library_id: None,
        collection: Some(kind),
        series_id: Some(id),
        series_title: Some(text(series)),
        season,
        episode: pair.map(|p| p.1),
        ..Default::default()
    }
}

pub(crate) fn replace_index(
    db: &mut Connection,
    items: impl Iterator<Item = Media>,
) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS media_catalog(id TEXT PRIMARY KEY,title TEXT NOT NULL,collection TEXT,series_id TEXT,series_title TEXT,season INTEGER,episode INTEGER,media_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS catalog_totals(total INTEGER,tv INTEGER,movies INTEGER,series INTEGER); CREATE TABLE IF NOT EXISTS series_catalog(id TEXT PRIMARY KEY,title TEXT NOT NULL,search_text TEXT NOT NULL,series_json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS series_order ON series_catalog(title COLLATE NOCASE,id); CREATE INDEX IF NOT EXISTS media_order ON media_catalog((CASE WHEN series_id IS NULL THEN title ELSE series_title END) COLLATE NOCASE,season,episode,title COLLATE NOCASE,id); CREATE INDEX IF NOT EXISTS media_collection_order ON media_catalog(collection,(CASE WHEN series_id IS NULL THEN title ELSE series_title END) COLLATE NOCASE,season,episode,title COLLATE NOCASE,id); CREATE INDEX IF NOT EXISTS media_series_order ON media_catalog(series_id,season,episode,title COLLATE NOCASE,id);")?;
    for table in ["media_catalog", "series_catalog"] {
        let found: bool = db.query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name='library_id')"
            ),
            [],
            |row| row.get(0),
        )?;
        if !found {
            db.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN library_id TEXT"))?;
        }
    }
    db.execute_batch("CREATE INDEX IF NOT EXISTS media_library_order ON media_catalog(library_id,(CASE WHEN series_id IS NULL THEN title ELSE series_title END) COLLATE NOCASE,season,episode,title COLLATE NOCASE,id); CREATE INDEX IF NOT EXISTS series_library_order ON series_catalog(library_id,title COLLATE NOCASE,id);")?;
    let transaction = db.transaction()?;
    transaction.execute("DELETE FROM media_catalog", [])?;
    update_membership(&transaction, items)?;
    transaction.commit()
}

/// Apply membership and classification to the existing index atomically. Media
/// and progress IDs are retained and no source storage is read during this edit.
pub(crate) fn update_membership(
    db: &Connection,
    items: impl Iterator<Item = Media>,
) -> rusqlite::Result<()> {
    db.execute("DELETE FROM series_catalog", [])?;
    db.execute("DELETE FROM catalog_totals", [])?;
    db.execute("DELETE FROM library_membership", [])?;
    let mut totals = [0_u32; 3];
    let mut shows = std::collections::BTreeMap::<
        String,
        (
            String,
            u32,
            std::collections::BTreeSet<u32>,
            Option<String>,
            Option<String>,
        ),
    >::new();
    {
        let mut statement =
            db.prepare("INSERT INTO media_catalog(id,title,collection,series_id,series_title,season,episode,media_json,library_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET title=excluded.title,collection=excluded.collection,series_id=excluded.series_id,series_title=excluded.series_title,season=excluded.season,episode=excluded.episode,media_json=excluded.media_json,library_id=excluded.library_id")?;
        for item in items {
            totals[0] += 1;
            if item.classification.collection.as_deref() == Some("tv") {
                totals[1] += 1;
            } else if item.classification.collection.as_deref() == Some("movies") {
                totals[2] += 1;
            }
            if let Some(id) = &item.classification.series_id {
                let show = shows.entry(id.clone()).or_insert_with(|| {
                    (
                        item.classification.series_title.clone().unwrap_or_default(),
                        0,
                        Default::default(),
                        None,
                        item.classification.library_id.clone(),
                    )
                });
                show.1 += 1;
                if let Some(season) = item.classification.season {
                    show.2.insert(season);
                }
                if show.3.is_none() {
                    show.3 = item.presentation.poster_path.clone();
                }
            }
            let json = serde_json::to_string(&item).expect("Media serialization");
            db.execute(
                "INSERT INTO library_membership(media_id,library_id) VALUES(?1,?2)",
                params![item.id, item.classification.library_id],
            )?;
            statement.execute(params![
                item.id,
                item.title,
                item.classification.collection,
                item.classification.series_id,
                item.classification.series_title,
                item.classification.season,
                item.classification.episode,
                json,
                item.classification.library_id,
            ])?;
        }
    }
    db.execute(
        "INSERT INTO catalog_totals VALUES (?1,?2,?3,?4)",
        params![totals[0], totals[1], totals[2], shows.len() as u32],
    )?;
    for (id, (title, episodes, seasons, poster, library_id)) in shows {
        let mut value =
            serde_json::json!({"id":id,"title":title,"episodes":episodes,"seasons":seasons.len()});
        if let Some(path) = poster {
            value["posterPath"] = path.into();
        }
        if let Some(id) = &library_id {
            value["libraryId"] = id.clone().into();
        }
        db.execute(
            "INSERT INTO series_catalog(id,title,search_text,series_json,library_id) VALUES (?1,?2,?3,?4,?5)",
            params![id, title, title.to_lowercase(), value.to_string(), library_id],
        )?;
    }
    Ok(())
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogQuery {
    pub library: Option<String>,
    pub revision: Option<u64>,
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
            .library
            .as_deref()
            .is_some_and(|id| !crate::libraries::valid_id(id))
            || self
                .revision
                .is_some_and(|revision| revision > 9_007_199_254_740_991)
            || self
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
    let mut filters = Vec::new();
    let mut values = Vec::<rusqlite::types::Value>::new();
    if let Some(library) = query.library {
        filters.push("library_id=?".to_string());
        values.push(library.into());
    }
    if let Some(collection) = query.collection.filter(|s| s != "all") {
        filters.push("collection=?".to_string());
        values.push(collection.into());
    }
    if let Some(series) = query.series {
        filters.push("series_id=?".to_string());
        values.push(series.into());
    }
    if let Some(season) = query.season {
        filters.push("season=?".to_string());
        values.push(season.into());
    }
    if let Some(search) = query.search.filter(|s| !s.is_empty()) {
        filters.push("(instr(lower(title),lower(?))>0 OR instr(lower(coalesce(series_title,'')),lower(?))>0)".into());
        values.push(search.clone().into());
        values.push(search.into());
    }
    let predicate = if filters.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", filters.join(" AND "))
    };
    let total: u32 = db.query_row(
        &format!("SELECT count(*) FROM media_catalog {predicate}"),
        rusqlite::params_from_iter(values.iter()),
        |row| row.get(0),
    )?;
    let offset = query.offset.unwrap_or(0);
    let limit = query.limit.unwrap_or(500);
    values.push(limit.into());
    values.push(offset.into());
    let mut statement=db.prepare(&format!("SELECT media_json FROM media_catalog {predicate} ORDER BY CASE WHEN series_id IS NULL THEN title ELSE series_title END COLLATE NOCASE,season,episode,title COLLATE NOCASE,id LIMIT ? OFFSET ?"))?;
    let items = statement
        .query_map(rusqlite::params_from_iter(values.iter()), |row| {
            row.get::<_, String>(0)
        })?
        .map(|row| Ok(serde_json::from_str::<Media>(&row?)?))
        .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
    let next = offset.saturating_add(items.len() as u32);
    Ok(
        serde_json::json!({"apiVersion":1,"fullLibrary":true,"items":items,"total":total,"offset":offset,"limit":limit,"nextOffset":if next<total {Some(next)} else {None}}),
    )
}

pub(crate) fn summary(db: &Connection) -> rusqlite::Result<serde_json::Value> {
    db.query_row("SELECT total,tv,movies,series FROM catalog_totals",[],|row|Ok(serde_json::json!({"total":row.get::<_,u32>(0)?,"tv":row.get::<_,u32>(1)?,"movies":row.get::<_,u32>(2)?,"series":row.get::<_,u32>(3)?})))
}
pub(crate) fn series(
    db: &Connection,
    query: CatalogQuery,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    query.validate()?;
    let search = query.search.unwrap_or_default().to_lowercase();
    let offset = query.offset.unwrap_or(0);
    let limit = query.limit.unwrap_or(60);
    let total: u32 = db.query_row(
        "SELECT count(*) FROM series_catalog WHERE (?1='' OR instr(search_text,?1)>0) AND (?2 IS NULL OR library_id=?2) AND (?3 IS NULL OR id=?3) AND (?4 IS NULL OR ?4='all' OR ?4='tv')",
        params![search, query.library, query.series, query.collection],
        |row| row.get(0),
    )?;
    let mut statement=db.prepare("SELECT series_json FROM series_catalog WHERE (?1='' OR instr(search_text,?1)>0) AND (?2 IS NULL OR library_id=?2) AND (?3 IS NULL OR id=?3) AND (?4 IS NULL OR ?4='all' OR ?4='tv') ORDER BY title COLLATE NOCASE,id LIMIT ?5 OFFSET ?6")?;
    let items = statement
        .query_map(
            params![
                search,
                query.library,
                query.series,
                query.collection,
                limit,
                offset
            ],
            |row| row.get::<_, String>(0),
        )?
        .map(|row| Ok(serde_json::from_str::<serde_json::Value>(&row?)?))
        .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
    let next = offset.saturating_add(items.len() as u32);
    Ok(
        serde_json::json!({"items":items,"total":total,"offset":offset,"limit":limit,"nextOffset":if next<total{Some(next)}else{None}}),
    )
}

pub(crate) fn seasons(db: &Connection, id: &str) -> rusqlite::Result<serde_json::Value> {
    let mut statement=db.prepare("SELECT season,count(*) FROM media_catalog WHERE series_id=?1 GROUP BY season ORDER BY season")?;
    let items=statement.query_map([id],|row|Ok(serde_json::json!({"season":row.get::<_,Option<u32>>(0)?,"episodes":row.get::<_,u32>(1)?})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(serde_json::json!({"items":items}))
}
