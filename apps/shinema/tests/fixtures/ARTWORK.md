# Test artwork

`cinema-atlas.png` is the original synthetic artwork made for the Shinema design study (PR #11); its provenance and generation prompt are in that study's `assets/ARTWORK.md`. It contains six fictional 16:9 scenes in a 3 × 2 grid, with no text, logos, real films or real people.

`tests/mock-server.mjs` cuts posters and backdrops from it with ffmpeg when started with `SHINEMA_MOCK_ARTWORK=1`, so screenshots show the app with artwork. It is test media only and never ships in the app.
