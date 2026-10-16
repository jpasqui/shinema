use super::*;
use axum::http::Request;
use http_body_util::BodyExt;
use std::io::Write;
use tower::ServiceExt;

const SRT: &str = "1\r\n00:01:05,250 --> 00:01:07,500\r\n<b>Hello</b> &amp; <i>world</i>\r\n\r\n2\r\n00:02:10,000 --> 00:02:12,750\r\nResume here\r\n";

#[test]
fn srt_normalization_keeps_absolute_timing_and_plain_safe_text() {
    assert_eq!(
        normalize(SRT.as_bytes(), false).unwrap(),
        "WEBVTT\n\n00:01:05.250 --> 00:01:07.500\nHello &amp; world\n\n00:02:10.000 --> 00:02:12.750\nResume here\n\n"
    );
    let text = normalize(b"WEBVTT\n\nSTYLE\n::cue {color:red}\n\nNOTE ignored\n\nidentifier\n01:05.250 --> 01:07.500 align:start\n<v Speaker><b>Hello</b></v> &lt;world&gt;\n", true).unwrap();
    assert_eq!(
        text,
        "WEBVTT\n\n00:01:05.250 --> 00:01:07.500\nHello &lt;world&gt;\n\n"
    );
    // Overlapping cues are allowed and ordered, without resetting to a seek or
    // resume position. Both clients select against the video's absolute clock.
    let overlap = normalize(
        b"2\n00:00:07,000 --> 00:00:09,000\nlate\n\n1\n00:00:01,000 --> 00:00:08,000\nearly",
        false,
    )
    .unwrap();
    assert!(overlap.find("early").unwrap() < overlap.find("late").unwrap());
    assert_eq!(
        plain_text("2 < 3; <b>bold</b>; <unclosed"),
        "2 &lt; 3; bold; &lt;unclosed"
    );
}

#[test]
fn parser_rejects_invalid_encoding_controls_timing_and_limits() {
    for (bytes, vtt) in [
        (vec![0xff, 0xfe, b'1', 0], false),
        (
            b"1\n00:00:01,000 --> 00:00:02,000\nunsafe\0".to_vec(),
            false,
        ),
        (
            "1\n00:00:01,000 --> 00:00:02,000\nunsafe\u{202e}"
                .as_bytes()
                .to_vec(),
            false,
        ),
        (
            b"WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000\n\n".to_vec(),
            true,
        ),
        (
            b"WEBVTT\n\n00:00:04.000 --> 00:00:03.000\nreverse".to_vec(),
            true,
        ),
        (
            b"WEBVTT\n\n00:61:04.000 --> 00:61:05.000\nbad minute".to_vec(),
            true,
        ),
        (
            b"WEBVTT\n\n-1:00:04.000 --> 00:00:05.000\nnegative".to_vec(),
            true,
        ),
        (
            b"WEBVTT\n\n169:00:00.000 --> 169:00:01.000\ntoo late".to_vec(),
            true,
        ),
        (b"WEBVTT\n\nmissing timing\nhello".to_vec(), true),
        (
            b"not a header\n\n00:00:01.000 --> 00:00:02.000\ntext".to_vec(),
            true,
        ),
        (vec![b'a'; MAX_BYTES + 1], false),
        (
            format!(
                "1\n00:00:01,000 --> 00:00:02,000\n{}",
                "a".repeat(MAX_CUE_BYTES)
            )
            .into_bytes(),
            false,
        ),
        (
            "1\n00:00:01,000 --> 00:00:02,000\ncue\n\n"
                .repeat(MAX_CUES + 1)
                .into_bytes(),
            false,
        ),
    ] {
        assert!(normalize(&bytes, vtt).is_err());
    }
    assert!(
        normalize(
            "\u{feff}WEBVTT\n\n00:00:01.000 --> 00:00:02.000\ncafé 字幕".as_bytes(),
            true
        )
        .unwrap()
        .contains("café 字幕")
    );
}

#[test]
fn public_track_fields_have_bounded_safe_identifiers_and_labels() {
    for id in [
        "../secret",
        "external-../file",
        "A",
        "%2f",
        "",
        &"a".repeat(81),
    ] {
        assert!(!valid_track_id(id));
    }
    for id in ["embedded-1", "external-a012f"] {
        assert!(valid_track_id(id));
    }
    for language in ["en", "eng", "pt-BR", "zh-Hant-TW", "und"] {
        assert!(valid_language(language));
    }
    for language in [
        "e",
        "English",
        "en_uk",
        "en--US",
        "en-\nUS",
        "en-US-US-US-US",
    ] {
        assert!(!valid_language(language));
    }
    assert_eq!(clean_label("<title>\n\u{202e}"), "title");
    assert_eq!(clean_label(" \t  "), "");
    assert_eq!(clean_label("  English  "), "English");
    assert_eq!(clean_label(&"字幕".repeat(200)).chars().count(), 200);
    for codec in ["subrip", "webvtt", "mov_text"] {
        assert_eq!(unsupported_codec(codec), None);
    }
    for codec in [
        "ass",
        "ssa",
        "hdmv_pgs_subtitle",
        "dvd_subtitle",
        "dvb_subtitle",
        "unknown",
    ] {
        assert!(unsupported_codec(codec).is_some());
    }
}

fn fixture() -> (tempfile::TempDir, Arc<Library>, String) {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("media");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("Movie.mp4"), b"synthetic-byte-fixture").unwrap();
    let library = Library::open(&root, &temporary.path().join("state")).unwrap();
    let entry = library.entries.values().next().unwrap();
    let id = entry.media.id.clone();
    // Byte fixtures intentionally have no codecs. Seed the empty embedded
    // probe so these HTTP safety tests need no external tool or live listener.
    library
        .subtitles
        .embedded
        .lock()
        .unwrap()
        .insert(entry.fingerprint(library.root.as_deref()), Vec::new());
    (temporary, library, id)
}
async fn request(app: axum::Router, uri: &str) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let response = app
        .oneshot(
            Request::builder()
                .uri(uri)
                .header(header::HOST, "127.0.0.1:8787")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    (status, headers, bytes)
}

#[tokio::test]
async fn sidecar_api_discovers_same_stem_tracks_and_serves_only_plain_utf8_vtt() {
    let (temporary, library, id) = fixture();
    let root = temporary.path().join("media");
    std::fs::write(root.join("Movie.en.default.srt"), SRT).unwrap();
    std::fs::write(
        root.join("Movie.es.vtt"),
        "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHola",
    )
    .unwrap();
    std::fs::write(root.join("Movie.ja.ass"), "styled").unwrap();
    std::fs::write(root.join("Movie2.srt"), "different media").unwrap();
    std::fs::write(root.join("Unrelated.srt"), "private").unwrap();
    std::fs::create_dir(root.join("Movie.folder.srt")).unwrap();
    let app = crate::router(library);
    let (status, _, bytes) = request(app.clone(), &format!("/api/media/{id}/subtitles")).await;
    assert_eq!(status, StatusCode::OK);
    let data: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let tracks = data["tracks"].as_array().unwrap();
    assert_eq!(tracks.len(), 3);
    assert!(
        !String::from_utf8(bytes)
            .unwrap()
            .contains(temporary.path().to_str().unwrap())
    );
    let english = tracks
        .iter()
        .find(|track| track["language"] == "en")
        .unwrap();
    assert_eq!(english["default"], true);
    assert_eq!(english["source"], "external");
    let styled = tracks
        .iter()
        .find(|track| track["language"] == "ja")
        .unwrap();
    assert!(styled.get("contentPath").is_none());
    assert!(
        styled["unsupportedReason"]
            .as_str()
            .unwrap()
            .contains("ASS/SSA")
    );
    let (status, headers, bytes) =
        request(app.clone(), english["contentPath"].as_str().unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "text/vtt; charset=utf-8");
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert!(
        String::from_utf8(bytes)
            .unwrap()
            .contains("00:02:10.000 --> 00:02:12.750")
    );
    assert_eq!(
        std::fs::read_to_string(root.join("Movie.en.default.srt")).unwrap(),
        SRT
    );
    for track in [
        "..%2fsecret.vtt",
        "external-..%5csecret.vtt",
        "external-unknown.vtt",
        "embedded-999.vtt",
        "external-unknown.srt",
    ] {
        assert_eq!(
            request(app.clone(), &format!("/api/media/{id}/subtitles/{track}"))
                .await
                .0,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        request(
            app.clone(),
            &format!(
                "/api/media/{id}/subtitles/{}.vtt",
                styled["id"].as_str().unwrap()
            )
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    std::fs::write(root.join("Movie.en.default.srt"), [0xff, 0xfe, 0]).unwrap();
    assert_eq!(
        request(app.clone(), english["contentPath"].as_str().unwrap())
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    std::fs::remove_file(root.join("Movie.en.default.srt")).unwrap();
    assert_eq!(
        request(app.clone(), english["contentPath"].as_str().unwrap())
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    std::fs::write(root.join("Movie.mp4"), b"changed source").unwrap();
    assert_eq!(
        request(app, &format!("/api/media/{id}/subtitles")).await.0,
        StatusCode::CONFLICT
    );
}

#[test]
fn sidecar_opens_refuse_paths_links_special_files_and_oversize() {
    let (temporary, library, _) = fixture();
    let root = temporary.path().join("media");
    let directory = library.directory.as_ref().unwrap();
    std::fs::write(root.join("Movie.srt"), SRT).unwrap();
    std::fs::hard_link(root.join("Movie.srt"), root.join("Movie.en.srt")).unwrap();
    assert!(ordinary_file(directory, Path::new("Movie.en.srt")).is_err());
    assert!(ordinary_file(directory, Path::new("../media/Movie.srt")).is_err());
    assert!(ordinary_file(directory, &root.join("Movie.srt")).is_err());
    let oversized = std::fs::File::create(root.join("Movie.large.srt")).unwrap();
    oversized.set_len(MAX_BYTES as u64 + 1).unwrap();
    assert!(ordinary_file(directory, Path::new("Movie.large.srt")).is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(root.join("Movie.srt"), root.join("Movie.link.srt")).unwrap();
        std::os::unix::fs::symlink(temporary.path(), root.join("linked-directory")).unwrap();
        assert!(ordinary_file(directory, Path::new("Movie.link.srt")).is_err());
        assert!(parent_directory(directory, Path::new("linked-directory/Movie.mp4")).is_err());
    }
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_file(root.join("Movie.srt"), root.join("Movie.link.srt"))
            .is_ok()
        {
            assert!(ordinary_file(directory, Path::new("Movie.link.srt")).is_err());
        }
    }
    assert!(
        external(&library, library.entries.values().next().unwrap())
            .unwrap()
            .0
            .is_empty()
    );
}

// A controlled child of this test binary avoids shell commands and an FFmpeg
// dependency in cancellation/timeout tests. Ordinary cargo test runs return.
#[test]
fn controlled_process_child() {
    let Some(path) = std::env::var_os("SHINEMA_SUBTITLE_TEST_CHILD") else {
        return;
    };
    std::fs::write(path, std::process::id().to_string()).unwrap();
    if std::env::var_os("SHINEMA_SUBTITLE_TEST_FLOOD").is_some() {
        let _ = std::io::stdout().write_all(&vec![b'x'; MAX_BYTES * 2]);
    }
    std::thread::sleep(std::time::Duration::from_secs(30));
}
fn child_command(path: &Path) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "subtitles::tests::controlled_process_child",
            "--nocapture",
        ])
        .env("SHINEMA_SUBTITLE_TEST_CHILD", path);
    command
}
async fn assert_dead(pid: u32) {
    for _ in 0..100 {
        if !crate::cache_lease::alive(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("Canceled subtitle process remained alive");
}
#[tokio::test]
async fn interrupted_subtitle_body_aborts_its_job_and_process() {
    let temporary = tempfile::tempdir().unwrap();
    let process = BoundedProcess::spawn(child_command(&temporary.path().join("pid"))).unwrap();
    let pid = process.child.id().unwrap();
    let job = tokio::spawn(async move { process.read(MAX_BYTES).await.map(Bytes::from) });
    let body = Body::from_stream(SubtitleBody { job, done: false });
    tokio::task::yield_now().await;
    drop(body);
    assert_dead(pid).await;
}
#[tokio::test]
async fn codec_timeout_and_output_limit_kill_the_process() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("pid");
    assert!(
        process_output(child_command(&path), MAX_BYTES, 1)
            .await
            .is_err()
    );
    let pid = std::fs::read_to_string(&path).unwrap().parse().unwrap();
    assert_dead(pid).await;
    let mut command = child_command(&path);
    command.env("SHINEMA_SUBTITLE_TEST_FLOOD", "1");
    assert!(process_output(command, 256, 5).await.is_err());
    let pid = std::fs::read_to_string(path).unwrap().parse().unwrap();
    assert_dead(pid).await;
}

#[tokio::test]
#[ignore = "requires FFmpeg and ffprobe; run explicitly in subtitle smoke CI"]
async fn generated_embedded_formats_preserve_media_time_and_report_styled_tracks() {
    let temporary = tempfile::tempdir().unwrap();
    let media = temporary.path().join("media");
    std::fs::create_dir(&media).unwrap();
    let captions = temporary.path().join("captions.srt");
    std::fs::write(&captions, "1\n00:00:01,250 --> 00:00:02,500\nFirst generated cue\n\n2\n00:00:07,500 --> 00:00:08,500\nResume generated cue\n").unwrap();
    for (extension, codec, video) in [
        ("mkv", "srt", "libx264"),
        ("mp4", "mov_text", "libx264"),
        ("webm", "webvtt", "libvpx"),
    ] {
        let mut command = std::process::Command::new("ffmpeg");
        command
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=16x16:r=1:d=10",
                "-i",
            ])
            .arg(&captions)
            .args([
                "-map",
                "0:v:0",
                "-map",
                "1:0",
                "-c:v",
                video,
                "-threads",
                "1",
                "-c:s:0",
                codec,
                "-metadata:s:s:0",
                "language=eng",
                "-disposition:s:0",
                "default",
            ]);
        if extension == "mkv" {
            command.args([
                "-map",
                "1:0",
                "-c:s:1",
                "ass",
                "-disposition:s:1",
                "0",
                "-metadata:s:s:1",
                "title=Styled unsupported",
            ]);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let result = command
            .arg(media.join(format!("Generated.{extension}")))
            .output()
            .expect("FFmpeg required for this explicit integration test");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    let library = Library::open(&media, &temporary.path().join("state")).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = crate::router_at(library.clone(), address);
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let client = reqwest::Client::new();
    for entry in library.entries.values() {
        let base = format!("http://{address}");
        let data: serde_json::Value = client
            .get(format!("{base}/api/media/{}/subtitles", entry.media.id))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(data.get("warnings").is_none(), "{data}");
        let tracks = data["tracks"].as_array().unwrap();
        let track = tracks
            .iter()
            .find(|track| track.get("contentPath").is_some())
            .unwrap();
        assert_eq!(track["language"], "eng");
        assert_eq!(track["default"], true);
        for _ in 0..2 {
            let text = client
                .get(format!("{base}{}", track["contentPath"].as_str().unwrap()))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .text()
                .await
                .unwrap();
            assert!(text.contains("00:00:01.250 --> 00:00:02.500"), "{text}");
            assert!(text.contains("00:00:07.500 --> 00:00:08.500"), "{text}");
            assert!(text.contains("Resume generated cue"));
        }
        if entry.media.container == "mkv" {
            assert_eq!(tracks.len(), 2);
            assert!(
                tracks[1]["unsupportedReason"]
                    .as_str()
                    .unwrap()
                    .contains("ASS/SSA")
            );
            assert!(tracks[1].get("contentPath").is_none());
        }
    }
    server.abort();
    let _ = server.await;
}
