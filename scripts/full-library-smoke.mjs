// Synthetic media only. Actual Rust/SQLite API, React navigation and browser
// decoding; desktop integration checks, not TV frame-time measurements.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, link, rm, copyFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '../clients/web/node_modules/playwright/index.mjs';
import { expect } from '../clients/web/node_modules/@playwright/test/index.mjs';
import { createServer } from '../clients/web/node_modules/vite/dist/node/index.js';
import { browserDiagnostics } from './browser-diagnostics.mjs';

const root = resolve('.');
const local = join(root, '.local');
await mkdir(local, { recursive: true });
const run = await mkdtemp(join(local, 'full-library-smoke-'));
const media = join(run, 'media');
const state = join(run, 'state');
const origin = 'http://127.0.0.1:29878';
const web = 'http://127.0.0.1:29873';
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
function generate(args) {
  const result = spawnSync(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', ...args],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr?.toString());
}
let server, vite, browser, diagnostics;
const result = {
  methodology:
    'Fresh full Chromium; original generated full-duration sources; 1,457 recursive media entries; loopback only.',
  checks: [],
  seeks: [],
};
async function wait(predicate, seconds = 90) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('Integration condition timed out');
}
try {
  const fixture = join(run, 'generated-full-source.mkv');
  generate([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '90',
    '-c:v',
    'libx264',
    '-threads',
    '2',
    '-preset',
    'ultrafast',
    '-crf',
    '32',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'pcm_s16le',
    fixture,
  ]);
  let fixtureCount = 0;
  const batches = new Map();
  for (let series = 0; series < 70; series++) {
    const directory = join(
      media,
      'tv',
      `Generated series ${String(series).padStart(2, '0')}`,
      'Season 1',
    );
    await mkdir(directory, { recursive: true });
    for (let episode = 1; episode <= (series === 0 ? 75 : 20); episode++) {
      const batch = Math.floor(fixtureCount++ / 500);
      if (!batches.has(batch)) {
        const path = join(run, `generated-batch-${batch}.mkv`);
        await copyFile(fixture, path);
        batches.set(batch, path);
      }
      await link(
        batches.get(batch),
        join(
          directory,
          `Generated S01E${String(episode).padStart(2, '0')}.mkv`,
        ),
      );
    }
  }
  const movieDirectory = join(media, 'movies', 'Generated film (2026)');
  await mkdir(movieDirectory, { recursive: true });
  generate([
    '-i',
    fixture,
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    join(movieDirectory, 'Generated film.mp4'),
  ]);
  generate([
    '-itsoffset',
    '0.3',
    '-i',
    fixture,
    '-i',
    fixture,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'libx265',
    '-preset',
    'ultrafast',
    '-x265-params',
    'pools=2:frame-threads=2:log-level=error',
    '-c:a',
    'eac3',
    join(movieDirectory, 'Generated HEVC film.mkv'),
  ]);
  const environment = {
    ...process.env,
    SHINEMA_MEDIA_ROOT: media,
    SHINEMA_STATE_DIR: state,
    SHINEMA_BIND: '127.0.0.1:29878',
  };
  for (const key of [
    'SHINEMA_SSH_CONFIG',
    'SHINEMA_TMDB_TOKEN_FILE',
    'SHINEMA_TVMAZE',
    'SHINEMA_WEB_ROOT',
  ])
    delete environment[key];
  server = spawn(
    join(
      root,
      'target',
      'debug',
      'shinema-server' + (process.platform === 'win32' ? '.exe' : ''),
    ),
    [],
    {
      env: environment,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    },
  );
  let error = '';
  server.stderr.on('data', (bytes) => (error += bytes));
  await wait(async () => {
    if (server.exitCode !== null)
      throw new Error('Synthetic server startup failed: ' + error);
    try {
      return (await fetch(origin + '/health')).ok;
    } catch {
      return false;
    }
  });
  const summary = await (await fetch(origin + '/api/library')).json();
  assert.deepEqual(summary, { movies: 2, series: 70, total: 1457, tv: 1455 });
  const ids = new Set();
  let offset = 0;
  do {
    const page = await (
      await fetch(origin + `/api/catalog?limit=60&offset=${offset}`)
    ).json();
    for (const item of page.items) {
      assert(!ids.has(item.id));
      ids.add(item.id);
    }
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(ids.size, 1457);
  result.checks.push(
    'Complete recursive index, SQLite totals, all pages without duplicate or missing IDs',
  );
  process.env.VITE_DEMO_MODE = 'false';
  process.env.SHINEMA_DEMO_DELAY_MS = '0';
  process.env.SHINEMA_API_ORIGIN = origin;
  vite = await createServer({
    configFile: join(root, 'clients', 'web', 'vite.config.ts'),
    root: join(root, 'clients', 'web'),
    server: { port: 29873, host: '127.0.0.1', strictPort: true },
  });
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    args: ['--mute-audio'],
  });
  result.browser = browser.version();
  diagnostics = browserDiagnostics(
    browser,
    join(root, 'ci-artifacts', 'browser-failure'),
  );
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  diagnostics.observe(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(web);
  await expect(
    page.getByRole('heading', { name: 'Movies', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'TV shows', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Open Generated series 00', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Open Generated series 60', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('61–70 of 70', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Previous page', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Open Generated series 00', exact: true })
    .click();
  await page.getByLabel('Season', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Open Generated S01E61', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('61–75 of 75', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Previous page', exact: true })
    .click();
  result.checks.push(
    'UI pagination crosses 60-item boundary for both series and episodes and returns to the first page',
  );
  await page
    .getByRole('button', { name: 'Open Generated S01E01', exact: true })
    .click();
  await page.getByRole('button', { name: /Play/ }).click();
  const video = page.locator('video');
  await expect
    .poll(
      () => video.evaluate((v) => v.getVideoPlaybackQuality().totalVideoFrames),
      { timeout: 90000 },
    )
    .toBeGreaterThan(3);
  const full = await video.evaluate((v) => ({
    duration: v.duration,
    muted: v.muted,
    defaultMuted: v.defaultMuted,
    volume: v.volume,
  }));
  assert(full.duration >= 90 && full.duration < 91);
  assert(full.muted && full.defaultMuted && full.volume === 0);
  for (const target of [5, 45, 80]) {
    const frames = await video.evaluate(
      (v) => v.getVideoPlaybackQuality().totalVideoFrames,
    );
    const start = performance.now();
    await video.evaluate((v, time) => {
      v.currentTime = time;
    }, target);
    await page.waitForFunction(
      ({ target, frames }) => {
        const v = document.querySelector('video');
        return (
          v &&
          !v.seeking &&
          !v.paused &&
          v.readyState >= 2 &&
          v.currentTime > target + 0.2 &&
          v.currentTime < target + 10 &&
          v.getVideoPlaybackQuality().totalVideoFrames > frames + 3
        );
      },
      { target, frames },
      { timeout: 90000 },
    );
    result.seeks.push({
      target,
      elapsedMs: Math.round(performance.now() - start),
    });
  }
  await video.evaluate((v) => {
    v.currentTime = 30;
  });
  await expect
    .poll(() => video.evaluate((v) => v.currentTime), { timeout: 90000 })
    .toBeGreaterThan(30.2);
  await page.getByRole('button', { name: 'Pause video' }).click();
  const saved = await video.evaluate((v) => v.currentTime);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Library', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Open Generated S01E01', exact: true }),
  ).toBeFocused();
  await page
    .getByRole('button', { name: 'Open Generated S01E01', exact: true })
    .click();
  await page.getByRole('button', { name: /Resume/ }).click();
  await page.waitForFunction(
    (saved) => {
      const v = document.querySelector('video');
      return (
        v &&
        !v.paused &&
        v.readyState >= 2 &&
        v.currentTime >= saved &&
        v.currentTime < saved + 10 &&
        v.getVideoPlaybackQuality().totalVideoFrames > 3
      );
    },
    saved,
    { timeout: 90000 },
  );
  result.checks.push(
    'Decoded full-duration HLS, beginning/middle/end seeks, stable timeline and resume after header exit',
  );
  await page.getByRole('button', { name: 'Back to details' }).click();
  await page.getByRole('button', { name: 'Back to library' }).click();
  await page.getByRole('button', { name: 'Movies', exact: true }).click();
  await page
    .getByRole('button', { name: 'Open Generated film', exact: true })
    .click();
  await page.getByRole('button', { name: /Play/ }).click();
  await expect
    .poll(() => video.evaluate((v) => v.currentTime), { timeout: 90000 })
    .toBeGreaterThan(1);
  assert((await video.evaluate((v) => v.duration)) >= 90);
  await page.getByRole('button', { name: 'Back to details' }).click();
  await page.getByRole('button', { name: 'Back to library' }).click();
  await page
    .getByRole('button', { name: 'Open Generated HEVC film', exact: true })
    .click();
  const hevcStart = performance.now();
  await page.getByRole('button', { name: /Play/ }).click();
  await expect
    .poll(() => video.evaluate((v) => v.currentTime), { timeout: 90000 })
    .toBeGreaterThan(0.3);
  result.hevcStartupMs = Math.round(performance.now() - hevcStart);
  const baseline = await video.evaluate((v) => v.currentTime);
  await new Promise((done) => setTimeout(done, 45000));
  const progressed = await video.evaluate((v) => v.currentTime);
  assert(progressed - baseline > 43, 'HEVC/EAC3 continuous playback stalled');
  result.checks.push(
    'Cold HEVC/EAC3 source with initial video/audio timestamp gap starts and sustains 45 seconds',
  );
  await page.getByRole('button', { name: 'Back to details' }).click();
  await page.getByRole('button', { name: 'Back to library' }).click();
  await context.route('**/api/**', (route) => route.abort());
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Open Generated film', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'The server is unavailable. This saved page is still here.',
      { exact: true },
    ),
  ).toBeVisible();
  result.checks.push(
    'Direct full-duration MP4 and cached browsing after API outage/reload',
  );
  const stalled = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  diagnostics.observe(stalled);
  const stalledPage = await stalled.newPage();
  let held = false;
  await stalled.route('**/api/catalog?**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('season') === '1' && !held) {
      held = true;
      const response = await route.fetch();
      await new Promise((done) => setTimeout(done, 12000));
      await route.fulfill({ response }).catch(() => {});
    } else await route.continue();
  });
  await stalledPage.goto(web);
  await stalledPage
    .getByRole('button', { name: 'TV shows', exact: true })
    .click();
  await stalledPage
    .getByRole('button', { name: 'Open Generated series 00', exact: true })
    .click();
  await stalledPage.getByLabel('Season', { exact: true }).selectOption('1');
  await expect(
    stalledPage.getByText(
      'The server is unavailable and this page has not been saved yet.',
      { exact: true },
    ),
  ).toBeVisible({ timeout: 13000 });
  await stalledPage.getByLabel('Season', { exact: true }).selectOption('all');
  await expect(
    stalledPage.getByRole('button', {
      name: 'Open Generated S01E01',
      exact: true,
    }),
  ).toBeVisible();
  await stalledPage.getByLabel('Search titles').fill('Does not exist');
  await stalledPage
    .getByRole('button', { name: 'Search', exact: true })
    .click();
  await expect(
    stalledPage.getByText('No titles match this search.', { exact: true }),
  ).toBeVisible();
  await new Promise((done) => setTimeout(done, 3000));
  await expect(
    stalledPage.getByText('No titles match this search.', { exact: true }),
  ).toBeVisible();
  await stalled.close();
  result.checks.push(
    'Episode request deadline clears loading and a late superseded reply cannot replace a newer search',
  );
  assert.deepEqual(errors, []);
  await context.close();
  await wait(async () => {
    const health = await (await fetch(origin + '/health')).json();
    return health.playback.activeCodecJobs === 0;
  });
  const health = await (await fetch(origin + '/health')).json();
  assert(health.playback.cachedBytes <= health.playback.cacheLimitBytes);
  result.checks.push(
    'No abandoned codec jobs; compatibility cache remains bounded',
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (diagnostics)
    await diagnostics.save(error, 'Generated full-library workload failed');
  throw error;
} finally {
  if (browser) await browser.close();
  if (vite) await vite.close();
  if (server && server.exitCode === null) {
    const stopped = new Promise((done) => server.once('exit', done));
    server.kill();
    await stopped;
  }
  assert(run.startsWith(local + sep));
  await rm(run, { recursive: true, force: true });
}
