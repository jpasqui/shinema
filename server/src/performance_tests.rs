//! Generated, in-process browse workloads. No provider, SSH or media I/O.
use super::*;
use std::{hint::black_box, time::Instant};

fn fixture(movies: u32, shows: u32, episodes: u32) -> (tempfile::TempDir, Arc<Library>) {
    assert!(std::env::var_os("SHINEMA_TMDB_TOKEN_FILE").is_none());
    assert!(std::env::var("SHINEMA_TVMAZE").is_err());
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("media");
    fs::create_dir(&root).unwrap();
    let mut library = Library::open(&root, &temp.path().join("state")).unwrap();
    let owned = Arc::get_mut(&mut library).unwrap();
    for index in 0..movies + shows * episodes {
        let movie = index < movies;
        let number = index.saturating_sub(movies);
        let relative = if movie {
            PathBuf::from(format!("movies/Generated Film {index:06}.mp4"))
        } else {
            PathBuf::from(format!(
                "tv/Generated Series {:04}/Episode S01E{:03}.mkv",
                number / episodes,
                number % episodes + 1
            ))
        };
        let id = media_id(&relative);
        owned.entries.insert(
            id.clone(),
            Entry {
                media: Media {
                    stream_path: format!("/api/media/{id}/stream"),
                    id,
                    title: relative.file_stem().unwrap().to_str().unwrap().to_string(),
                    container: if movie { "mp4" } else { "mkv" }.into(),
                    size_bytes: 100,
                    classification: catalog::classify(&relative),
                    presentation: Presentation::default(),
                },
                relative,
                remote: None,
                modified: None,
            },
        );
    }
    catalog::replace_index(
        owned.database.get_mut().unwrap(),
        owned.entries.values().map(|e| e.media.clone()),
    )
    .unwrap();
    (temp, library)
}

fn measure(mut operation: impl FnMut(), samples: usize) -> serde_json::Value {
    for _ in 0..3 {
        operation();
    }
    let mut times = Vec::new();
    for _ in 0..samples {
        let started = Instant::now();
        operation();
        times.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    serde_json::json!({"samples":samples,"medianMs":times[samples / 2],"p95Ms":times[(samples * 95 / 100).min(samples - 1)]})
}

#[test]
#[ignore = "Synthetic release benchmark; run explicitly with --release --ignored --nocapture"]
fn browse_benchmark() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _runtime = runtime.enter();
    let (_temp, library) = fixture(100_000, 1000, 20);
    for (name, query) in [
        (
            "movies-first",
            catalog::CatalogQuery {
                collection: Some("movies".into()),
                limit: Some(60),
                ..Default::default()
            },
        ),
        (
            "movies-deep",
            catalog::CatalogQuery {
                collection: Some("movies".into()),
                offset: Some(90_000),
                limit: Some(60),
                ..Default::default()
            },
        ),
        (
            "movie-search",
            catalog::CatalogQuery {
                collection: Some("movies".into()),
                search: Some("Film 090".into()),
                limit: Some(60),
                ..Default::default()
            },
        ),
    ] {
        // CatalogQuery intentionally has no Clone requirement in production.
        let result = measure(
            || {
                let query = catalog::CatalogQuery {
                    collection: query.collection.clone(),
                    search: query.search.clone(),
                    offset: query.offset,
                    limit: query.limit,
                    ..Default::default()
                };
                black_box(catalog::page(&library.database.lock().unwrap(), query).unwrap());
            },
            30,
        );
        println!("{name}: {result}");
    }
    let result = measure(
        || {
            let _ = black_box(
                runtime
                    .block_on(series(
                        State(library.clone()),
                        Query(catalog::CatalogQuery {
                            limit: Some(60),
                            offset: Some(900),
                            ..Default::default()
                        }),
                    ))
                    .unwrap(),
            );
        },
        30,
    );
    println!("series-page: {result}");
    println!(
        "workload: 100000 movies + 1000 series * 20 episodes; 60 rows/page; 3 warmups; concurrency 1; memory SQLite; metadata providers disabled"
    );
}
