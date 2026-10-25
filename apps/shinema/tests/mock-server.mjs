// A stand-in Shinema server with generated titles, for looking at the app
// and for screenshot checks without building the Rust server. It serves the
// exported web app from ./dist and a small slice of API version 1.
//
//   node tests/mock-server.mjs [port]   (default 8790)
//   SHINEMA_MOCK_PAIRING=1 also requires pairing with code 123-456.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.argv[2] ?? 8790);
const pairing = process.env.SHINEMA_MOCK_PAIRING === '1';
const video = process.env.SHINEMA_MOCK_VIDEO || null;
const TOKEN = 'e'.repeat(64);
const id = (text) => createHash('sha256').update(text).digest('hex');

const films = [
  'The Lighthouse Keeper',
  'Northern Lines',
  'A Quiet Harbour',
  'Paper Moons',
  'The Long Field',
  'Signal Fires',
  'Under Glass',
  'Low Tide',
  'Saltwater',
  'The Orchard',
  'Night Ferry',
  'Copper Sky',
  'Winter Garden',
  'Open Water',
  'The Cartographer',
  'Small Hours',
  'Station Eleven Road',
  'Blue Hour',
].map((title, index) => ({
  id: id(`movies/${title}.mkv`),
  title,
  container: 'mkv',
  sizeBytes: 1000 + index,
  streamPath: `/api/media/${id(`movies/${title}.mkv`)}/stream`,
  contentTypeId: 'movies',
  collection: 'movies',
  libraryId: 'movies',
  year: 1994 + index,
  summary: 'A generated fixture title with no real media behind it.',
}));
const shows = [
  'Harbour Lights',
  'The Survey',
  'Field Notes',
  'Second Shift',
].map((title) => ({
  id: id(`tv/${title}`),
  title,
  episodes: 8,
  seasons: 2,
  libraryId: 'tv',
}));

const json = (response, status, body) => {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(body === undefined ? '' : JSON.stringify(body));
};
const page = (items, url) => {
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 500);
  const slice = items.slice(offset, offset + limit);
  const next = offset + slice.length;
  return {
    items: slice,
    total: items.length,
    offset,
    limit,
    nextOffset: next < items.length ? next : null,
  };
};
const authorised = (request, url) =>
  !pairing ||
  request.headers.authorization === `Bearer ${TOKEN}` ||
  url.searchParams.get('access_token') === TOKEN;

const progress = new Map();

createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const path = url.pathname;
  if (path === '/health')
    return json(response, 200, {
      status: 'ok',
      apiVersion: 1,
      authRequired: pairing,
    });
  if (path === '/api/pairing/claim' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const claim = JSON.parse(body || '{}');
    return claim.code?.replace(/\D/g, '') === '123456'
      ? json(response, 201, {
          deviceId: 'mock-device',
          name: claim.deviceName,
          token: TOKEN,
        })
      : json(response, 403);
  }
  if (path.startsWith('/api/')) {
    if (!authorised(request, url)) return json(response, 401);
    if (path === '/api/libraries')
      return json(response, 200, {
        version: 1,
        revision: 1,
        libraries: [
          {
            id: 'movies',
            name: 'Movies',
            contentTypeId: 'movies',
            visible: true,
            order: 0,
          },
          {
            id: 'tv',
            name: 'TV',
            contentTypeId: 'tv',
            visible: true,
            order: 1,
          },
        ],
      });
    if (path === '/api/catalog') {
      const series = url.searchParams.get('series');
      if (series) {
        const show = shows.find((item) => item.id === series);
        const season = Number(url.searchParams.get('season') ?? 1);
        const episodes = Array.from({ length: 8 }, (_, index) => {
          const media = id(`tv/${show?.title}/S${season}E${index + 1}.mkv`);
          return {
            id: media,
            title: `Episode ${index + 1}`,
            container: 'mkv',
            sizeBytes: 500,
            streamPath: `/api/media/${media}/stream`,
            contentTypeId: 'tv',
            collection: 'tv',
            seriesId: series,
            seriesTitle: show?.title,
            season,
            episode: index + 1,
          };
        });
        return json(response, 200, { apiVersion: 1, ...page(episodes, url) });
      }
      return json(response, 200, { apiVersion: 1, ...page(films, url) });
    }
    if (path === '/api/series') return json(response, 200, page(shows, url));
    const seasons = path.match(/^\/api\/series\/([a-f0-9]{64})\/seasons$/);
    if (seasons)
      return json(response, 200, {
        items: [
          { season: 1, episodes: 8 },
          { season: 2, episodes: 8 },
        ],
      });
    const media = path.match(
      /^\/api\/media\/([a-f0-9]{64})\/(progress|subtitles|playback)$/,
    );
    if (media && media[2] === 'progress') {
      if (request.method === 'PUT') {
        let body = '';
        for await (const chunk of request) body += chunk;
        progress.set(media[1], JSON.parse(body));
        return json(response, 204);
      }
      return json(response, 200, progress.get(media[1]) ?? null);
    }
    // With SHINEMA_MOCK_VIDEO set, every title plays that file directly and
    // offers one English caption track.
    if (media && media[2] === 'subtitles')
      return json(response, 200, {
        tracks: video
          ? [
              {
                id: 'external-en',
                label: 'English',
                language: 'en',
                default: false,
                source: 'external',
                contentPath: `/api/media/${media[1]}/subtitles/external-en.vtt`,
              },
            ]
          : [],
      });
    if (media && media[2] === 'playback')
      return video
        ? json(response, 200, {
            durationSeconds: 30,
            mode: 'direct',
            streamPath: `/api/media/${media[1]}/stream`,
          })
        : json(response, 422);
    if (
      video &&
      /^\/api\/media\/[a-f0-9]{64}\/subtitles\/external-en\.vtt$/.test(path)
    ) {
      response.writeHead(200, { 'content-type': 'text/vtt' });
      return response.end(
        'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nGenerated caption one\n\n00:00:05.000 --> 00:00:08.000\nGenerated caption two\n',
      );
    }
    if (video && /^\/api\/media\/[a-f0-9]{64}\/stream$/.test(path)) {
      const size = statSync(video).size;
      const range = /bytes=(\d*)-(\d*)/.exec(request.headers.range ?? '');
      const start = range?.[1] ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      response.writeHead(range ? 206 : 200, {
        'content-type': 'video/mp4',
        'content-length': end - start + 1,
        'accept-ranges': 'bytes',
        ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
      });
      return createReadStream(video, { start, end }).pipe(response);
    }
    return json(response, 404);
  }
  // Static web app with single-page fallback.
  const file = normalize(join(root, path === '/' ? 'index.html' : path));
  const target =
    file.startsWith(normalize(root)) &&
    existsSync(file) &&
    statSync(file).isFile()
      ? file
      : join(root, 'index.html');
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.ttf': 'font/ttf',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.json': 'application/json',
  };
  response.writeHead(200, {
    'content-type': types[extname(target)] ?? 'application/octet-stream',
  });
  createReadStream(target).pipe(response);
}).listen(port, '127.0.0.1', () =>
  console.log(`Mock Shinema on http://127.0.0.1:${port}`),
);
