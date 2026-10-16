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
    let transaction = db.transaction()?;
    // Both catalogs are derived inventory. Rebuild their combined schema in the
    // same transaction as membership, without touching configuration or progress.
    transaction.execute_batch("DROP TABLE IF EXISTS media_catalog; DROP TABLE IF EXISTS series_catalog; CREATE TABLE media_catalog(id TEXT PRIMARY KEY,title TEXT NOT NULL,collection TEXT,series_id TEXT,series_title TEXT,season INTEGER,episode INTEGER,media_json TEXT NOT NULL,library_id TEXT,title_search TEXT NOT NULL,series_search TEXT NOT NULL); CREATE TABLE IF NOT EXISTS catalog_totals(total INTEGER,tv INTEGER,movies INTEGER,series INTEGER); CREATE TABLE series_catalog(id TEXT PRIMARY KEY,title TEXT NOT NULL,search_text TEXT NOT NULL,series_json TEXT NOT NULL,library_id TEXT); CREATE TABLE IF NOT EXISTS library_membership(media_id TEXT PRIMARY KEY,library_id TEXT NOT NULL); CREATE INDEX IF NOT EXISTS library_membership_library ON library_membership(library_id,media_id); CREATE INDEX series_order ON series_catalog(title COLLATE NOCASE,id); CREATE INDEX series_library_order ON series_catalog(library_id,title COLLATE NOCASE,id); CREATE INDEX media_order ON media_catalog((CASE WHEN series_id IS NULL THEN title ELSE series_title END) COLLATE NOCASE,season,episode,title COLLATE NOCASE,id); CREATE INDEX media_collection_order ON media_catalog(collection,(CASE WHEN series_id IS NULL THEN title ELSE series_title END) COLLATE NOCASE,season,episode,title COLLATE NOCASE,id); CREATE INDEX media_library_order ON media_catalog(library_id,(CASE WHEN series_id IS NULL THEN title ELSE series_title END) COLLATE NOCASE,season,episode,title COLLATE NOCASE,id); CREATE INDEX media_series_order ON media_catalog(series_id,season,episode,title COLLATE NOCASE,id); CREATE INDEX media_series_representative ON media_catalog(series_id,id);")?;
    update_membership(&transaction, items)?;
    transaction.commit()
}

/// Apply membership and classification to the existing index atomically. Media
/// and progress IDs are retained and no source storage is read during this edit.
pub(crate) fn update_membership(
    db: &rusqlite::Transaction<'_>,
    items: impl Iterator<Item = Media>,
) -> rusqlite::Result<()> {
    db.execute("DELETE FROM media_catalog", [])?;
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
        let mut statement = db.prepare("INSERT INTO media_catalog(id,title,collection,series_id,series_title,season,episode,media_json,library_id,title_search,series_search) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)")?;
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
            if let Some(library_id) = &item.classification.library_id {
                db.execute(
                    "INSERT INTO library_membership(media_id,library_id) VALUES(?1,?2)",
                    params![item.id, library_id],
                )?;
            }
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
            params![id, title, search_text(&title), value.to_string(), library_id],
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
    let fixed_series = query.series.is_some();
    let cached_total = if query.library.is_none()
        && query.series.is_none()
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
    Ok(
        serde_json::json!({"apiVersion":1,"fullLibrary":true,"items":items,"total":total,"offset":offset,"limit":limit,"nextOffset":if next<total {Some(next)} else {None}}),
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
#[cfg(test)]
pub(crate) fn series(
    db: &Connection,
    query: CatalogQuery,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    series_with_representatives(db, query).map(|(page, _)| page)
}

/// Fetch canonical representatives in the page query so live membership changes
/// do not use stale startup classifications or add one SQL statement per row.
pub(crate) fn series_with_representatives(
    db: &Connection,
    query: CatalogQuery,
) -> Result<
    (serde_json::Value, std::collections::BTreeMap<String, Media>),
    Box<dyn std::error::Error>,
> {
    query.validate()?;
    let search = search_text(&query.search.unwrap_or_default());
    let offset = query.offset.unwrap_or(0);
    let limit = query.limit.unwrap_or(60);
    let mut filters = Vec::new();
    let mut values = Vec::<rusqlite::types::Value>::new();
    if !search.is_empty() {
        filters.push("instr(search_text,?)>0".to_string());
        values.push(search.into());
    }
    if let Some(library) = query.library {
        filters.push("library_id=?".to_string());
        values.push(library.into());
    }
    if let Some(series) = query.series {
        filters.push("id=?".to_string());
        values.push(series.into());
    }
    if query.collection.as_deref() == Some("movies") {
        filters.push("0".to_string());
    }
    let predicate = if filters.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", filters.join(" AND "))
    };
    let total: u32 = if filters.is_empty() {
        scalar(db, "SELECT series FROM catalog_totals", [])?
    } else {
        scalar(
            db,
            &format!("SELECT count(*) FROM series_catalog {predicate}"),
            rusqlite::params_from_iter(values.iter()),
        )?
    };
    values.push(limit.into());
    values.push(offset.into());
    let mut statement=db.prepare(&format!("SELECT series_json,(SELECT media_json FROM media_catalog WHERE series_id=series_catalog.id ORDER BY id LIMIT 1) FROM series_catalog {predicate} ORDER BY title COLLATE NOCASE,id LIMIT ? OFFSET ?"))?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(values.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .map(|row| {
            let (series, media) = row?;
            Ok((
                serde_json::from_str::<serde_json::Value>(&series)?,
                serde_json::from_str::<Media>(&media)?,
            ))
        })
        .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
    #[cfg(test)]
    crate::performance_budgets::record_statement(&statement);
    let mut items = Vec::with_capacity(rows.len());
    let mut representatives = std::collections::BTreeMap::new();
    for (series, media) in rows {
        let id = series["id"].as_str().ok_or("Invalid indexed series")?;
        if media.classification.series_id.as_deref() != Some(id) {
            return Err("Invalid indexed representative".into());
        }
        representatives.insert(id.to_string(), media);
        items.push(series);
    }
    let next = offset.saturating_add(items.len() as u32);
    Ok((
        serde_json::json!({"items":items,"total":total,"offset":offset,"limit":limit,"nextOffset":if next<total{Some(next)}else{None}}),
        representatives,
    ))
}

pub(crate) fn seasons(db: &Connection, id: &str) -> rusqlite::Result<serde_json::Value> {
    let mut statement=db.prepare("SELECT season,count(*) FROM media_catalog WHERE series_id=?1 GROUP BY season ORDER BY season")?;
    let items=statement.query_map([id],|row|Ok(serde_json::json!({"season":row.get::<_,Option<u32>>(0)?,"episodes":row.get::<_,u32>(1)?})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(serde_json::json!({"items":items}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scoped_media(id: &str, library: &str, series_id: Option<&str>) -> Media {
        Media {
            id: id.into(),
            title: format!("Generated {id}"),
            container: "mp4".into(),
            size_bytes: 1,
            stream_path: format!("/api/media/{id}/stream"),
            classification: Classification {
                collection: Some(if series_id.is_some() { "tv" } else { "movies" }.into()),
                library_id: Some(library.into()),
                series_id: series_id.map(str::to_string),
                series_title: series_id.map(|_| "Generated series".into()),
                season: series_id.map(|_| 1),
                episode: series_id.map(|_| 1),
                ..Default::default()
            },
            presentation: Default::default(),
        }
    }

    #[test]
    fn library_and_series_filters_never_borrow_global_cached_totals() {
        let sid = "a".repeat(64);
        let items = [
            scoped_media("first", "movies", None),
            scoped_media("second", "tv", Some(&sid)),
            scoped_media("third", "tv", Some(&sid)),
        ];
        let mut db = Connection::open_in_memory().unwrap();
        replace_index(&mut db, items.into_iter()).unwrap();
        assert_eq!(page(&db, CatalogQuery::default()).unwrap()["total"], 3);
        for (library, expected) in [("movies", 1), ("tv", 2), ("missing", 0)] {
            let value = page(
                &db,
                CatalogQuery {
                    library: Some(library.into()),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(value["total"], expected, "{library}");
            assert_eq!(value["items"].as_array().unwrap().len(), expected);
            assert!(value["nextOffset"].is_null());
        }
        for query in [
            CatalogQuery {
                library: Some("movies".into()),
                ..Default::default()
            },
            CatalogQuery {
                library: Some("missing".into()),
                ..Default::default()
            },
            CatalogQuery {
                series: Some("b".repeat(64)),
                ..Default::default()
            },
            CatalogQuery {
                collection: Some("movies".into()),
                ..Default::default()
            },
        ] {
            let value = series(&db, query).unwrap();
            assert_eq!(value["total"], 0);
            assert!(value["items"].as_array().unwrap().is_empty());
            assert!(value["nextOffset"].is_null());
        }
    }

    #[test]
    fn live_membership_edits_refresh_search_and_canonical_series_representatives() {
        let sid = "a".repeat(64);
        let moved_sid = "b".repeat(64);
        let first = scoped_media("first", "movies", None);
        let second = scoped_media("second", "tv", Some(&sid));
        let third = scoped_media("third", "tv", Some(&sid));
        let mut db = Connection::open_in_memory().unwrap();
        replace_index(
            &mut db,
            [first.clone(), third.clone(), second.clone()].into_iter(),
        )
        .unwrap();
        let (_, before) = series_with_representatives(&db, CatalogQuery::default()).unwrap();
        assert_eq!(before[&sid].id, "second");

        let mut moved = third.clone();
        moved.title = "Änderung".into();
        moved.classification.library_id = Some("archive".into());
        moved.classification.series_id = Some(moved_sid.clone());
        moved.classification.series_title = Some("Élan".into());
        let transaction = db.transaction().unwrap();
        update_membership(&transaction, [first, second, moved].into_iter()).unwrap();
        transaction.commit().unwrap();

        let query = CatalogQuery {
            library: Some("archive".into()),
            search: Some("änderung".into()),
            ..Default::default()
        };
        let page = page(&db, query).unwrap();
        assert_eq!(page["total"], 1);
        assert_eq!(page["items"][0]["id"], "third");
        let (page, representatives) = series_with_representatives(
            &db,
            CatalogQuery {
                library: Some("archive".into()),
                search: Some("élan".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page["total"], 1);
        assert_eq!(page["items"][0]["libraryId"], "archive");
        assert_eq!(representatives[&moved_sid].id, "third");
        assert_eq!(
            representatives[&moved_sid]
                .classification
                .library_id
                .as_deref(),
            Some("archive")
        );
        assert_eq!(summary(&db).unwrap()["series"], 2);
        let member: String = db
            .query_row(
                "SELECT library_id FROM library_membership WHERE media_id='third'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(member, "archive");
    }

    #[test]
    fn failed_membership_edit_rolls_back_all_derived_rows() {
        let sid = "a".repeat(64);
        let item = scoped_media("first", "tv", Some(&sid));
        let mut db = Connection::open_in_memory().unwrap();
        replace_index(&mut db, [item.clone()].into_iter()).unwrap();
        let before = page(&db, CatalogQuery::default()).unwrap();
        {
            let transaction = db.transaction().unwrap();
            assert!(update_membership(&transaction, [item.clone(), item].into_iter()).is_err());
        }
        assert_eq!(page(&db, CatalogQuery::default()).unwrap(), before);
        assert_eq!(series(&db, CatalogQuery::default()).unwrap()["total"], 1);
        assert_eq!(summary(&db).unwrap()["total"], 1);
        let membership: String = db
            .query_row(
                "SELECT library_id FROM library_membership WHERE media_id='first'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(membership, "tv");
    }

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
