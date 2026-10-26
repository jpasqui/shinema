# The Shinema server with the app it serves to browsers, for running on a NAS
# beside Plex. See docs/nas.md.

FROM rust:1.94-bookworm AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY server server
# The server embeds the content registry.
COPY packages/contracts packages/contracts
RUN cargo build --release --locked -p shinema-server

FROM node:24-bookworm-slim AS web
WORKDIR /src
COPY packages packages
COPY apps/shinema apps/shinema
RUN cd apps/shinema && npm ci --no-audit --no-fund && npm run export:web

FROM debian:bookworm-slim
# ffmpeg and ffprobe prepare streams the TV cannot play directly.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=server /src/target/release/shinema-server /usr/local/bin/shinema-server
COPY --from=web /src/apps/shinema/dist /srv/shinema/web
COPY LICENSE /srv/shinema/LICENSE
# Media is mounted read-only under /media (movies, tv); the catalog, progress
# and paired devices live in /state.
ENV SHINEMA_BIND=0.0.0.0:8787 \
  SHINEMA_MEDIA_ROOT=/media \
  SHINEMA_STATE_DIR=/state \
  SHINEMA_WEB_ROOT=/srv/shinema/web
EXPOSE 8787
CMD ["shinema-server"]
