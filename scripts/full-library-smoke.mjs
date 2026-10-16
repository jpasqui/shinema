// Synthetic media only. Actual Rust/SQLite API, React navigation and browser
// decoding; desktop integration checks, not TV frame-time measurements.
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  link,
  rm,
  copyFile,
  readFile,
  writeFile,
  readdir,
  symlink,
  realpath,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
let server, vite, beforeVite, browser, diagnostics;
const captureEvidence = process.env.SHINEMA_PUBLIC_EVIDENCE === '1';
const evidence = join(root, 'ci-artifacts', 'public-fixtures');
const beforeRevision = 'c2d82902fab5fc9e4e16555d5978df943f5ab865';
async function captureBefore() {
  const beforeRoot = resolve(
    process.env.SHINEMA_BEFORE_UI_ROOT ?? 'local-tools/pr5-before',
  );
  // Execute only the pinned original project source, never a local/private UI.
  const gitRoot = await realpath(join(beforeRoot, '.git'))
    .then(() => beforeRoot)
    .catch(() => root);
  const files = spawnSync(
    'git',
    [
      '-C',
      gitRoot,
      'ls-tree',
      '-r',
      '--name-only',
      beforeRevision,
      'clients/web',
      'packages',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(files.status, 0, 'Pinned before revision is unavailable');
  for (const name of files.stdout.trim().split(/\r?\n/)) {
    const original = spawnSync('git', [
      '-C',
      gitRoot,
      'show',
      `${beforeRevision}:${name}`,
    ]);
    assert.equal(original.status, 0);
    assert.equal(
      (await readFile(join(beforeRoot, name), 'utf8')).replaceAll('\r\n', '\n'),
      original.stdout.toString('utf8').replaceAll('\r\n', '\n'),
      'Before source differs from pinned public revision: ' + name,
    );
  }
  const modules = join(beforeRoot, 'clients/web/node_modules');
  const trustedModules = join(root, 'clients/web/node_modules');
  try {
    assert.equal(await realpath(modules), await realpath(trustedModules));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await symlink(
      trustedModules,
      modules,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  beforeVite = await createServer({
    configFile: join(beforeRoot, 'clients/web/vite.config.ts'),
    root: join(beforeRoot, 'clients/web'),
    server: { port: 39873, host: '127.0.0.1', strictPort: true },
  });
  await beforeVite.listen();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await loopbackOnly(context);
  try {
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:39873');
    await expect(
      page.getByRole('button', { name: 'Open Generated film', exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: join(evidence, 'before-movies.png') });
    await page.getByRole('button', { name: 'TV shows', exact: true }).click();
    await expect(
      page.getByRole('button', {
        name: 'Open Generated series 00',
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({ path: join(evidence, 'before-series.png') });
  } finally {
    await context.close();
    await beforeVite.close();
    beforeVite = undefined;
  }
}
async function loopbackOnly(context) {
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1')
      return route.continue();
    return route.abort();
  });
}

const result = {
  methodology:
    'Fresh full Chromium; original generated full-duration sources; 1,457 recursive media entries; loopback only.',
  checks: [],
  feedAppends: [],
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
async function documentBounds(locator) {
  return locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
  });
}
function assertStableBounds(before, after, message) {
  for (const key of ['x', 'y', 'width', 'height'])
    assert(
      Math.abs(before[key] - after[key]) <= 1,
      `${message}: ${key} changed from ${before[key]} to ${after[key]}`,
    );
}
async function proveLayoutOracle(locator, baseline) {
  const style = await locator.getAttribute('style');
  const restore = async () => {
    await locator.evaluate((node, original) => {
      if (original === null) node.removeAttribute('style');
      else node.setAttribute('style', original);
      node.style.setProperty('transition', 'none', 'important');
      node.getBoundingClientRect();
      if (original === null) node.removeAttribute('style');
      else node.setAttribute('style', original);
    }, style);
  };
  try {
    for (const [property, value, dimension] of [
      ['transform', 'translateY(8px)', 'y'],
      ['width', `${baseline.width + 8}px`, 'width'],
    ]) {
      await locator.evaluate(
        (node, [property, value]) => {
          node.style.setProperty('transition', 'none', 'important');
          node.style.setProperty(property, value, 'important');
        },
        [property, value],
      );
      const moved = await documentBounds(locator);
      assert.throws(
        () => assertStableBounds(baseline, moved, 'Injected layout mutation'),
        new RegExp(`${dimension} changed`),
        'Layout checks must reject an injected eight-pixel regression',
      );
      await restore();
    }
  } finally {
    await restore();
  }
  assertStableBounds(
    baseline,
    await documentBounds(locator),
    'Restored card after layout-oracle mutations',
  );
}
async function noPageControls(page) {
  await expect(
    page.getByRole('button', { name: /^(Next|Previous) page$/ }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Library pages', { exact: true })).toHaveCount(
    0,
  );
}
async function appendAtBoundary(page, resource, expectedCount, nextTitle) {
  const feed = page.getByTestId('library-feed');
  const rows = feed.locator('button[data-browse-id]');
  await expect(rows).toHaveCount(60);
  await expect(feed).toHaveAttribute('data-loaded-count', '60');
  await noPageControls(page);
  const initialIds = await rows.evaluateAll((nodes) =>
    nodes.map((node) => node.dataset.browseId),
  );
  const first = page.locator(`[data-browse-id="${initialIds[0]}"]`);
  const last = page.locator(`[data-browse-id="${initialIds.at(-1)}"]`);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let requests = 0;
  const pattern = `**/api/${resource}?**`;
  const handler = async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('offset') !== '60') return route.continue();
    requests++;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  };
  await page.route(pattern, handler);
  try {
    // The first 60 records must remain while the next real API batch is held.
    await page.getByTestId('library-sentinel').scrollIntoViewIfNeeded();
    await expect.poll(() => requests).toBe(1);
    await last.focus();
    await expect(last).toBeFocused();
    await expect(rows).toHaveCount(60);
    const before = {
      first: await documentBounds(first),
      last: await documentBounds(last),
    };
    release();
    await expect(rows).toHaveCount(expectedCount);
    await expect(feed).toHaveAttribute(
      'data-loaded-count',
      String(expectedCount),
    );
    await expect(
      page.getByRole('button', { name: `Open ${nextTitle}`, exact: true }),
    ).toBeVisible();
    await expect(last).toBeFocused();
    const ids = await rows.evaluateAll((nodes) =>
      nodes.map((node) => node.dataset.browseId),
    );
    assert.deepEqual(ids.slice(0, initialIds.length), initialIds);
    assert.equal(new Set(ids).size, expectedCount, 'Appended IDs are unique');
    assert.equal(requests, 1, 'One boundary requests exactly one next batch');
    const after = {
      first: await documentBounds(first),
      last: await documentBounds(last),
    };
    assertStableBounds(before.first, after.first, 'First card during append');
    assertStableBounds(before.last, after.last, 'Focused card during append');
    await noPageControls(page);
    await expect(
      page.getByText(`All ${expectedCount} titles loaded.`, { exact: true }),
    ).toBeVisible();
    // The feature and season toolbar can fill the first viewport. Reveal the
    // earlier card itself when checking that scroll-back preserves the feed.
    await first.scrollIntoViewIfNeeded();
    await expect(first).toBeInViewport();
    return {
      resource,
      initialCount: 60,
      count: ids.length,
      before,
      after,
    };
  } finally {
    release();
    await page.unroute(pattern, handler);
  }
}
try {
  if (captureEvidence) {
    await mkdir(evidence, { recursive: true });
    assert.deepEqual(
      await readdir(evidence),
      [],
      'Public evidence directory must start empty',
    );
  }
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
  const offsets = new Set();
  let offset = 0;
  do {
    assert(!offsets.has(offset), 'API batches must not repeat an offset');
    offsets.add(offset);
    const page = await (
      await fetch(origin + `/api/catalog?limit=60&offset=${offset}`)
    ).json();
    assert.equal(page.total, 1457);
    assert(page.items.length <= 60, 'API batches stay bounded');
    for (const item of page.items) {
      assert(!ids.has(item.id));
      ids.add(item.id);
    }
    const next = page.nextOffset;
    assert(
      next === null ||
        (Number.isInteger(next) && next > offset && next < page.total),
      'A continuation offset must advance within the catalog',
    );
    offset = next;
  } while (offset !== null);
  assert.equal(ids.size, 1457);
  result.checks.push(
    'Complete recursive index, SQLite totals and bounded internal API batches without duplicate or missing IDs',
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
  // Prove the geometry oracle before creating the recorded public workload.
  // Deliberate test mutations must never appear as app movement in evidence.
  const oracleContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  diagnostics.observe(oracleContext);
  try {
    const oraclePage = await oracleContext.newPage();
    await oraclePage.setContent(
      '<button style="display:block;box-sizing:border-box;width:160px;height:240px">Generated layout fixture</button>',
    );
    const fixtureCard = oraclePage.getByRole('button', {
      name: 'Generated layout fixture',
      exact: true,
    });
    await proveLayoutOracle(fixtureCard, await documentBounds(fixtureCard));
    result.layoutOracle = { positionAndSizeMutationsRejected: true };
  } finally {
    await oracleContext.close();
  }
  if (captureEvidence) await captureBefore();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ...(captureEvidence
      ? {
          recordVideo: {
            dir: join(run, 'recording'),
            size: { width: 1280, height: 900 },
          },
        }
      : {}),
  });
  await loopbackOnly(context);
  diagnostics.observe(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(web);
  await expect(
    page.getByRole('heading', { name: 'Movies', exact: true }),
  ).toBeVisible();
  if (captureEvidence) {
    await expect(
      page.getByRole('button', { name: 'Open Generated film', exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: join(evidence, 'after-movies.png') });
  }
  await page.getByRole('button', { name: 'TV shows', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Open Generated series 00', exact: true }),
  ).toBeVisible();
  if (captureEvidence)
    await page.screenshot({ path: join(evidence, 'after-series.png') });
  result.feedAppends.push(
    await appendAtBoundary(page, 'series', 70, 'Generated series 60'),
  );
  await page
    .getByRole('button', { name: 'Open Generated series 00', exact: true })
    .click();
  await page.getByLabel('Season', { exact: true }).selectOption('1');
  result.feedAppends.push(
    await appendAtBoundary(page, 'catalog', 75, 'Generated S01E61'),
  );
  result.checks.push(
    'Series and episode feeds lazily append past 60 records without page controls, duplicate requests, replaced cards, moved anchors or stolen focus; scrolling back retains earlier titles',
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
    page.getByRole('button', { name: 'Retry loading', exact: true }),
  ).toBeVisible();
  await noPageControls(page);
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
    stalledPage.getByRole('button', { name: 'Retry loading', exact: true }),
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
  const recording = page.video();
  await context.close();
  if (captureEvidence)
    await recording.saveAs(join(evidence, 'interactions.webm'));
  await wait(async () => {
    const health = await (await fetch(origin + '/health')).json();
    return health.playback.activeCodecJobs === 0;
  });
  const health = await (await fetch(origin + '/health')).json();
  assert(health.playback.cachedBytes <= health.playback.cacheLimitBytes);
  result.checks.push(
    'No abandoned codec jobs; compatibility cache remains bounded',
  );
  if (captureEvidence) {
    const sourceRevision =
      process.env.SHINEMA_SOURCE_REVISION ??
      spawnSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).stdout.trim();
    assert.match(sourceRevision, /^[a-f0-9]{40}$/);
    const assets = {};
    for (const name of [
      'before-movies.png',
      'before-series.png',
      'after-movies.png',
      'after-series.png',
      'interactions.webm',
    ]) {
      assets[name] = createHash('sha256')
        .update(await readFile(join(evidence, name)))
        .digest('hex');
    }
    await writeFile(
      join(evidence, 'provenance.json'),
      JSON.stringify(
        {
          schema: 1,
          generatedOnly: true,
          fixtureCount: 1457,
          providersEnabled: false,
          sourceRevision,
          beforeRevision,
          viewport: { width: 1280, height: 900 },
          recording:
            'Silent, untrimmed generated workload; desktop Chromium, not a Shield benchmark',
          ...result,
          assets,
        },
        null,
        2,
      ),
    );
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (diagnostics)
    await diagnostics.save(error, 'Generated full-library workload failed');
  throw error;
} finally {
  if (browser) await browser.close();
  if (beforeVite) await beforeVite.close();
  if (vite) await vite.close();
  if (server && server.exitCode === null) {
    const stopped = new Promise((done) => server.once('exit', done));
    server.kill();
    await stopped;
  }
  assert(run.startsWith(local + sep));
  await rm(run, { recursive: true, force: true });
}
