# Shinema working rules

- Make every future change on a branch and submit a pull request, including documentation, licensing and fixes. Do not commit or push directly to main.
- Keep incomplete implementation pull requests in draft. Do not merge without explicit user approval.
- Keep private configuration, credentials, signing material, device/network identifiers, personal paths, library metadata, media, build outputs and internal test evidence out of public commits.
- Use generated or suitably licensed test media. Media directories are read-only; writable application state belongs elsewhere.
- Do not change production media services, network access, display settings or credentials as part of development.
- Device access requires current explicit user availability. A user TV pause stops all device commands immediately, including verification and device cleanup. Host-only teardown may continue.
- Preserve dependency licenses and notices. The project MIT license applies to original Shinema code.
- Run relevant Rust tests, formatting/lint checks, client tests/typechecks and native builds. Report hardware validation separately from host checks.
