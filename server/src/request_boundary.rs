//! Keep the unauthenticated development API inside its loopback trust boundary.
//! Binding a loopback socket alone does not reject DNS-rebound website hosts.
//!
//! A network-exposed server instead relies on paired device tokens (see
//! `devices`), so any well-formed Host is accepted there, while browser
//! requests must still come from this server's own origin or from loopback.
use crate::devices::Exposure;
use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode, Uri, uri::Authority},
    middleware::Next,
    response::Response,
};
use std::net::IpAddr;

/// Returns the host part of a well-formed `host[:port]` authority.
fn authority_host(value: &str) -> Option<&str> {
    let Ok(authority) = value.parse::<Authority>() else {
        return None;
    };
    if value.contains('@') {
        return None;
    }
    let host = authority.host();
    let suffix = value.strip_prefix(host)?;
    // Authority parsing alone permits nonnumeric/empty/out-of-range ports.
    if !suffix.is_empty()
        && !suffix.strip_prefix(':').is_some_and(|port| {
            !port.is_empty()
                && port.bytes().all(|b| b.is_ascii_digit())
                && port.parse::<u16>().is_ok()
        })
    {
        return None;
    }
    Some(&value[..host.len()])
}

fn loopback_authority(value: &str) -> bool {
    let Some(host) = authority_host(value) else {
        return false;
    };
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

/// Network exposure: the Host may be any well-formed authority (a LAN address
/// or hostname), but a browser Origin must match it or be loopback, so other
/// websites cannot drive the API even with a user's open tab.
fn network_allowed(headers: &HeaderMap, uri: &Uri) -> Result<(), ()> {
    let host = single_header(headers, "host")?;
    let authority = uri.authority().map(Authority::as_str);
    let effective = host.or(authority).ok_or(())?;
    if authority_host(effective).is_none()
        || authority.is_some_and(|value| authority_host(value).is_none())
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
        let (scheme, origin_authority) = origin.split_once("://").ok_or(())?;
        if !matches!(scheme, "http" | "https")
            || !(origin_authority.eq_ignore_ascii_case(effective)
                || loopback_authority(origin_authority))
        {
            return Err(());
        }
    }
    if let Some(site) = single_header(headers, "sec-fetch-site")?
        && !matches!(site, "same-origin" | "same-site" | "none")
    {
        return Err(());
    }
    Ok(())
}

/// True when the request passes the loopback Host/Origin rules.
pub(crate) fn loopback_request(headers: &HeaderMap, uri: &Uri) -> bool {
    allowed(headers, uri).is_ok()
}

pub(crate) async fn guard(
    State(exposure): State<Exposure>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    match exposure {
        Exposure::Loopback => allowed(request.headers(), request.uri()),
        Exposure::Network => network_allowed(request.headers(), request.uri()),
    }
    .map_err(|_| StatusCode::FORBIDDEN)?;
    Ok(next.run(request).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    #[test]
    fn network_mode_accepts_lan_hosts_but_not_foreign_origins() {
        let uri: Uri = "/api/catalog".parse().unwrap();
        assert!(network_allowed(&headers(&[("host", "192.168.1.20:8787")]), &uri).is_ok());
        assert!(network_allowed(&headers(&[("host", "shinema.lan:8787")]), &uri).is_ok());
        assert!(
            network_allowed(
                &headers(&[
                    ("host", "192.168.1.20:8787"),
                    ("origin", "http://192.168.1.20:8787")
                ]),
                &uri
            )
            .is_ok()
        );
        assert!(
            network_allowed(
                &headers(&[
                    ("host", "192.168.1.20:8787"),
                    ("origin", "https://evil.example")
                ]),
                &uri
            )
            .is_err()
        );
        assert!(
            network_allowed(
                &headers(&[
                    ("host", "192.168.1.20:8787"),
                    ("sec-fetch-site", "cross-site")
                ]),
                &uri
            )
            .is_err()
        );
        assert!(network_allowed(&headers(&[("host", "user@host")]), &uri).is_err());
        assert!(network_allowed(&headers(&[("host", "host:99999")]), &uri).is_err());
        assert!(network_allowed(&HeaderMap::new(), &uri).is_err());
    }

    #[test]
    fn loopback_mode_still_rejects_lan_hosts() {
        let uri: Uri = "/api/catalog".parse().unwrap();
        assert!(allowed(&headers(&[("host", "192.168.1.20:8787")]), &uri).is_err());
        assert!(allowed(&headers(&[("host", "127.0.0.1:8787")]), &uri).is_ok());
    }
}
