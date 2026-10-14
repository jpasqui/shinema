//! Optional prebuilt UI served from the same loopback Rust process. Only the
//! entry point and generated JS/CSS assets are reachable, never project files.
use axum::{
    body::Body,
    http::{StatusCode, Uri, header},
    response::Response,
};
use std::path::{Path, PathBuf};
pub fn configured() -> std::io::Result<Option<PathBuf>> {
    std::env::var_os("SHINEMA_WEB_ROOT")
        .map(|path| PathBuf::from(path).canonicalize())
        .transpose()
}
pub async fn response(root: Option<&Path>, uri: Uri) -> Result<Response, StatusCode> {
    let root = root.ok_or(StatusCode::NOT_FOUND)?;
    let raw = uri.path();
    let relative = if raw == "/" {
        "index.html"
    } else {
        raw.strip_prefix('/').ok_or(StatusCode::NOT_FOUND)?
    };
    if relative != "index.html"
        && (!relative.starts_with("assets/")
            || !relative
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"/-_.".contains(&byte))
            || relative
                .split('/')
                .any(|part| part.is_empty() || part.starts_with('.'))
            || !relative.ends_with(".js")
                && !relative.ends_with(".css")
                && !relative.ends_with(".svg"))
    {
        return Err(StatusCode::NOT_FOUND);
    }
    let path = crate::checked_file(root, Path::new(relative)).map_err(|_| StatusCode::NOT_FOUND)?;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let mime = if relative.ends_with(".js") {
        "text/javascript"
    } else if relative.ends_with(".css") {
        "text/css"
    } else if relative.ends_with(".svg") {
        "image/svg+xml"
    } else {
        "text/html; charset=utf-8"
    };
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(
            header::CACHE_CONTROL,
            if relative == "index.html" {
                "no-cache"
            } else {
                "public,max-age=31536000,immutable"
            },
        )
        .header("X-Content-Type-Options", "nosniff")
        .body(Body::from(bytes))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn built_ui_serves_only_entry_and_generated_assets() {
        let temporary = tempfile::tempdir().unwrap();
        let canonical = temporary.path().canonicalize().unwrap();
        let root = canonical.as_path();
        std::fs::create_dir(root.join("assets")).unwrap();
        std::fs::write(root.join("index.html"), "Generated UI").unwrap();
        std::fs::write(root.join("assets/app-test.js"), "Generated script").unwrap();
        std::fs::write(root.join("private.key"), "private").unwrap();
        assert!(response(Some(root), "/".parse().unwrap()).await.is_ok());
        assert!(
            response(Some(root), "/assets/app-test.js".parse().unwrap())
                .await
                .is_ok()
        );
        for path in [
            "/private.key",
            "/@fs/secret",
            "/assets/../private.key",
            "/assets/%2e%2e/private.key",
            "/api/unknown",
        ] {
            assert_eq!(
                response(Some(root), path.parse().unwrap()).await.err(),
                Some(StatusCode::NOT_FOUND)
            );
        }
    }
}
