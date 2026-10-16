// Synthetic request integration only: actual Rust + built React, loopback fake
// Radarr/Sonarr, an empty media root, and isolated disposable application state.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { chromium } from '../clients/web/node_modules/playwright/index.mjs';
import { expect } from '../clients/web/node_modules/@playwright/test/index.mjs';
import { build } from '../clients/web/node_modules/vite/dist/node/index.js';
import { browserDiagnostics } from './browser-diagnostics.mjs';

const root = resolve('.');
const local = join(root, '.local');
await mkdir(local, { recursive: true });
const run = await mkdtemp(join(local, 'requests-smoke-'));
const media = join(run, 'media');
await mkdir(media);
const evidence = join(root, 'ci-artifacts', 'requests');
await mkdir(evidence, { recursive: true });
const sourceBinary = resolve(
  process.env.SHINEMA_REQUESTS_SERVER ??
    join(
      'target',
      'debug',
      `shinema-server${process.platform === 'win32' ? '.exe' : ''}`,
    ),
);
const binary = join(
  run,
  `shinema-server${process.platform === 'win32' ? '.exe' : ''}`,
);
const webRoot = join(root, 'clients', 'web', 'dist');
const token = 'synthetic-request-access-not-a-real-token-0001';
const radarrKey = 'synthetic-radarr-not-a-real-api-key';
const sonarrKey = 'synthetic-sonarr-not-a-real-api-key';
const movieId = 710001;
const existingId = 710002;
const uncertainId = 710003;
const seriesId = 810001;
const providers = [];
const servers = [];
const violations = [];
const pageErrors = [];
const result = {
  methodology:
    'Actual Rust HTTP server and built React on one loopback origin; empty generated media root; isolated private state; fake Radarr/Sonarr with original synthetic titles. No real credentials, external requests, downloads, devices, or media.',
  checks: [],
  screenshots: [],
};
let browser, diagnostics, activeContext;

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded(promise, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${description}`)),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function listen(server) {
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function freePort() {
  const reservation = createServer();
  const origin = await listen(reservation);
  await new Promise((done) => reservation.close(done));
  return new URL(origin).port;
}

function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function fakeProvider(kind, key) {
  const movie = kind === 'movie';
  const idKey = movie ? 'tmdbId' : 'tvdbId';
  const candidates = movie
    ? [
        {
          tmdbId: movieId,
          title: 'Generated Orbit',
          year: 2026,
          overview:
            'An original synthetic story about an orbital garden. Created only to demonstrate request selection.',
        },
        {
          tmdbId: existingId,
          title: 'Generated Horizon',
          year: 2025,
          overview:
            'An original synthetic title already available in the fake provider. No media is downloaded.',
        },
        {
          tmdbId: uncertainId,
          title: 'Generated Echo',
          year: 2026,
          overview:
            'An original synthetic title for ambiguous provider confirmation checks.',
        },
        {
          tmdbId: 710004,
          title: 'Generated Obsolete Orbit',
          year: 2024,
          overview:
            'An original delayed synthetic result used to reject stale searches.',
        },
      ]
    : [
        {
          tvdbId: seriesId,
          title: 'Generated Orbit Chronicles',
          year: 2026,
          seriesType: 'daily',
          overview:
            'An original synthetic series about a community in orbit. The whole series is selected for this demo.',
          seasons: [
            { seasonNumber: 0 },
            { seasonNumber: 1 },
            { seasonNumber: 2 },
          ],
        },
      ];
  const catalog = movie ? [{ ...candidates[1], id: 91, hasFile: true }] : [];
  const state = {
    catalog,
    candidates,
    posts: [],
    calls: [],
    failCatalog: false,
    delayedStarted: deferred(),
    delayedRelease: deferred(),
    delayedCompleted: deferred(),
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      assert.equal(
        request.headers['x-api-key'],
        key,
        'Provider key must stay in the server-to-provider header',
      );
      assert.equal(
        request.headers.authorization,
        undefined,
        'Shinema access token must not reach a provider',
      );
      assert.equal(url.searchParams.has('apikey'), false);
      state.calls.push({ method: request.method, path: url.pathname });
      if (
        !movie &&
        request.method === 'GET' &&
        url.pathname === '/api/v3/system/status'
      )
        return json(response, { appName: 'Sonarr', version: '5.0.0.2635' });
      const path = `/api/${movie ? 'v3' : 'v5'}/${kind}`;
      if (request.method === 'GET' && url.pathname === path) {
        return state.failCatalog
          ? json(
              response,
              { message: 'Synthetic private provider diagnostic' },
              503,
            )
          : json(response, catalog);
      }
      if (request.method === 'GET' && url.pathname === path + '/lookup') {
        if (!movie) assert.equal(url.searchParams.get('language'), '1');
        const term = url.searchParams.get('term') ?? '';
        if (term === 'Generated delayed') {
          state.delayedStarted.resolve();
          await state.delayedRelease.promise;
          json(response, [candidates[3]]);
          state.delayedCompleted.resolve();
          return;
        }
        const prefix = movie ? 'tmdb:' : 'tvdb:';
        const matches = term.startsWith(prefix)
          ? candidates.filter(
              (item) => item[idKey] === Number(term.slice(prefix.length)),
            )
          : candidates.filter((item) =>
              item.title.toLowerCase().includes(term.toLowerCase()),
            );
        return json(response, matches);
      }
      if (request.method === 'POST' && url.pathname === path) {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          assert(body.length <= 8192, 'Unexpected provider payload size');
        }
        const value = JSON.parse(body);
        const candidate = candidates.find(
          (item) => item[idKey] === value[idKey],
        );
        assert(candidate, 'Only original fixture identities may be requested');
        assert.equal(
          value.title,
          candidate.title,
          'Provider lookup is the source of the submitted title',
        );
        assert.equal(value.monitored, true);
        assert.equal(value.qualityProfileId, movie ? 11 : 12);
        assert.equal(
          value.rootFolderPath,
          movie ? '/synthetic/movies' : '/synthetic/series',
        );
        assert.equal(value.apiKey, undefined);
        if (movie) {
          assert.deepEqual(value.addOptions, { searchForMovie: false });
        } else {
          assert.equal(value.seriesType, 'daily');
          assert.deepEqual(value.language, { id: 1, name: 'English' });
          assert.equal(value.seasonType, 'official');
          assert.deepEqual(value.addOptions, {
            searchForMissingEpisodes: false,
            searchForCutoffUnmetEpisodes: false,
          });
          assert.deepEqual(value.seasons, [
            { seasonNumber: 0, monitored: false },
            { seasonNumber: 1, monitored: true },
            { seasonNumber: 2, monitored: true },
          ]);
        }
        state.posts.push(value);
        const created = {
          ...candidate,
          id: 100 + state.posts.length,
          ...(movie
            ? { hasFile: false }
            : { statistics: { episodeCount: 8, episodeFileCount: 0 } }),
        };
        catalog.push(created);
        // Persist the side effect but give an ambiguous acknowledgement. A later
        // submission must never issue a second provider POST for this identity.
        return json(response, value[idKey] === uncertainId ? {} : created, 201);
      }
      throw new Error(
        `Unexpected fake provider route: ${request.method} ${url.pathname}`,
      );
    } catch (error) {
      violations.push(error.message);
      if (!response.headersSent)
        json(response, { message: 'Synthetic mock assertion failed' }, 500);
      else response.end();
    }
  });
  const origin = await listen(server);
  Object.assign(state, { origin, server });
  providers.push(state);
  return state;
}

function isolatedEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^SHINEMA_/i.test(name) &&
        !/^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(name),
    ),
  );
}

async function startServer(label, config = {}, dist = webRoot) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const stateDirectory = join(run, label);
  const processServer = spawn(binary, [], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...isolatedEnvironment(),
      SHINEMA_MEDIA_ROOT: media,
      SHINEMA_STATE_DIR: stateDirectory,
      SHINEMA_WEB_ROOT: dist,
      SHINEMA_BIND: `127.0.0.1:${port}`,
      ...config,
    },
  });
  const server = { process: processServer, origin, log: '', stateDirectory };
  servers.push(server);
  processServer.stderr.on('data', (data) => {
    server.log = (server.log + data).slice(-32000);
  });
  let processError;
  processServer.on('error', (error) => {
    processError = error;
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (processError) throw processError;
    if (processServer.exitCode !== null || processServer.signalCode !== null)
      throw new Error('Synthetic server exited during startup: ' + server.log);
    try {
      if (
        (await fetch(origin + '/health', { signal: AbortSignal.timeout(500) }))
          .ok
      )
        return server;
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('Synthetic server did not become ready');
}

async function stopServer(server) {
  if (
    !server.process.pid ||
    server.process.exitCode !== null ||
    server.process.signalCode !== null
  )
    return;
  const stopped = new Promise((done) => server.process.once('exit', done));
  server.process.kill();
  await stopped;
}

async function api(server, path = '', options = {}) {
  const response = await fetch(server.origin + '/api/requests' + path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const value = await response.json();
  const text = JSON.stringify(value);
  for (const secret of [token, radarrKey, sonarrKey])
    assert.equal(
      text.includes(secret),
      false,
      'A secret must not cross the public API',
    );
  return { status: response.status, value };
}

async function submitApi(server, kind, externalId, extra = {}) {
  return api(server, '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, externalId, ...extra }),
  });
}

async function capture(page, name) {
  await page.screenshot({
    path: join(evidence, `${name}.png`),
    fullPage: true,
    animations: 'disabled',
  });
  result.screenshots.push(`${name}.png`);
}

async function contextFor(server, recording = false) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
    ...(recording
      ? {
          recordVideo: {
            dir: join(run, 'video'),
            size: { width: 1280, height: 888 },
          },
        }
      : {}),
  });
  activeContext = context;
  diagnostics.observe(context);
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === server.origin) return route.continue();
    violations.push(`Browser attempted a non-fixture origin: ${url.origin}`);
    return route.abort();
  });
  context.on('page', (page) =>
    page.on('pageerror', (error) => pageErrors.push(error.message)),
  );
  return context;
}

async function beforeBuild() {
  const revision =
    process.env.SHINEMA_REQUESTS_BEFORE_REVISION ??
    'fdafdc09161a70210f3032b091d30cb8247d8c50';
  assert(
    /^[a-f0-9]{40}$/.test(revision),
    'Before revision must be an exact public commit',
  );
  const before = join(run, 'before');
  const archive = spawnSync(
    'git',
    ['archive', '--format=tar', revision, 'clients/web', 'packages'],
    { cwd: root, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  );
  assert.equal(archive.status, 0, 'Pinned public baseline is unavailable');
  await mkdir(before);
  const extraction = spawnSync('tar', ['-xf', '-', '-C', before], {
    input: archive.stdout,
    windowsHide: true,
  });
  assert.equal(
    extraction.status,
    0,
    'Could not extract the pinned public baseline',
  );
  await symlink(
    join(root, 'clients', 'web', 'node_modules'),
    join(before, 'clients', 'web', 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await build({
    root: join(before, 'clients', 'web'),
    configFile: join(before, 'clients', 'web', 'vite.config.ts'),
    logLevel: 'error',
  });
  result.beforeRevision = revision;
  return join(before, 'clients', 'web', 'dist');
}

async function verifyClientSecrets() {
  const assets = join(webRoot, 'assets');
  for (const name of await readdir(assets)) {
    if (!/\.(js|css)$/.test(name)) continue;
    const text = await readFile(join(assets, name), 'utf8');
    for (const secret of [token, radarrKey, sonarrKey])
      assert.equal(
        text.includes(secret),
        false,
        'Server credentials must not enter the built client',
      );
  }
}

async function search(page, query) {
  await page.getByLabel('Search titles', { exact: true }).fill(query);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
}

try {
  await access(sourceBinary);
  await copyFile(sourceBinary, binary);
  await access(join(webRoot, 'index.html'));
  await verifyClientSecrets();
  const browserChannel =
    process.env.SHINEMA_REQUESTS_BROWSER_CHANNEL ?? 'chromium';
  browser = await chromium.launch({
    headless: true,
    ...(browserChannel ? { channel: browserChannel } : {}),
  });
  result.browser = browser.version();
  result.browserChannel = browserChannel || 'chromium-headless-shell';
  diagnostics = browserDiagnostics(browser, evidence);

  let context, page;
  // Public review capture is opt-in: ordinary CI uses a shallow checkout and
  // still executes every actual request-flow assertion against the built app.
  if (process.env.SHINEMA_REQUESTS_CAPTURE_BEFORE === '1') {
    const baseline = await startServer('before-state', {}, await beforeBuild());
    context = await contextFor(baseline);
    page = await context.newPage();
    await page.goto(baseline.origin);
    await expect(
      page.getByRole('heading', { name: 'Library', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Requests', exact: true }),
    ).toHaveCount(0);
    await capture(page, 'before-no-requests');
    await context.close();
    await stopServer(baseline);
    result.checks.push('Pinned public baseline has no Requests navigation');
  }

  const disabled = await startServer('disabled-state');
  assert.equal((await api(disabled, '/capabilities')).value.enabled, false);
  const disabledResponse = await api(disabled);
  assert.equal(disabledResponse.status, 503);
  assert.equal(disabledResponse.value.error.code, 'disabled');
  context = await contextFor(disabled);
  page = await context.newPage();
  await page.goto(disabled.origin);
  await page.getByRole('button', { name: 'Requests', exact: true }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Requests are not configured yet',
      exact: true,
    }),
  ).toBeVisible();
  await capture(page, 'after-disabled');
  await context.close();
  await stopServer(disabled);
  result.checks.push(
    'Requests disabled by default; UI explains server setup prerequisites',
  );

  const radarr = await fakeProvider('movie', radarrKey);
  const sonarr = await fakeProvider('series', sonarrKey);
  const config = {
    SHINEMA_REQUEST_TOKEN: token,
    SHINEMA_RADARR_URL: radarr.origin,
    SHINEMA_RADARR_API_KEY: radarrKey,
    SHINEMA_RADARR_ROOT_FOLDER: '/synthetic/movies',
    SHINEMA_RADARR_QUALITY_PROFILE_ID: '11',
    SHINEMA_SONARR_URL: sonarr.origin,
    SHINEMA_SONARR_API_KEY: sonarrKey,
    SHINEMA_SONARR_ROOT_FOLDER: '/synthetic/series',
    SHINEMA_SONARR_QUALITY_PROFILE_ID: '12',
  };
  const server = await startServer('enabled-state', config);
  const capabilities = await api(server, '/capabilities', {
    headers: { Authorization: '' },
  });
  assert.equal(capabilities.value.enabled, true);
  assert.deepEqual(capabilities.value.providers, [
    { kind: 'movie', enabled: true },
    { kind: 'series', enabled: true },
  ]);
  for (const headers of [
    { Authorization: '' },
    { Authorization: 'Bearer synthetic-wrong-access-token-000000000' },
  ]) {
    const unauthorized = await api(server, '', { headers });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.value.error.code, 'unauthorized');
  }
  const crossOrigin = await api(server, '', {
    // The global host boundary permits loopback origins. Requests additionally
    // require this exact server origin, even when the other origin is loopback.
    headers: { Origin: 'http://127.0.0.1:1' },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.value.error.code, 'forbidden_origin');
  const invalidSearch = await api(server, '/search?kind=movie&query=x');
  assert.equal(invalidSearch.status, 400);
  assert.equal(invalidSearch.value.error.code, 'invalid_request');
  const invalidSubmission = await submitApi(server, 'movie', movieId, {
    title: 'Untrusted title',
    apiKey: 'client-must-not-configure-providers',
  });
  assert.equal(invalidSubmission.status, 400);
  assert.equal(radarr.calls.length + sonarr.calls.length, 0);
  result.checks.push(
    'Request data requires operator token and same-origin boundary; invalid input never contacts a provider',
  );

  context = await contextFor(server, true);
  page = await context.newPage();
  const video = page.video();
  await page.goto(server.origin);
  await page.getByRole('button', { name: 'Requests', exact: true }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Unlock your request list',
      exact: true,
    }),
  ).toBeVisible();
  await capture(page, 'after-locked');
  const tokenInput = page.getByLabel('Request access token', { exact: true });
  await tokenInput.fill('synthetic-wrong-access-token-000000000');
  await page
    .getByRole('button', { name: 'Unlock requests', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('not accepted');
  await expect(tokenInput).toHaveValue('');
  await tokenInput.fill(token);
  await page
    .getByRole('button', { name: 'Unlock requests', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Find a title', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Search titles', { exact: true }).fill('x');
  // Single-character searches are disabled by the browser surface as well as API.
  await expect(
    page.getByRole('button', { name: 'Search', exact: true }),
  ).toBeDisabled();
  await search(page, 'Generated Orbit');
  await expect(
    page.getByRole('heading', { name: 'Generated Orbit (2026)', exact: true }),
  ).toBeVisible();
  await capture(page, 'after-search');
  await page
    .getByRole('button', { name: 'Review request', exact: true })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  assert.equal(
    radarr.posts.length,
    0,
    'Reviewing a request must have no provider side effect',
  );
  await capture(page, 'after-confirmation');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal(
    radarr.posts.length,
    0,
    'Cancel must have no provider side effect',
  );
  await page
    .getByRole('button', { name: 'Review request', exact: true })
    .first()
    .click();
  await page
    .getByRole('button', { name: 'Confirm request', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText(
    'Generated Orbit was added',
  );
  assert.equal(radarr.posts.length, 1);
  await capture(page, 'after-requested');
  const duplicate = await submitApi(server, 'movie', movieId);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.value.duplicate, true);
  assert.equal(
    radarr.posts.length,
    1,
    'Duplicate requests must not reissue provider POST',
  );
  result.checks.push(
    'Invalid token clears the field; movie selection requires explicit confirmation; cancellation and duplicate submissions have no side effect',
  );

  radarr.catalog.find((item) => item.tmdbId === movieId).hasFile = true;
  await page
    .getByRole('button', { name: 'Refresh statuses', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('statuses refreshed');
  const movieRecord = page
    .locator('.request-records li')
    .filter({ hasText: 'Generated Orbit (2026)' });
  await expect(movieRecord).toContainText('Provider complete');
  await capture(page, 'after-available');
  await search(page, 'Generated Horizon');
  await expect(
    page.getByRole('button', { name: 'Complete at provider', exact: true }),
  ).toBeDisabled();
  const existing = await submitApi(server, 'movie', existingId);
  assert.equal(existing.value.duplicate, true);
  assert.equal(existing.value.item.status, 'available');
  assert.equal(radarr.posts.length, 1);
  result.checks.push(
    'Provider refresh promotes Requested to Available; a title already in Radarr is not added again',
  );

  await page.getByRole('button', { name: 'Series', exact: true }).click();
  await search(page, 'Generated Orbit');
  await expect(
    page.getByRole('heading', {
      name: 'Generated Orbit Chronicles (2026)',
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Review request', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText('series to Sonarr');
  await expect(page.getByRole('dialog')).toContainText(
    'English metadata and Official episode order',
  );
  await page
    .getByRole('button', { name: 'Confirm request', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText(
    'Generated Orbit Chronicles was added',
  );
  assert.equal(sonarr.posts.length, 1);
  await capture(page, 'after-series');
  sonarr.catalog[0].statistics.episodeFileCount = 8;
  await page
    .getByRole('button', { name: 'Refresh statuses', exact: true })
    .click();
  await expect(
    page
      .locator('.request-records li')
      .filter({ hasText: 'Generated Orbit Chronicles (2026)' }),
  ).toContainText('Provider complete');
  await capture(page, 'after-provider-status');
  result.checks.push(
    'Series selection uses Sonarr with explicit season monitoring, no automatic episode search, and completeness refresh',
  );

  await page.getByRole('button', { name: 'Movies', exact: true }).click();
  await search(page, 'Generated delayed');
  await bounded(
    radarr.delayedStarted.promise,
    'delayed fixture lookup started',
  );
  await search(page, 'Generated Horizon');
  await expect(
    page.locator('.requests-results').getByRole('heading', {
      name: 'Generated Horizon (2025)',
      exact: true,
    }),
  ).toBeVisible();
  const oldResponse = page.waitForResponse((response) =>
    response.url().includes('query=Generated%20delayed'),
  );
  radarr.delayedRelease.resolve();
  await bounded(
    radarr.delayedCompleted.promise,
    'delayed fixture lookup completed',
  );
  await (await oldResponse).finished();
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  await expect(
    page.locator('.requests-results').getByRole('heading', {
      name: 'Generated Obsolete Orbit (2024)',
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.locator('.requests-results').getByRole('heading', {
      name: 'Generated Horizon (2025)',
      exact: true,
    }),
  ).toBeVisible();
  result.checks.push(
    'A delayed obsolete search cannot replace newer search results',
  );

  await page
    .getByRole('button', { name: 'Lock requests', exact: true })
    .click();
  await expect(
    page.getByLabel('Request access token', { exact: true }),
  ).toHaveValue('');
  await expect(
    page.getByRole('heading', {
      name: 'Unlock your request list',
      exact: true,
    }),
  ).toBeVisible();
  assert.equal(
    await page.evaluate(
      (secret) =>
        Object.values(localStorage).some((value) => value.includes(secret)) ||
        Object.values(sessionStorage).some((value) => value.includes(secret)),
      token,
    ),
    false,
  );
  await capture(page, 'after-relocked');
  await context.close();
  const recordedPath = await video.path();
  await rename(recordedPath, join(evidence, 'request-flow.webm'));
  result.video = 'request-flow.webm';
  result.checks.push(
    'Lock clears the token field; request access is absent from browser storage',
  );

  const ambiguous = await submitApi(server, 'movie', uncertainId);
  assert.equal(ambiguous.status, 202);
  assert.equal(ambiguous.value.item.status, 'uncertain');
  assert.equal(radarr.posts.length, 2);
  radarr.failCatalog = true;
  const noRetry = await submitApi(server, 'movie', uncertainId);
  assert.equal(noRetry.value.duplicate, true);
  assert.equal(noRetry.value.item.status, 'uncertain');
  const partialRefresh = await api(server);
  assert.equal(partialRefresh.value.refreshIncomplete, true);
  assert.equal(radarr.posts.length, 2);
  radarr.failCatalog = false;
  const recovered = await api(server);
  assert.equal(
    recovered.value.items.find((item) => item.externalId === uncertainId)
      .status,
    'requested',
  );
  await stopServer(server);
  const restarted = await startServer('enabled-state', config);
  const persisted = await submitApi(restarted, 'movie', uncertainId);
  assert.equal(persisted.value.duplicate, true);
  assert.equal(radarr.posts.length, 2);
  result.checks.push(
    'Ambiguous acknowledgement is durable; unavailable refresh is reported; recovery and process restart never resubmit the provider side effect',
  );

  assert.deepEqual(
    await readdir(media),
    [],
    'Request flow must never write or download media',
  );
  for (const processServer of servers) {
    for (const secret of [token, radarrKey, sonarrKey])
      assert.equal(
        processServer.log.includes(secret),
        false,
        'Server logs must not contain credentials',
      );
  }
  assert.deepEqual(violations, []);
  assert.deepEqual(pageErrors, []);
  result.checks.push(
    'All browser/provider traffic stayed on fixture loopback; built client/API/logs omit secrets; media root stayed empty',
  );
  result.providerPosts = {
    radarr: radarr.posts.length,
    sonarr: sonarr.posts.length,
  };
  result.status = 'passed';
  for (const name of await readdir(evidence)) {
    if (name === 'failure.json' || /^failure-\d+\.png$/.test(name))
      await rm(join(evidence, name), { force: true });
  }
  await writeFile(
    join(evidence, 'result.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await diagnostics?.save(
    error,
    servers.map((server) => server.log).join('\n'),
  );
  throw error;
} finally {
  for (const provider of providers) provider.delayedRelease.resolve();
  await activeContext?.close().catch(() => {});
  await browser?.close();
  for (const server of servers) await stopServer(server);
  for (const provider of providers) {
    provider.server.closeAllConnections();
    await new Promise((done) => provider.server.close(done));
  }
  assert(
    run.startsWith(local + sep) && dirname(run) === local,
    'Cleanup must stay inside the ignored test directory',
  );
  await rm(run, { recursive: true, force: true });
}
