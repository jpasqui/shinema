# Running the server on a NAS

Shinema can run on a NAS beside Plex, the way Plex does: one container that indexes your media folders read-only, serves the app to browsers, and streams to the TV and phone apps on your network. It keeps its catalog, watch progress and paired devices in its own state folder and never writes to your media.

This works on any NAS with Docker Compose: TrueNAS SCALE 24.10 or later (as a Dockge stack or custom app), Unraid, Synology Container Manager, or a Linux server.

## Build the image

On the NAS, from a copy of this repository:

```sh
docker build -t shinema:local .
```

The build compiles the Rust server and the web app and installs ffmpeg, which prepares streams a TV cannot play directly. It needs internet access for Rust crates and npm packages and takes several minutes the first time.

## Run it

Your media needs `movies` and `tv` folders (the layout Plex uses works as is). Create a state folder owned by the user the container runs as, then use a stack such as:

```yaml
services:
  shinema:
    image: shinema:local
    pull_policy: never
    container_name: shinema
    restart: unless-stopped
    # The same user as your other media apps; it needs read access to the
    # media and write access to the state folder.
    user: '568:568'
    ports:
      - '8787:8787'
    volumes:
      - /mnt/<pool>/media/movies:/media/movies:ro
      - /mnt/<pool>/media/tv:/media/tv:ro
      - /mnt/<pool>/apps/shinema/state:/state
```

On TrueNAS SCALE with Dockge, put it in a `shinema` folder in Dockge's stacks directory and start it there.

The first start indexes everything; a large library takes a few minutes. New files are picked up every 15 minutes (`SHINEMA_RESCAN_MINUTES`).

## Connect a TV or phone

Open the app and enter the NAS address with port 8787, for example `192.168.1.20:8787`. The server asks the device for a six-digit pairing code. Codes are printed in the container log at startup (`docker logs shinema`) and last ten minutes; restart the container for a fresh one. Each paired device gets its own token, which can be revoked later.

A browser on your network can open `http://<nas-address>:8787` for the same app.

## Artwork and descriptions

Without a metadata source, titles without artwork get a designed poster. To fetch artwork:

- TV shows from TVmaze: add `SHINEMA_TVMAZE: '1'` under `environment`. This sends show names to tvmaze.com.
- Films and shows from TMDB: put a TMDB API read access token in a file in the state folder and add `SHINEMA_TMDB_TOKEN_FILE: /state/tmdb-token`. This sends titles to themoviedb.org.

## Update or remove

To update, rebuild the image from the new code and recreate the container; the state folder keeps the catalog, progress and paired devices. To remove Shinema, stop the stack and delete its folder and image. Your media and Plex are untouched either way.

Use plain HTTP only on your home network. For access from outside it, put Shinema behind a reverse proxy with HTTPS (Caddy, Tailscale), as with Jellyfin.
