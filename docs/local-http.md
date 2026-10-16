# Local HTTP connections on Android TV

HTTPS remains the default. A server certificate must pass Android's normal certificate and hostname checks; the client does not disable TLS verification or silently retry an HTTPS address over HTTP.

To connect to an HTTP server on a trusted local network, enter its address and explicitly allow unencrypted HTTP for that server in setup. The warning applies to the displayed origin: scheme, hostname and port. HTTP exposes media, library information and playback progress to anyone able to intercept that network. Do not enter credentials in a server URL.

Consent is saved only when that server becomes the confirmed connection. Editing the address clears the draft choice. A failed switch, or one canceled before final confirmation starts, keeps the previous confirmed connection and its own consent. Once the final atomic confirmation starts, it completes; a late result cannot replace a newer choice. On restart, only consent matching the confirmed canonical HTTP origin can enable network access. An older cache without consent can still be retained offline.

## Address and redirect checks

HTTP is limited to IPv4 private ranges (`10/8`, `172.16/12`, `192.168/16`), loopback, IPv4 link-local, IPv6 unique-local and IPv6 link-local addresses. Hostnames are supported only when every resolved address is local. Public, unspecified and multicast addresses, and mixed local/public DNS responses, are rejected. IPv4-mapped IPv6 addresses are checked using their underlying IPv4 address. Interface-zone URL literals are not supported.

The client resolves names again for connections and checks the actual connected address. It rejects stale permission generations, including revoke/regrant to the same address. HTTP requests cannot pass through a system proxy. Redirects must stay within the original scheme, host and port; an HTTP opt-in never authorizes another endpoint or an HTTPS-to-HTTP downgrade.

Android's static transport configuration permits HTTP so users can select local hostnames at runtime. The shared native network client enforces the rules above for API calls, Requests, artwork, subtitles and video. HTTPS continues using platform certificate validation. The web client's server-address policy is unchanged by this native feature.

## Server boundaries and checks

This client option does not expose the Rust server to a network. Rust still binds only to loopback, and existing read-only SSH media access and server authentication boundaries remain unchanged. An authorized temporary ADB reverse can connect a device's loopback port to an isolated host loopback server during testing; verify the device listener is actually loopback-bound, since a plain TCP reverse can bind all interfaces. This is not a persistent deployment.

Native unit tests cover consent recovery, canceled and competing server changes, App ownership across Activity recreation, URL validation and adapter propagation. Android JVM tests cover address classification, DNS, redirects and permission revocation. CI runs those tests before building the unsigned Android development APK. Hardware decoding, remote navigation and real media performance need separate device evidence.
