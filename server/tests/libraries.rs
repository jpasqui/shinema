use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use shinema_server::{Library, router_with_admin_token};
use std::path::Path;
use tower::ServiceExt;

// A public synthetic fixture, never an installed operator credential.
const TOKEN: &str = "synthetic-library-test-operator-token-000000";

fn app(root: &Path, state: &Path) -> Router {
    router_with_admin_token(Library::open(root, state).unwrap(), Some(TOKEN.into()))
}

fn fixture() -> (tempfile::TempDir, Router) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("media");
    for path in [
        "Movies/Feature (2026)/Feature.mp4",
        "TV/Drama/Season 1/Drama S01E01.mkv",
        "TV/Anime/Fable/Season 1/Fable S01E01.mkv",
        "Loose video.mp4",
    ] {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, b"synthetic read-only media").unwrap();
    }
    std::fs::create_dir(root.join("Empty")).unwrap();
    let router = app(&root, &temp.path().join("state"));
    (temp, router)
}

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::HOST, "127.0.0.1:8787");
    if let Some(token) = token {
        request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let body = if let Some(body) = body {
        request = request.header(header::CONTENT_TYPE, "application/json");
        Body::from(body.to_string())
    } else {
        Body::empty()
    };
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn get(app: &Router, path: &str) -> Value {
    let (status, value) = request(app, "GET", path, None, None).await;
    assert_eq!(status, StatusCode::OK, "{path}");
    value
}

async fn configuration(app: &Router) -> Value {
    let (status, value) = request(app, "GET", "/api/admin/libraries", Some(TOKEN), None).await;
    assert_eq!(status, StatusCode::OK);
    json!({"revision":value["revision"],"libraries":value["libraries"]})
}

#[tokio::test]
async fn renamed_ordered_hidden_and_nested_libraries_preserve_media_progress_and_restart() {
    let (temp, router) = fixture();
    let root = temp.path().join("media");
    let state = temp.path().join("state");
    let before = get(&router, "/api/catalog").await;
    let anime = before["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["title"].as_str().unwrap().starts_with("Fable"))
        .unwrap();
    let anime_id = anime["id"].as_str().unwrap().to_string();
    let old_series =
        get(&router, "/api/series?library=tv&search=Drama").await["items"][0]["id"].clone();
    let progress = json!({"positionSeconds":12.0,"durationSeconds":60.0});
    assert_eq!(
        request(
            &router,
            "PUT",
            &format!("/api/media/{anime_id}/progress"),
            None,
            Some(progress.clone())
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let mut config = configuration(&router).await;
    assert_eq!(config["libraries"][0]["sourceFolders"], json!(["Movies"]));
    assert_eq!(config["libraries"][1]["sourceFolders"], json!(["TV"]));
    config["libraries"][0]["name"] = "Cinema".into();
    config["libraries"][0]["visible"] = false.into();
    config["libraries"][0]["order"] = 20.into();
    config["libraries"][1]["name"] = "Serials".into();
    config["libraries"].as_array_mut().unwrap().push(json!({"id":"anime","name":"Anime","mediaType":"tv","visible":true,"order":0,"sourceFolders":["TV/Anime"]}));
    config["libraries"].as_array_mut().unwrap().push(json!({"id":"archive","name":"Archive","mediaType":"movies","visible":true,"order":5,"sourceFolders":["Empty"]}));
    // Saving membership cannot discover newly added media or traverse storage.
    std::fs::write(root.join("Unscanned.mp4"), b"new synthetic fixture").unwrap();
    let (status, saved) = request(
        &router,
        "PUT",
        "/api/admin/libraries",
        Some(TOKEN),
        Some(config.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["revision"], 2);
    assert_eq!(saved["libraries"][0]["id"], "anime");
    let public = get(&router, "/api/libraries").await;
    assert_eq!(public["libraries"][0]["name"], "Anime");
    let cinema = public["libraries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|library| library["id"] == "movies")
        .unwrap();
    assert_eq!(cinema["name"], "Cinema");
    assert_eq!(cinema["visible"], false);
    assert_eq!(cinema["order"], 20);
    assert!(
        public["libraries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|library| library.get("sourceFolders").is_none())
    );
    assert!(public.get("availableFolders").is_none());
    assert!(!public.to_string().contains(TOKEN));
    let page = get(&router, "/api/catalog?library=anime&revision=2").await;
    assert_eq!(page["total"], 1);
    assert_eq!(page["items"][0]["id"], anime_id);
    assert_eq!(page["items"][0]["libraryId"], "anime");
    assert_eq!(page["items"][0]["collection"], "tv");
    assert_eq!(page["items"][0]["seriesTitle"], "Fable");
    let new_series = page["items"][0]["seriesId"].clone();
    assert_eq!(
        get(&router, "/api/catalog?library=tv&search=Fable").await["total"],
        0
    );
    assert_eq!(
        get(&router, "/api/series?library=tv&search=Fable").await["total"],
        0
    );
    assert_eq!(
        get(&router, "/api/series?library=anime&search=Fable").await["total"],
        1
    );
    assert_eq!(
        get(&router, "/api/series?library=tv&search=Drama").await["items"][0]["id"],
        old_series
    );
    assert_eq!(
        get(&router, "/api/catalog?library=movies").await["total"],
        1,
        "Hidden is navigation, not an access policy"
    );
    let empty = get(&router, "/api/catalog?library=archive").await;
    assert_eq!(empty["total"], 0);
    assert_eq!(empty["fullLibrary"], true);
    assert_eq!(empty["nextOffset"], Value::Null);
    assert_eq!(get(&router, "/api/catalog").await["total"], 4);
    assert_eq!(
        get(&router, &format!("/api/media/{anime_id}/metadata")).await["items"][0]["libraryId"],
        "anime"
    );
    assert_eq!(
        get(&router, &format!("/api/media/{anime_id}/progress")).await,
        progress
    );
    assert_eq!(
        request(
            &router,
            "PUT",
            "/api/admin/libraries",
            Some(TOKEN),
            Some(config)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    for path in [
        "/api/catalog?library=anime&revision=1",
        "/api/series?library=anime&revision=1",
    ] {
        assert_eq!(
            request(&router, "GET", path, None, None).await.0,
            StatusCode::CONFLICT
        );
    }
    drop(router);
    let reopened = app(&root, &state);
    assert_eq!(get(&reopened, "/api/libraries").await, public);
    assert_eq!(
        get(&reopened, "/api/catalog").await["total"],
        5,
        "Only restart rescans approved media"
    );
    let restored = get(&reopened, "/api/catalog?library=anime&revision=2").await;
    assert_eq!(restored["items"][0]["id"], anime_id);
    assert_eq!(restored["items"][0]["seriesId"], new_series);
    assert_eq!(
        get(&reopened, &format!("/api/media/{anime_id}/progress")).await,
        progress
    );
}

#[tokio::test]
async fn invalid_names_ids_sources_and_ambiguous_sources_never_change_configuration() {
    let (_temp, router) = fixture();
    let original = configuration(&router).await;
    let mut candidates = Vec::new();
    for name in [
        "",
        " ",
        " leading",
        "TV shows",
        "tv SHOWS",
        "bad\nname",
        "bad\u{200b}name",
    ] {
        let mut candidate = original.clone();
        candidate["libraries"][0]["name"] = name.into();
        candidates.push(candidate);
    }
    for id in [
        "Upper",
        "with_underscore",
        "../escape",
        "0invalid",
        &"a".repeat(49),
    ] {
        let mut candidate = original.clone();
        candidate["libraries"][0]["id"] = id.into();
        candidates.push(candidate);
    }
    for folder in [
        "../outside",
        "/absolute",
        "C:/outside",
        "TV/../Movies",
        "TV//Drama",
        "TV\\Drama",
        "unknown",
        "TV/.",
    ] {
        let mut candidate = original.clone();
        candidate["libraries"][0]["sourceFolders"] = json!([folder]);
        candidates.push(candidate);
    }
    let mut duplicate_id = original.clone();
    duplicate_id["libraries"][0]["id"] = "tv".into();
    candidates.push(duplicate_id);
    let mut duplicate_source = original.clone();
    duplicate_source["libraries"][0]["sourceFolders"] = json!(["TV"]);
    candidates.push(duplicate_source);
    let mut no_catchall = original.clone();
    no_catchall["libraries"].as_array_mut().unwrap().pop();
    candidates.push(no_catchall);
    for candidate in candidates {
        assert_eq!(
            request(
                &router,
                "PUT",
                "/api/admin/libraries",
                Some(TOKEN),
                Some(candidate.clone())
            )
            .await
            .0,
            StatusCode::BAD_REQUEST,
            "{candidate}"
        );
        assert_eq!(configuration(&router).await, original);
    }
    for path in [
        "/api/catalog?library=../escape",
        "/api/series?library=UPPER",
        "/api/catalog?revision=9007199254740992",
    ] {
        assert_eq!(
            request(&router, "GET", path, None, None).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        get(&router, "/api/catalog?library=unknown").await["total"],
        0
    );
    assert_eq!(
        get(&router, "/api/catalog?library=tv&search=%27%20OR%201%3D1--").await["total"],
        0
    );
}

#[tokio::test]
async fn management_requires_explicit_operator_authorization_and_loopback_boundary() {
    let (temp, router) = fixture();
    let config = configuration(&router).await;
    for token in [None, Some("incorrect-token")] {
        for method in ["GET", "PUT"] {
            assert_eq!(
                request(
                    &router,
                    method,
                    "/api/admin/libraries",
                    token,
                    if method == "PUT" {
                        Some(config.clone())
                    } else {
                        None
                    }
                )
                .await
                .0,
                StatusCode::FORBIDDEN
            );
        }
    }
    let malformed = Request::builder()
        .method("PUT")
        .uri("/api/admin/libraries")
        .header(header::HOST, "127.0.0.1:8787")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("invalid JSON"))
        .unwrap();
    assert_eq!(
        router.clone().oneshot(malformed).await.unwrap().status(),
        StatusCode::FORBIDDEN,
        "Authorization runs before body parsing"
    );
    let cross_site = Request::builder()
        .method("PUT")
        .uri("/api/admin/libraries")
        .header(header::HOST, "127.0.0.1:8787")
        .header(header::ORIGIN, "https://untrusted.invalid")
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(config.to_string()))
        .unwrap();
    assert_eq!(
        router.clone().oneshot(cross_site).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    let duplicate = Request::builder()
        .uri("/api/admin/libraries")
        .header(header::HOST, "127.0.0.1:8787")
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        router.clone().oneshot(duplicate).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    drop(router);
    for token in [None, Some("too-short".into())] {
        let disabled = router_with_admin_token(
            Library::open(&temp.path().join("media"), &temp.path().join("state")).unwrap(),
            token,
        );
        assert_eq!(
            request(
                &disabled,
                "PUT",
                "/api/admin/libraries",
                Some(TOKEN),
                Some(config.clone())
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request(&disabled, "GET", "/api/admin/libraries", Some(TOKEN), None)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(get(&disabled, "/api/libraries").await["revision"], 1);
    }
}

#[tokio::test]
async fn existing_progress_and_old_catalog_schema_migrate_without_new_media_ids() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("media");
    let state = temp.path().join("state");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&state).unwrap();
    std::fs::write(root.join("Legacy.mp4"), b"synthetic fixture").unwrap();
    let id = format!("{:x}", Sha256::digest(b"Legacy.mp4"));
    let db = rusqlite::Connection::open(state.join("progress.sqlite3")).unwrap();
    db.execute_batch("CREATE TABLE progress(id TEXT PRIMARY KEY,position REAL NOT NULL,duration REAL NOT NULL); CREATE TABLE media_catalog(id TEXT PRIMARY KEY,title TEXT NOT NULL,collection TEXT,series_id TEXT,series_title TEXT,season INTEGER,episode INTEGER,media_json TEXT NOT NULL); CREATE TABLE series_catalog(id TEXT PRIMARY KEY,title TEXT NOT NULL,search_text TEXT NOT NULL,series_json TEXT NOT NULL);").unwrap();
    db.execute("INSERT INTO progress VALUES(?1,14,60)", [&id])
        .unwrap();
    drop(db);
    let router = app(&root, &state);
    assert_eq!(get(&router, "/api/catalog").await["items"][0]["id"], id);
    assert_eq!(
        get(&router, "/api/catalog").await["items"][0]["libraryId"],
        "other"
    );
    assert_eq!(
        get(&router, &format!("/api/media/{id}/progress")).await["positionSeconds"],
        14.0
    );
    drop(router);
    let db = rusqlite::Connection::open(state.join("progress.sqlite3")).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM library_membership", [], |row| row
            .get::<_, u32>(0))
            .unwrap(),
        1
    );
    db.execute("UPDATE library_configuration SET config_json='broken'", [])
        .unwrap();
    drop(db);
    assert!(
        Library::open(&root, &state).is_err(),
        "Invalid persisted config must fail closed, never silently reset"
    );
    let db = rusqlite::Connection::open(state.join("progress.sqlite3")).unwrap();
    assert_eq!(
        db.query_row("SELECT config_json FROM library_configuration", [], |row| {
            row.get::<_, String>(0)
        })
        .unwrap(),
        "broken"
    );
    assert_eq!(
        db.query_row("SELECT position FROM progress WHERE id=?1", [&id], |row| {
            row.get::<_, f64>(0)
        })
        .unwrap(),
        14.0
    );
}

#[tokio::test]
async fn splitting_one_show_into_mixed_library_never_merges_its_series_or_search() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("media");
    for season in [1, 2] {
        let folder = root.join(format!("tv/Shared show/Season {season}"));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(
            folder.join(format!("Episode S0{season}E01.mp4")),
            b"synthetic",
        )
        .unwrap();
    }
    let router = app(&root, &temp.path().join("state"));
    let original = get(&router, "/api/series?library=tv").await;
    assert_eq!(original["items"][0]["episodes"], 2);
    let mut config = configuration(&router).await;
    config["libraries"].as_array_mut().unwrap().push(json!({"id":"specials","name":"Specials","mediaType":"mixed","visible":true,"order":4,"sourceFolders":["tv/Shared show/Season 2"]}));
    assert_eq!(
        request(
            &router,
            "PUT",
            "/api/admin/libraries",
            Some(TOKEN),
            Some(config)
        )
        .await
        .0,
        StatusCode::OK
    );
    let regular = get(&router, "/api/series?library=tv&search=Shared").await;
    let specials = get(&router, "/api/series?library=specials&search=Shared").await;
    assert_eq!(regular["items"][0]["episodes"], 1);
    assert_eq!(specials["items"][0]["episodes"], 1);
    assert_ne!(regular["items"][0]["id"], specials["items"][0]["id"]);
    let other_id = specials["items"][0]["id"].as_str().unwrap();
    assert_eq!(
        get(
            &router,
            &format!("/api/catalog?library=tv&series={other_id}")
        )
        .await["total"],
        0
    );
}

#[tokio::test]
async fn approved_root_selector_uses_longest_match_and_empty_catalogs_keep_descriptors() {
    let (_temp, router) = fixture();
    let mut config = configuration(&router).await;
    config["libraries"][0]["sourceFolders"] = json!(["."]);
    assert_eq!(
        request(
            &router,
            "PUT",
            "/api/admin/libraries",
            Some(TOKEN),
            Some(config)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(get(&router, "/api/catalog?library=tv").await["total"], 2);
    assert_eq!(
        get(&router, "/api/catalog?library=movies").await["total"],
        2
    );
    let empty = tempfile::tempdir().unwrap();
    let media = empty.path().join("media");
    std::fs::create_dir(&media).unwrap();
    let empty_app = app(&media, &empty.path().join("state"));
    assert_eq!(
        get(&empty_app, "/api/libraries").await["libraries"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    let page = get(&empty_app, "/api/catalog?library=movies").await;
    assert_eq!(page["total"], 0);
    assert_eq!(page["fullLibrary"], true);
}

#[cfg(unix)]
#[tokio::test]
async fn linked_source_folders_are_not_offered_or_accepted() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("media");
    let outside = temp.path().join("outside");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("private.mp4"), b"outside fixture").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
    let router = app(&root, &temp.path().join("state"));
    let admin = request(&router, "GET", "/api/admin/libraries", Some(TOKEN), None)
        .await
        .1;
    assert!(
        !admin["availableFolders"]
            .as_array()
            .unwrap()
            .contains(&json!("escape"))
    );
    let mut config = configuration(&router).await;
    config["libraries"][0]["sourceFolders"] = json!(["escape"]);
    assert_eq!(
        request(
            &router,
            "PUT",
            "/api/admin/libraries",
            Some(TOKEN),
            Some(config)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(get(&router, "/api/catalog").await["total"], 0);
}
