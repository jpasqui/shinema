use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use shinema_server::{Library, router};
use tower::ServiceExt;

async fn get(app: &axum::Router, path: &str) -> (StatusCode, serde_json::Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .header("host", "127.0.0.1:8787")
                .uri(path)
                .body(Body::empty())
                .unwrap(),
        )
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
