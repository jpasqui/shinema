import { test as base, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Progress } from '../../../../packages/contracts/index.ts';
import { defaultLibraries } from '../../../../packages/contracts/index.ts';

export const duration = 90;
export const idFor = (index: number) => index.toString(16).padStart(64, '0');
export const mediaFor = (index: number) => ({
  id: idFor(index),
  title: `Generated movie ${String(index).padStart(5, '0')}`,
  container: 'mp4',
  sizeBytes: 100000,
  streamPath: `/api/media/${idFor(index)}/stream`,
  collection: 'movies',
  libraryId: 'movies',
});
export type SyntheticApi = {
  remote: Map<string, Progress>;
  writes: Array<{ id: string; value: Progress }>;
  requests: string[];
  blockedRequests: string[];
  total: number;
  failProgress: boolean;
  descriptor: 'direct' | 'transcode' | 'unavailable' | 'malformed';
  stream: 'ok' | 'disconnected';
};

function generate(args: string[]) {
  const result = spawnSync(
    process.env.FFMPEG ?? 'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Synthetic fixture generation failed: ${result.error ?? result.stderr}`,
    );
}

export const test = base.extend<
  { api: SyntheticApi },
  { syntheticMedia: { mp4: Buffer; hls: string; directory: string } }
>({
  syntheticMedia: [
    async ({ browserName: _browserName }, use) => {
      const directory = await mkdtemp(join(tmpdir(), 'shinema-playback-'));
      try {
        const mp4 = join(directory, 'generated.mp4');
        generate([
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=160x90:rate=10',
          '-t',
          String(duration),
          '-an',
          '-c:v',
          'libx264',
          '-threads',
          '1',
          '-preset',
          'ultrafast',
          '-crf',
          '32',
          '-pix_fmt',
          'yuv420p',
          '-g',
          '10',
          '-movflags',
          '+faststart',
          mp4,
        ]);
        const playlist = join(directory, 'index.m3u8');
        generate([
          '-i',
          mp4,
          '-c',
          'copy',
          '-hls_time',
          '2',
          '-hls_list_size',
          '0',
          '-hls_segment_filename',
          join(directory, 'segment-%03d.ts'),
          playlist,
        ]);
        await use({
          mp4: await readFile(mp4),
          hls: await readFile(playlist, 'utf8'),
          directory,
        });
      } finally {
        // This exact directory was created above, never a supplied media path.
        await rm(directory, { recursive: true, force: true });
      }
    },
    { scope: 'worker' },
  ],
  api: async ({ context, syntheticMedia }, use) => {
    const api: SyntheticApi = {
      remote: new Map(),
      writes: [],
      requests: [],
      blockedRequests: [],
      total: 1,
      failProgress: false,
      descriptor: 'direct',
      stream: 'ok',
    };
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== 'http://127.0.0.1:4187') {
        api.blockedRequests.push(request.url());
        return route.abort();
      }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      api.requests.push(url.pathname + url.search);
      const json = (body: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
      if (url.pathname === '/api/library')
        return json({ movies: api.total, tv: 0, series: 0, total: api.total });
      if (url.pathname === '/api/libraries')
        return json({ ...defaultLibraries(), revision: 1 });
      if (url.pathname === '/api/catalog') {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 60);
        const total =
          url.searchParams.get('search') ||
          (url.searchParams.has('library') &&
            url.searchParams.get('library') !== 'movies')
            ? 0
            : api.total;
        const count = Math.max(0, Math.min(limit, total - offset));
        return json({
          apiVersion: 1,
          fullLibrary: true,
          total,
          offset,
          limit,
          items: Array.from({ length: count }, (_, index) =>
            mediaFor(offset + index),
          ),
          nextOffset: offset + count < total ? offset + count : null,
        });
      }
      const match = /^\/api\/media\/([a-f0-9]{64})\/(.+)$/.exec(url.pathname);
      if (!match)
        throw new Error(`Unexpected synthetic API request: ${url.pathname}`);
      const [, id, resource] = match;
      if (resource === 'metadata')
        return json({ apiVersion: 1, items: [mediaFor(parseInt(id, 16))] });
      if (resource === 'progress') {
        if (api.failProgress)
          return json({ error: 'Synthetic disconnect' }, 503);
        if (request.method() === 'PUT') {
          const value = request.postDataJSON() as Progress;
          api.remote.set(id, value);
          api.writes.push({ id, value });
          return json(value);
        }
        return json(api.remote.get(id) ?? null);
      }
      if (resource === 'playback') {
        if (api.descriptor === 'unavailable') return json({}, 503);
        return json({
          durationSeconds: duration,
          mode: api.descriptor === 'transcode' ? 'transcode' : 'direct',
          streamPath:
            api.descriptor === 'malformed'
              ? 'https://unapproved.invalid/generated.mp4'
              : `/api/media/${id}/${api.descriptor === 'transcode' ? 'hls/index.m3u8' : 'stream'}`,
        });
      }
      if (resource === 'stream') {
        if (api.stream === 'disconnected')
          return route.abort('connectionreset');
        return fulfillVideo(route, syntheticMedia.mp4);
      }
      if (resource === 'hls/index.m3u8')
        return route.fulfill({
          contentType: 'application/vnd.apple.mpegurl',
          body: syntheticMedia.hls,
        });
      if (/^hls\/segment-\d{3}\.ts$/.test(resource)) {
        if (api.stream === 'disconnected')
          return route.fulfill({ status: 404, body: '' });
        return route.fulfill({
          contentType: 'video/mp2t',
          body: await readFile(
            join(syntheticMedia.directory, resource.slice(4)),
          ),
        });
      }
      throw new Error(`Unexpected synthetic media request: ${resource}`);
    });
    await use(api);
  },
});

async function fulfillVideo(route: Route, bytes: Buffer) {
  const range = route.request().headers().range;
  const match = range && /^bytes=(\d+)-(\d*)$/.exec(range);
  const start = match ? Number(match[1]) : 0;
  const end =
    match && match[2]
      ? Math.min(Number(match[2]), bytes.length - 1)
      : bytes.length - 1;
  await route.fulfill({
    status: match ? 206 : 200,
    contentType: 'video/mp4',
    headers: {
      'Accept-Ranges': 'bytes',
      ...(match
        ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` }
        : {}),
    },
    body: bytes.subarray(start, end + 1),
  });
}

export async function openMovie(page: Page, index = 0) {
  await page
    .getByRole('button', { name: `Open ${mediaFor(index).title}`, exact: true })
    .click();
  await page.getByRole('button', { name: /Play|Resume/ }).click();
}

/** Reach later rows through the same lazy edge used by scrolling, never pages. */
export async function revealMovie(page: Page, index: number) {
  const feed = page.getByTestId('library-feed');
  await expect
    .poll(async () => Number(await feed.getAttribute('data-loaded-count')))
    .toBeGreaterThan(0);
  const item = page.locator(`[data-browse-id="${idFor(index)}"]`);
  const gestures = [];
  const viewport = page.viewportSize()!;
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  for (let attempt = 0; attempt < 32; attempt++) {
    const position = await feed.evaluate((grid, targetIndex) => {
      const style = getComputedStyle(grid);
      const columns = Math.max(
        1,
        style.gridTemplateColumns.split(' ').filter(Boolean).length,
      );
      const card = grid.querySelector<HTMLElement>('[data-browse-index]');
      const target = grid.querySelector<HTMLElement>(
        `[data-browse-index="${targetIndex}"]`,
      );
      const stride =
        (card?.getBoundingClientRect().height ?? 0) +
        (Number.parseFloat(style.rowGap) || 0);
      const top =
        target?.getBoundingClientRect().top ??
        grid.getBoundingClientRect().top +
          Math.floor(targetIndex / columns) * stride;
      const height = (target ?? card)?.getBoundingClientRect().height ?? 0;
      return {
        scroll: window.scrollY,
        loaded: Number(grid.getAttribute('data-loaded-count')),
        top,
        bottom: top + height,
        viewport: window.innerHeight,
        mounted: !!target,
      };
    }, index);
    if (
      position.mounted &&
      position.top >= 1 &&
      position.bottom <= position.viewport - 1
    )
      break;
    // Capture a single destination before each gesture. Following a sentinel
    // locator while it moves can skip the requested row after an append.
    const distance = (position.top + position.bottom - position.viewport) / 2;
    const limit = position.viewport * 0.6;
    const delta = Math.max(-limit, Math.min(limit, distance));
    gestures.push({ ...position, delta });
    await page.mouse.wheel(0, delta);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(feed).toHaveAttribute('aria-busy', 'false');
  }
  await expect(item, JSON.stringify(gestures)).toBeInViewport({ ratio: 1 });
  return item;
}

export async function pauseDecoded(page: Page) {
  const video = page.locator('video');
  await expect
    .poll(() =>
      video.evaluate(
        (node: HTMLVideoElement) =>
          node.getVideoPlaybackQuality().totalVideoFrames,
      ),
    )
    .toBeGreaterThan(2);
  await page.getByRole('button', { name: 'Pause video', exact: true }).click();
  await expect(video).toHaveJSProperty('paused', true);
  return video;
}

export { expect };
