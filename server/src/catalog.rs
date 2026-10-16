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

fn search_text(value: &str) -> String {
    // Substrings have no surrounding word context. Avoid str::to_lowercase's
    // contextual final sigma, and treat both lowercase sigma forms alike.
    value
        .chars()
        .flat_map(char::to_lowercase)
        .map(|ch| if ch == 'ς' { 'σ' } else { ch })
        .collect()
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
    let transaction = db.transaction()?;
    // This index is regenerated at startup. Rebuilding it transactionally also
    // upgrades old catalog schemas without touching saved playback progress.
    transaction.execute_batch("DROP TABLE IF EXISTS media_catalog; CREATE TABLE media_catalog(id TEXT PRIMARY KEY,title TEXT NOT NULL,collection TEXT,series_id TEXT,series_title TEXT,season INTEGER,episode INTEGER,media_json TEXT NOT NULL,title_search TEXT NOT NULL,series_search TEXT NOT NULL); CREATE TABLE IF NOT EXISTS catalog_totals(total INTEGER,tv INTEGER,movies INTEGER,series INTEGER); CREATE TABLE IF NOT EXISTS series_catalog(id TEXT PRIMARY KEY,title TEXT NOT NULL,search_text TEXT NOT NULL,series_json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS series_order ON series_catalog(title COLLATE NOCASE,id); CREATE INDEX media_order ON media_catalog((CASE WHEN series_id IS NULL THEN title ELSE series_title END) COLLATE NOCASE,season,episode,title COLLATE NOCASE,id); CREATE INDEX media_collection_order ON media_catalog(collection,(CASE WHEN series_id IS NULL THEN title ELSE series_title END) COLLATE NOCASE,season,episode,title COLLATE NOCASE,id); CREATE INDEX media_series_order ON media_catalog(series_id,season,episode,title COLLATE NOCASE,id);")?;
    transaction.execute("DELETE FROM series_catalog", [])?;
    transaction.execute("DELETE FROM catalog_totals", [])?;
    let mut totals = [0_u32; 3];
    let mut shows = std::collections::BTreeMap::<
        String,
        (String, u32, std::collections::BTreeSet<u32>, Option<String>),
    >::new();
    {
        let mut statement = transaction
            .prepare("INSERT INTO media_catalog VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)")?;
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
            statement.execute(params![
                item.id,
                item.title,
                item.classification.collection,
                item.classification.series_id,
                item.classification.series_title,
                item.classification.season,
                item.classification.episode,
                json,
                search_text(&item.title),
                search_text(
                    item.classification
                        .series_title
                        .as_deref()
                        .unwrap_or_default()
                )
            ])?;
        }
    }
    transaction.execute(
        "INSERT INTO catalog_totals VALUES (?1,?2,?3,?4)",
        params![totals[0], totals[1], totals[2], shows.len() as u32],
    )?;
    for (id, (title, episodes, seasons, poster)) in shows {
        let mut value =
            serde_json::json!({"id":id,"title":title,"episodes":episodes,"seasons":seasons.len()});
        if let Some(path) = poster {
            value["posterPath"] = path.into();
        }
        transaction.execute(
            "INSERT INTO series_catalog VALUES (?1,?2,?3,?4)",
            params![id, title, search_text(&title), value.to_string()],
        )?;
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
    let fixed_series = query.series.is_some();
    let cached_total = if query.series.is_none()
        && query.season.is_none()
        && query.search.as_ref().is_none_or(|s| s.is_empty())
    {
        Some(match query.collection.as_deref() {
            Some("tv") => "tv",
            Some("movies") => "movies",
            _ => "total",
        })
    } else {
        None
    };
    let mut filters = Vec::new();
    let mut values = Vec::<rusqlite::types::Value>::new();
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
        // SQLite's built-in lower() handles ASCII only. Normalize both sides
        // once in Rust, matching series search without changing literal instr
        // semantics or allowing matches across title/series field boundaries.
        filters.push("(instr(title_search,?)>0 OR instr(series_search,?)>0)".into());
        let search = search_text(&search);
        values.push(search.clone().into());
        values.push(search.into());
    }
    let predicate = if filters.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", filters.join(" AND "))
    };
    let total: u32 = if let Some(column) = cached_total {
        scalar(db, &format!("SELECT {column} FROM catalog_totals"), [])?
    } else {
        scalar(
            db,
            &format!("SELECT count(*) FROM media_catalog {predicate}"),
            rusqlite::params_from_iter(values.iter()),
        )?
    };
    let offset = query.offset.unwrap_or(0);
    let limit = query.limit.unwrap_or(500);
    values.push(limit.into());
    values.push(offset.into());
    let mut statement = db.prepare(&page_sql(&predicate, fixed_series))?;
    let items = statement
        .query_map(rusqlite::params_from_iter(values.iter()), |row| {
            row.get::<_, String>(0)
        })?
        .map(|row| Ok(serde_json::from_str::<Media>(&row?)?))
        .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
    #[cfg(test)]
    crate::performance_budgets::record_statement(&statement);
    let next = offset.saturating_add(items.len() as u32);
    let full_library: bool = scalar(db, "SELECT tv>0 OR movies>0 FROM catalog_totals", [])?;
    Ok(
        serde_json::json!({"apiVersion":1,"fullLibrary":full_library,"items":items,"total":total,"offset":offset,"limit":limit,"nextOffset":if next<total {Some(next)} else {None}}),
    )
}

fn scalar<T: rusqlite::types::FromSql>(
    db: &Connection,
    sql: &str,
    values: impl rusqlite::Params,
) -> rusqlite::Result<T> {
    let mut statement = db.prepare(sql)?;
    let value = statement.query_row(values, |row| row.get(0))?;
    #[cfg(test)]
    crate::performance_budgets::record_statement(&statement);
    Ok(value)
}

fn page_sql(predicate: &str, fixed_series: bool) -> String {
    // A fixed series has one file-derived series title. Omitting that constant
    // expression lets SQLite use media_series_order without a temporary sort.
    let order = if fixed_series {
        "season,episode,title COLLATE NOCASE,id"
    } else {
        "CASE WHEN series_id IS NULL THEN title ELSE series_title END COLLATE NOCASE,season,episode,title COLLATE NOCASE,id"
    };
    format!("SELECT media_json FROM media_catalog {predicate} ORDER BY {order} LIMIT ? OFFSET ?")
}

pub(crate) fn summary(db: &Connection) -> rusqlite::Result<serde_json::Value> {
    db.query_row("SELECT total,tv,movies,series FROM catalog_totals",[],|row|Ok(serde_json::json!({"total":row.get::<_,u32>(0)?,"tv":row.get::<_,u32>(1)?,"movies":row.get::<_,u32>(2)?,"series":row.get::<_,u32>(3)?})))
}
pub(crate) fn series(
    db: &Connection,
    query: CatalogQuery,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    query.validate()?;
    let search = search_text(&query.search.unwrap_or_default());
    let offset = query.offset.unwrap_or(0);
    let limit = query.limit.unwrap_or(60);
    let total: u32 = if search.is_empty() {
        scalar(db, "SELECT series FROM catalog_totals", [])?
    } else {
        scalar(
            db,
            "SELECT count(*) FROM series_catalog WHERE (?1='' OR instr(search_text,?1)>0)",
            [&search],
        )?
    };
    let mut statement=db.prepare("SELECT series_json FROM series_catalog WHERE (?1='' OR instr(search_text,?1)>0) ORDER BY title COLLATE NOCASE,id LIMIT ?2 OFFSET ?3")?;
    let items = statement
        .query_map(params![search, limit, offset], |row| {
            row.get::<_, String>(0)
        })?
        .map(|row| Ok(serde_json::from_str::<serde_json::Value>(&row?)?))
        .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
    #[cfg(test)]
    crate::performance_budgets::record_statement(&statement);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn series_page_plan_uses_ordered_index_without_sorting() {
        let mut db = Connection::open_in_memory().unwrap();
        replace_index(&mut db, std::iter::empty()).unwrap();
        for (predicate, values) in [
            (
                "WHERE series_id=?",
                vec![String::from("id").into(), 60.into(), 0.into()],
            ),
            (
                "WHERE collection=? AND series_id=? AND season=?",
                vec![
                    String::from("tv").into(),
                    String::from("id").into(),
                    1.into(),
                    60.into(),
                    0.into(),
                ],
            ),
        ] {
            let values: Vec<rusqlite::types::Value> = values;
            let plan = db
                .prepare(&format!("EXPLAIN QUERY PLAN {}", page_sql(predicate, true)))
                .unwrap()
                .query_map(rusqlite::params_from_iter(values.iter()), |row| {
                    row.get::<_, String>(3)
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert!(
                plan.iter().any(|line| line.contains("media_series_order")),
                "{plan:?}"
            );
            assert!(
                !plan.iter().any(|line| line.contains("TEMP B-TREE")),
                "{plan:?}"
            );
        }
    }

    #[test]
    fn failed_catalog_rebuild_rolls_back_all_derived_rows() {
        let item = Media {
            id: "fixture".into(),
            title: "Before".into(),
            container: "mp4".into(),
            size_bytes: 1,
            stream_path: "/api/media/fixture/stream".into(),
            classification: Classification {
                collection: Some("movies".into()),
                ..Default::default()
            },
            presentation: Default::default(),
        };
        let mut db = Connection::open_in_memory().unwrap();
        replace_index(&mut db, [item.clone()].into_iter()).unwrap();
        let before = page(&db, CatalogQuery::default()).unwrap();
        assert!(replace_index(&mut db, [item.clone(), item].into_iter()).is_err());
        assert_eq!(page(&db, CatalogQuery::default()).unwrap(), before);
        assert_eq!(summary(&db).unwrap()["total"], 1);
    }
}
