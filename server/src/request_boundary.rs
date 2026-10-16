//! Keep the unauthenticated development API inside its loopback trust boundary.
//! Binding a loopback socket alone does not reject DNS-rebound website hosts.
use axum::{
    extract::Request,
    http::{HeaderMap, StatusCode, Uri, uri::Authority},
    middleware::Next,
    response::Response,
};
use std::net::IpAddr;

fn loopback_authority(value: &str) -> bool {
    let Ok(authority) = value.parse::<Authority>() else {
        return false;
    };
    if value.contains('@') {
        return false;
    }
    let host = authority.host();
    let Some(suffix) = value.strip_prefix(host) else {
        return false;
    };
    // Authority parsing alone permits nonnumeric/empty/out-of-range ports.
    if !suffix.is_empty()
        && !suffix.strip_prefix(':').is_some_and(|port| {
            !port.is_empty()
                && port.bytes().all(|b| b.is_ascii_digit())
                && port.parse::<u16>().is_ok()
        })
    {
        return false;
    }
    let host = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host);
    host.eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Result<Option<&'a str>, ()> {
    let mut values = headers.get_all(name).iter();
    let value = values
        .next()
        .map(|v| v.to_str().map_err(|_| ()))
        .transpose()?;
    if values.next().is_some() {
        return Err(());
    }
    Ok(value)
}

fn allowed(headers: &HeaderMap, uri: &Uri) -> Result<(), ()> {
    let host = single_header(headers, "host")?;
    let authority = uri.authority().map(Authority::as_str);
    // HTTP/2 may carry :authority without Host. Absolute-form HTTP/1 requests
    // must not introduce a second, conflicting authority.
    if host.or(authority).is_none()
        || host.is_some_and(|value| !loopback_authority(value))
        || authority.is_some_and(|value| !loopback_authority(value))
        || host
            .zip(authority)
            .is_some_and(|(a, b)| !a.eq_ignore_ascii_case(b))
        || uri
            .scheme_str()
            .is_some_and(|s| !matches!(s, "http" | "https"))
    {
        return Err(());
    }
    if let Some(origin) = single_header(headers, "origin")? {
        let (scheme, authority) = origin.split_once("://").ok_or(())?;
        if !matches!(scheme, "http" | "https") || !loopback_authority(authority) {
            return Err(());
        }
    }
    // Cross-site subresource requests may omit Origin (for example <img>).
    if let Some(site) = single_header(headers, "sec-fetch-site")?
        && !matches!(site, "same-origin" | "same-site" | "none")
    {
        return Err(());
    }
    Ok(())
}

pub(crate) async fn guard(request: Request, next: Next) -> Result<Response, StatusCode> {
    allowed(request.headers(), request.uri()).map_err(|_| StatusCode::FORBIDDEN)?;
    Ok(next.run(request).await)
}
