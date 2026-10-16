use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use shinema_server::{Library, router};
use tower::ServiceExt;

fn video(root: &std::path::Path, relative: &str) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, b"generated catalog fixture").unwrap();
}

fn search_path(endpoint: &str, search: &str) -> String {
    let encoded = search
        .bytes()
        .map(|byte| format!("%{byte:02X}"))
        .collect::<String>();
    format!("{endpoint}?search={encoded}")
}

async fn get(app: &axum::Router, path: &str) -> (StatusCode, serde_json::Value) {
    let response = app
        .clone()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

#[tokio::test]
async fn all_files_are_indexed_and_pages_cover_the_catalog_without_duplicates() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("media");
    for series in 0..30 {
        let directory = root
            .join("tv")
            .join(format!("Generated series {series:02}"))
            .join("Season 1");
        std::fs::create_dir_all(&directory).unwrap();
        for episode in 1..=20 {
            std::fs::write(
                directory.join(format!("Episode S01E{episode:02}.mkv")),
                b"fixture",
            )
            .unwrap();
        }
    }
    let movie = root.join("movies/Generated film (2026)");
    std::fs::create_dir_all(&movie).unwrap();
    std::fs::write(movie.join("Generated film.mp4"), b"movie").unwrap();
    std::fs::write(movie.join("subtitle.srt"), b"sidecar").unwrap();
    let state = temp.path().join("state");
    let app = router(Library::open(&root, &state).unwrap());
    let (_, summary) = get(&app, "/api/library").await;
    assert_eq!(summary["total"], 601);
    assert_eq!(summary["tv"], 600);
    assert_eq!(summary["movies"], 1);
    assert_eq!(summary["series"], 30);
    let (_, first) = get(&app, "/api/catalog").await;
    assert_eq!(first["items"].as_array().unwrap().len(), 500);
    assert_eq!(first["total"], 601);
    assert_eq!(first["nextOffset"], 500);
    let mut ids = std::collections::BTreeSet::new();
    let mut offset = 0;
    loop {
        let (_, page) = get(&app, &format!("/api/catalog?offset={offset}&limit=37")).await;
        assert!(page["items"].as_array().unwrap().len() <= 37);
        for item in page["items"].as_array().unwrap() {
            assert!(ids.insert(item["id"].as_str().unwrap().to_owned()));
            assert!(item.get("relative").is_none());
            assert!(item.get("path").is_none());
        }
        match page["nextOffset"].as_u64() {
            Some(next) => offset = next,
            None => break,
        }
    }
    assert_eq!(ids.len(), 601);
    let (_, series) = get(&app, "/api/series?limit=7&offset=7").await;
    assert_eq!(series["total"], 30);
    assert_eq!(series["items"].as_array().unwrap().len(), 7);
    let id = series["items"][0]["id"].as_str().unwrap();
    let (_, seasons) = get(&app, &format!("/api/series/{id}/seasons")).await;
    assert_eq!(seasons["items"][0]["season"], 1);
    assert_eq!(seasons["items"][0]["episodes"], 20);
    let (_, episodes) = get(
        &app,
        &format!("/api/catalog?collection=tv&series={id}&season=1&limit=10"),
    )
    .await;
    assert_eq!(episodes["total"], 20);
    assert_eq!(episodes["items"][0]["episode"], 1);
    assert_eq!(episodes["items"][9]["episode"], 10);
    let db = rusqlite::Connection::open(state.join("progress.sqlite3")).unwrap();
    let count: u32 = db
        .query_row("SELECT count(*) FROM media_catalog", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 601);
    let plan=db.prepare("EXPLAIN QUERY PLAN SELECT media_json FROM media_catalog ORDER BY CASE WHEN series_id IS NULL THEN title ELSE series_title END COLLATE NOCASE,season,episode,title COLLATE NOCASE,id LIMIT 60").unwrap().query_map([],|row|row.get::<_,String>(3)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
    assert!(plan.iter().any(|line| line.contains("media_order")));
    assert!(!plan.iter().any(|line| line.contains("TEMP B-TREE")));

    drop(db);
    drop(app);
    std::fs::remove_file(movie.join("Generated film.mp4")).unwrap();
    let reopened = router(Library::open(&root, &state).unwrap());
    let (_, summary) = get(&reopened, "/api/library").await;
    assert_eq!(summary["total"], 600);
}

#[tokio::test]
async fn deep_files_and_legacy_formats_are_visible_and_query_values_are_bound() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("media");
    let deep = root.join("tv/Unicode 星/Season 0/a/b/c/d/e/f/g/h/i");
    std::fs::create_dir_all(&deep).unwrap();
    for (index, ext) in [
        "avi", "ts", "m4v", "mkv", "mp4", "webm", "mov", "m2ts", "mpg", "mpeg", "vob", "wmv",
    ]
    .iter()
    .enumerate()
    {
        std::fs::write(
            deep.join(format!("Special S00E{:02}.{ext}", index + 1)),
            b"fixture",
        )
        .unwrap();
    }
    let app = router(Library::open(&root, &temp.path().join("state")).unwrap());
    let (_, catalog) = get(&app, "/api/catalog").await;
    assert_eq!(catalog["total"], 12);
    assert_eq!(catalog["items"][0]["season"], 0);
    let (_, search) = get(&app, "/api/catalog?search=%27%20OR%201%3D1--").await;
    assert_eq!(search["total"], 0);
    for path in [
        "/api/catalog?limit=0",
        "/api/catalog?limit=501",
        "/api/catalog?offset=10000001",
        "/api/catalog?collection=private",
        "/api/catalog?series=not-an-id",
        "/api/catalog?unknown=true",
    ] {
        assert_eq!(get(&app, path).await.0, StatusCode::BAD_REQUEST, "{path}");
    }
}

#[tokio::test]
async fn unicode_search_matches_movie_titles_series_titles_and_episode_titles() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("media");
    video(&root, "movies/ÉCLAIR ΔΡΑΜΑ.mp4");
    video(
        &root,
        "tv/ÉCLAIR ΔΡΑΜΑ/Season 1/Generated S01E01 - СИНТЕТИКА.mkv",
    );
    video(&root, "movies/Other film.mp4");
    video(&root, "tv/Other series/Generated S01E01.mkv");
    let app = router(Library::open(&root, &temp.path().join("state")).unwrap());

    for search in ["éclair", "ÉCLAIR", "δραμα", "ΔΡΑΜΑ"] {
        for endpoint in ["/api/catalog", "/api/series"] {
            let (status, value) = get(&app, &search_path(endpoint, search)).await;
            assert_eq!(status, StatusCode::OK, "{endpoint}: {search}");
            let expected = if endpoint == "/api/catalog" { 2 } else { 1 };
            assert_eq!(value["total"], expected, "{endpoint}: {search}");
            assert_eq!(value["items"].as_array().unwrap().len(), expected);
        }
    }

    for search in ["синтетика", "СИНТЕТИКА"] {
        let (status, value) = get(&app, &search_path("/api/catalog", search)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["total"], 1);
        assert_eq!(value["items"][0]["collection"], "tv");
        assert_eq!(value["items"][0]["title"], "СИНТЕТИКА");
    }
}

#[tokio::test]
async fn greek_sigma_search_is_independent_of_substring_word_context() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("media");
    video(&root, "movies/ΟΣ.mp4");
    video(&root, "tv/ος/Generated S01E01.mkv");
    let app = router(Library::open(&root, &temp.path().join("state")).unwrap());
    for search in ["Σ", "σ", "ς", "ΟΣ", "οσ", "ος"] {
        for (endpoint, count) in [("/api/catalog", 2), ("/api/series", 1)] {
            let (status, result) = get(&app, &search_path(endpoint, search)).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(result["total"], count, "{endpoint}: {search}");
        }
    }
}

#[tokio::test]
async fn search_keeps_wildcards_quotes_and_field_boundaries_literal() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("media");
    video(&root, "movies/Literal % O'Brien.mp4");
    video(&root, "movies/Literal XY OBrien.mp4");
    video(
        &root,
        "tv/Literal %_ O'Brien/Generated S01E01 - Boundary.mkv",
    );
    video(&root, "tv/Literal XY OBrien/Generated S01E01.mkv");
    let app = router(Library::open(&root, &temp.path().join("state")).unwrap());

    for (search, media_count, series_count) in [
        ("%", 2, 1),
        ("_", 1, 1),
        ("%_", 1, 1),
        ("O'Brien", 2, 1),
        ("' OR 1=1--", 0, 0),
        ("boundary\0literal", 0, 0),
    ] {
        for (endpoint, expected) in [("/api/catalog", media_count), ("/api/series", series_count)] {
            let (status, value) = get(&app, &search_path(endpoint, search)).await;
            assert_eq!(status, StatusCode::OK, "{endpoint}: {search:?}");
            assert_eq!(value["total"], expected, "{endpoint}: {search:?}");
            assert_eq!(value["items"].as_array().unwrap().len(), expected);
        }
    }
}

#[tokio::test]
async fn fixed_series_pages_preserve_global_order_including_unknowns_and_ties() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("media");
    for relative in [
        "movies/alpha.mp4",
        "movies/ALPHA.mkv",
        "movies/Zulu.mp4",
        "tv/Beta/Unnumbered.mkv",
        "tv/Beta/Season 0/Special S00E02.mkv",
        "tv/Beta/Season 1/Generated S01E01 - Zebra.mkv",
        "tv/Beta/Season 1/Generated S01E02 - alpha.mp4",
        "tv/Beta/Season 1/Generated S01E02 - ALPHA.mkv",
        "tv/Beta/Season 2/Generated S02E01 - Later.mkv",
        "tv/Gamma/Generated S01E01.mkv",
    ] {
        video(&root, relative);
    }
    let app = router(Library::open(&root, &temp.path().join("state")).unwrap());
    let (_, series) = get(&app, "/api/series?limit=1").await;
    assert_eq!(series["total"], 2);
    assert_eq!(series["items"][0]["title"], "Beta");
    assert_eq!(series["nextOffset"], 1);
    let sid = series["items"][0]["id"].as_str().unwrap();
    let (_, second_series) = get(&app, "/api/series?limit=1&offset=1").await;
    assert_eq!(second_series["items"][0]["title"], "Gamma");
    assert!(second_series["nextOffset"].is_null());

    let (_, all) = get(&app, "/api/catalog").await;
    let expected = all["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["seriesId"].as_str() == Some(sid))
        .cloned()
        .collect::<Vec<_>>();
    let positions = expected
        .iter()
        .map(|item| (item["season"].as_u64(), item["episode"].as_u64()))
        .collect::<Vec<_>>();
    assert_eq!(
        positions,
        [
            (None, None),
            (Some(0), Some(2)),
            (Some(1), Some(1)),
            (Some(1), Some(2)),
            (Some(1), Some(2)),
            (Some(2), Some(1)),
        ]
    );
    assert!(expected[3]["id"].as_str().unwrap() < expected[4]["id"].as_str().unwrap());

    for collection in ["", "&collection=tv"] {
        let mut actual = Vec::new();
        let mut offset = 0;
        loop {
            let path = format!("/api/catalog?series={sid}&limit=2&offset={offset}{collection}");
            let (status, page) = get(&app, &path).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(page["total"], expected.len());
            assert_eq!(page["offset"], offset);
            assert!(page["items"].as_array().unwrap().len() <= 2);
            actual.extend(page["items"].as_array().unwrap().iter().cloned());
            match page["nextOffset"].as_u64() {
                Some(next) => {
                    assert!(next > offset);
                    offset = next;
                }
                None => break,
            }
        }
        assert_eq!(actual, expected);
    }

    let (_, season) = get(
        &app,
        &format!("/api/catalog?collection=tv&series={sid}&season=1&limit=2&offset=1"),
    )
    .await;
    assert_eq!(season["total"], 3);
    assert_eq!(season["items"], serde_json::json!(&expected[3..5]));
    assert!(season["nextOffset"].is_null());
    let (_, beyond) = get(&app, &format!("/api/catalog?series={sid}&offset=100")).await;
    assert_eq!(beyond["total"], expected.len());
    assert!(beyond["items"].as_array().unwrap().is_empty());
    assert!(beyond["nextOffset"].is_null());

    let (_, movies) = get(&app, "/api/catalog?collection=movies&limit=1").await;
    assert_eq!(movies["total"], 3);
    assert_eq!(
        movies["items"][0]["title"].as_str().unwrap().to_lowercase(),
        "alpha"
    );
    let (_, next_movie) = get(&app, "/api/catalog?collection=movies&limit=1&offset=1").await;
    assert_eq!(
        next_movie["items"][0]["title"]
            .as_str()
            .unwrap()
            .to_lowercase(),
        "alpha"
    );
    assert!(
        movies["items"][0]["id"].as_str().unwrap() < next_movie["items"][0]["id"].as_str().unwrap()
    );
}

#[tokio::test]
async fn an_existing_catalog_schema_is_rebuilt_without_losing_progress() {
    use sha2::{Digest, Sha256};

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("media");
    let state = temp.path().join("state");
    let relative = "movies/ÉCLAIR.mp4";
    video(&root, relative);
    std::fs::create_dir(&state).unwrap();
    let id = format!("{:x}", Sha256::digest(relative.as_bytes()));
    {
        let db = rusqlite::Connection::open(state.join("progress.sqlite3")).unwrap();
        db.execute_batch(
            "CREATE TABLE progress(id TEXT PRIMARY KEY, position REAL NOT NULL, duration REAL NOT NULL);
             CREATE TABLE media_catalog(id TEXT PRIMARY KEY,title TEXT NOT NULL,collection TEXT,series_id TEXT,series_title TEXT,season INTEGER,episode INTEGER,media_json TEXT NOT NULL);
             CREATE TABLE catalog_totals(total INTEGER,tv INTEGER,movies INTEGER,series INTEGER);
             CREATE TABLE series_catalog(id TEXT PRIMARY KEY,title TEXT NOT NULL,search_text TEXT NOT NULL,series_json TEXT NOT NULL);
             CREATE INDEX media_series_order ON media_catalog(series_id,season,episode,title COLLATE NOCASE,id);
             INSERT INTO media_catalog VALUES ('stale','Removed film','movies',NULL,NULL,NULL,NULL,'{}');
             INSERT INTO catalog_totals VALUES (99,50,49,20);
             INSERT INTO series_catalog VALUES ('stale','Removed show','removed show','{}');",
        )
        .unwrap();
        db.execute("INSERT INTO progress VALUES (?1,42,120)", [&id])
            .unwrap();
    }

    for _ in 0..2 {
        let app = router(Library::open(&root, &state).unwrap());
        let (status, progress) = get(&app, &format!("/api/media/{id}/progress")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            progress,
            serde_json::json!({"positionSeconds":42.0,"durationSeconds":120.0})
        );
        let (status, catalog) = get(&app, &search_path("/api/catalog", "éclair")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(catalog["total"], 1);
        assert_eq!(catalog["items"][0]["id"], id);
        let (_, summary) = get(&app, "/api/library").await;
        assert_eq!(
            summary,
            serde_json::json!({"total":1,"tv":0,"movies":1,"series":0})
        );
        let (_, series) = get(&app, "/api/series").await;
        assert_eq!(series["total"], 0);
    }
}
