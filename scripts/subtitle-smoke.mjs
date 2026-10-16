// Original synthetic fixtures, loopback only. No device or library media.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  chromium,
  expect,
} from '../clients/web/node_modules/@playwright/test/index.mjs';
import { createServer } from '../clients/web/node_modules/vite/dist/node/index.js';

const root = resolve('.');
await mkdir(join(root, '.local'), { recursive: true });
const run = await mkdtemp(join(root, '.local', 'subtitles-'));
const media = join(run, 'media');
const evidence = join(root, '.local', 'subtitle-evidence');
await mkdir(media);
await mkdir(evidence, { recursive: true });
const english =
  '1\n00:00:01,000 --> 00:00:06,000\nEnglish: first cue\n\n2\n00:00:10,000 --> 00:00:15,000\nEnglish: after seek and resume\n\n3\n00:00:18,000 --> 00:00:23,000\nEnglish: final cue\n';
await writeFile(join(run, 'english.srt'), english);
await writeFile(
  join(run, 'styled.ass'),
  '[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Styled unsupported\n',
);
const generate = (args) => {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', ...args],
    { windowsHide: true, stdio: 'inherit' },
  );
  if (result.error || result.status !== 0)
    throw new Error('Synthetic subtitle fixture generation failed');
};
generate([
  '-f',
  'lavfi',
  '-i',
  'color=c=0x163746:size=640x360:rate=24',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000',
  '-i',
  join(run, 'english.srt'),
  '-i',
  join(run, 'styled.ass'),
  '-t',
  '24',
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-map',
  '2:s',
  '-map',
  '3:s',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-c:s:0',
  'srt',
  '-c:s:1',
  'ass',
  '-metadata:s:s:0',
  'language=eng',
  '-metadata:s:s:0',
  'title=English',
  '-disposition:s:0',
  'default',
  '-disposition:s:1',
  '0',
  join(media, 'Generated_Subtitle.mkv'),
]);
generate([
  '-i',
  join(media, 'Generated_Subtitle.mkv'),
  '-map',
  '0:v',
  '-map',
  '0:a',
  '-map',
  '0:s:0',
  '-c:v',
  'copy',
  '-c:a',
  'copy',
  '-c:s',
  'mov_text',
  '-movflags',
  '+faststart',
  join(media, 'Generated_Direct.mp4'),
]);
const spanish =
  'WEBVTT\n\n00:00:01.000 --> 00:00:06.000\nEspañol: primera señal\n\n00:00:10.000 --> 00:00:15.000\nEspañol: después del salto\n';
for (const name of ['Generated_Subtitle', 'Generated_Direct'])
  await writeFile(join(media, name + '.es.vtt'), spanish);

const api = 'http://127.0.0.1:29887';
process.env.SHINEMA_API_ORIGIN = api;
process.env.VITE_DEMO_MODE = 'true';
const server = spawn(
  join(
    root,
    'target',
    'debug',
    'shinema-server' + (process.platform === 'win32' ? '.exe' : ''),
  ),
  [],
  {
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith('SHINEMA_'),
        ),
      ),
      SHINEMA_MEDIA_ROOT: media,
      SHINEMA_STATE_DIR: join(run, 'state'),
      SHINEMA_BIND: '127.0.0.1:29887',
    },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  },
);
let serverError = '';
server.stderr.on('data', (chunk) => {
  serverError += chunk;
});
let vite, browser;
const checks = [];
try {
  let ready = false;
  for (let n = 0; n < 100; n++) {
    if (server.exitCode !== null)
      throw new Error('Synthetic server exited: ' + serverError);
    try {
      if ((await fetch(api + '/health')).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ready);
  const catalog = await (await fetch(api + '/api/catalog')).json();
  vite = await createServer({
    root: join(root, 'clients/web'),
    configFile: join(root, 'clients/web/vite.config.ts'),
    server: { host: '127.0.0.1', port: 29883, strictPort: true },
  });
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    args: ['--mute-audio'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1080 },
    locale: 'en-US',
    reducedMotion: 'reduce',
  });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === 'http://127.0.0.1:29883'
      ? route.continue()
      : route.abort(),
  );
  const page = await context.newPage();
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.addInitScript(() => {
    window.__videoLoads = 0;
    document.addEventListener(
      'loadstart',
      (event) => {
        if (event.target instanceof HTMLVideoElement) window.__videoLoads++;
      },
      true,
    );
  });
  const video = page.locator('video');
  const subtitles = page.getByRole('combobox', {
    name: 'Subtitles',
    exact: true,
  });
  const cue = () =>
    video.evaluate((node) =>
      [...node.textTracks]
        .filter((track) => track.mode === 'showing')
        .flatMap((track) =>
          [...(track.activeCues ?? [])].map((cue) => cue.text),
        )
        .join('\n'),
    );
  const seek = async (seconds) => {
    await video.evaluate((node, time) => {
      node.pause();
      node.currentTime = time;
    }, seconds);
    await expect
      .poll(() => video.evaluate((node) => node.currentTime))
      .toBeCloseTo(seconds, 0);
  };
  for (const name of ['Subtitle', 'Direct']) {
    const item = catalog.items.find(
      (item) => item.title === `Generated ${name}`,
    );
    assert(item);
    const info = await (
      await fetch(`${api}/api/media/${item.id}/subtitles`)
    ).json();
    const en = info.tracks.find(
      (track) => track.source === 'embedded' && track.contentPath,
    );
    const es = info.tracks.find(
      (track) => track.source === 'external' && track.language === 'es',
    );
    assert(en && es);
    if (name === 'Subtitle')
      assert(
        info.tracks.some(
          (track) => track.unsupportedReason && !track.contentPath,
        ),
      );
    const content = await (await fetch(api + en.contentPath)).text();
    assert(content.startsWith('WEBVTT\n'));
    // AAC encoder priming changes the container origin slightly across FFmpeg
    // versions. Require the original media-time cue, with no seek/segment offset;
    // the codec test separately checks exact millisecond timestamps without AAC.
    const middleCue =
      /00:00:(\d{2}\.\d{3}) --> 00:00:(\d{2}\.\d{3})\nEnglish: after seek and resume/.exec(
        content,
      );
    assert(middleCue);
    assert(Math.abs(Number(middleCue[1]) - 10) < 0.1);
    assert(Math.abs(Number(middleCue[2]) - 15) < 0.1);
    await page.goto('http://127.0.0.1:29883');
    await page
      .getByRole('button', { name: `Open ${name}`, exact: true })
      .click();
    await page.getByRole('button', { name: /^(▶ Play|▶ Resume)$/ }).click();
    await expect(video).toBeVisible();
    await expect(subtitles.locator(`option[value="${en.id}"]`)).toHaveCount(1, {
      timeout: 60000,
    });
    await expect(subtitles).toHaveValue('automatic');
    await expect
      .poll(() => video.evaluate((node) => Number.isFinite(node.duration)), {
        timeout: 60000,
      })
      .toBe(true);
    await seek(3);
    await expect.poll(cue, { timeout: 60000 }).toContain('English: first cue');
    await seek(12);
    await expect
      .poll(cue, { timeout: 60000 })
      .toContain('English: after seek and resume');
    await seek(20);
    await expect.poll(cue, { timeout: 60000 }).toContain('English: final cue');
    await seek(12);
    const loads = await page.evaluate(() => window.__videoLoads);
    await subtitles.selectOption(es.id);
    await expect
      .poll(cue, { timeout: 60000 })
      .toContain('Español: después del salto');
    assert.equal(await video.evaluate((node) => node.currentTime), 12);
    assert.equal(await page.evaluate(() => window.__videoLoads), loads);
    if (name === 'Direct') {
      await page.route('**' + en.contentPath, (route) =>
        route.fulfill({ status: 503, body: 'unavailable' }),
      );
      await subtitles.selectOption(en.id);
      await expect(
        page.getByText(
          'This subtitle track could not be loaded. Choose another track or retry.',
        ),
      ).toBeVisible();
      await subtitles.selectOption(es.id);
      await expect
        .poll(cue, { timeout: 60000 })
        .toContain('Español: después del salto');
      await page.unroute('**' + en.contentPath);
      await page.route('**' + es.contentPath, (route) =>
        route.fulfill({ status: 503, body: 'unavailable' }),
      );
      await subtitles.selectOption(en.id);
      await expect
        .poll(cue, { timeout: 60000 })
        .toContain('English: after seek and resume');
      await subtitles.selectOption(es.id);
      await expect(
        page.getByText(
          'This subtitle track could not be loaded. Choose another track or retry.',
        ),
      ).toBeVisible();
      await page.unroute('**' + es.contentPath);
      await page.getByRole('button', { name: 'Retry subtitles' }).click();
      await expect
        .poll(cue, { timeout: 60000 })
        .toContain('Español: después del salto');
      assert.equal(await page.evaluate(() => window.__videoLoads), loads);
      checks.push(
        'content failure permits changing track and retry without video reload',
      );
    }
    await page.screenshot({
      path: join(evidence, `subtitles-${name.toLowerCase()}.png`),
      fullPage: true,
    });
    await subtitles.selectOption('');
    await expect.poll(cue, { timeout: 60000 }).toBe('');
    await expect
      .poll(() =>
        video.evaluate((node) =>
          [...node.textTracks].every((track) => track.mode === 'disabled'),
        ),
      )
      .toBe(true);
    await subtitles.selectOption(en.id);
    await seek(3);
    await expect.poll(cue, { timeout: 60000 }).toContain('English: first cue');
    await seek(12);
    await page.getByRole('button', { name: 'Back to details' }).click();
    await page.getByRole('button', { name: '▶ Resume', exact: true }).click();
    // Pause as soon as resume restores the media clock. Waiting for discovery
    // first lets slow codec work advance playback beyond this cue's end.
    await expect
      .poll(() => video.evaluate((node) => node.currentTime), {
        timeout: 60000,
      })
      .toBeGreaterThanOrEqual(11);
    const resumedAt = await video.evaluate((node) => {
      node.pause();
      return node.currentTime;
    });
    assert(resumedAt < 15);
    await expect(subtitles.locator(`option[value="${en.id}"]`)).toHaveCount(1, {
      timeout: 60000,
    });
    await expect(subtitles).toHaveValue(en.id);
    await expect
      .poll(cue, { timeout: 60000 })
      .toContain('English: after seek and resume');
    checks.push(
      `${name}: default, embedded/external, absolute forward/backward seek, Off, no reload on selection, resume`,
    );
    // An interrupted track request must not re-enable captions after Off.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let settled;
    const settlement = new Promise((resolve) => {
      settled = resolve;
    });
    let entered = false;
    await page.route('**' + es.contentPath, async (route) => {
      entered = true;
      await gate;
      await route
        .fulfill({ status: 200, contentType: 'text/vtt', body: spanish })
        .catch(() => {});
      settled();
    });
    await subtitles.selectOption(es.id);
    await expect.poll(() => entered).toBe(true);
    await subtitles.selectOption('');
    release();
    await settlement;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect.poll(cue, { timeout: 60000 }).toBe('');
    assert(
      await video.evaluate((node) =>
        [...node.textTracks].every((track) => track.mode === 'disabled'),
      ),
    );
    assert.equal(
      (await video.evaluate((node) => node.currentTime)) >= 11,
      true,
    );
    await page.unroute('**' + es.contentPath);
    checks.push(`${name}: interrupted content response cannot override Off`);
    await page.getByRole('button', { name: 'Back to details' }).click();
    await page.getByRole('button', { name: '▶ Resume', exact: true }).click();
    await expect(subtitles).toHaveValue('');
    await expect(subtitles.locator(`option[value="${en.id}"]`)).toHaveCount(1, {
      timeout: 60000,
    });
    assert(
      await video.evaluate((node) =>
        [...node.textTracks].every((track) => track.mode === 'disabled'),
      ),
    );
    await subtitles.selectOption('automatic');
    await seek(12);
    await expect
      .poll(cue, { timeout: 60000 })
      .toContain('English: after seek and resume');
    checks.push(`${name}: explicit Off survives Back and Resume`);
  }
  await page.getByRole('button', { name: 'Back to details' }).click();
  await page.route('**/subtitles', (route) =>
    route.fulfill({ status: 503, body: 'unavailable' }),
  );
  await page.getByRole('button', { name: '▶ Resume', exact: true }).click();
  await expect(
    page.getByText('Subtitles could not be loaded. Playback can continue.'),
  ).toBeVisible();
  await expect(video).toBeVisible();
  await page.unroute('**/subtitles');
  await page.getByRole('button', { name: 'Retry subtitles' }).click();
  await expect(
    page.getByText('Subtitles could not be loaded. Playback can continue.'),
  ).toHaveCount(0);
  await seek(12);
  await expect
    .poll(cue, { timeout: 60000 })
    .toContain('English: after seek and resume');
  checks.push(
    'discovery failure leaves playback usable; retry recovers subtitles',
  );
  // Off while discovery is pending must stay Off even when a default arrives.
  await page.getByRole('button', { name: 'Back to details' }).click();
  const direct = catalog.items.find(
    (item) => item.title === 'Generated Direct',
  );
  const actual = await (
    await fetch(`${api}/api/media/${direct.id}/subtitles`)
  ).json();
  let releaseDiscovery;
  const discoveryGate = new Promise((resolve) => {
    releaseDiscovery = resolve;
  });
  let discoveryStarted = false;
  await page.route('**/subtitles', async (route) => {
    discoveryStarted = true;
    await discoveryGate;
    await route
      .fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(actual),
      })
      .catch(() => {});
  });
  await page.getByRole('button', { name: '▶ Resume', exact: true }).click();
  await expect.poll(() => discoveryStarted).toBe(true);
  await subtitles.selectOption('');
  releaseDiscovery();
  await expect(
    subtitles.locator(`option[value="${actual.tracks[0].id}"]`),
  ).toHaveCount(1);
  await expect(page.getByText('Finding subtitle tracks.')).toHaveCount(0);
  await page.unroute('**/subtitles');
  await expect(subtitles).toHaveValue('');
  await expect.poll(cue, { timeout: 60000 }).toBe('');
  checks.push('explicit Off during initial discovery remains Off');
  await page.getByRole('button', { name: 'Back to details' }).click();
  let releaseFinal;
  const finalGate = new Promise((resolve) => {
    releaseFinal = resolve;
  });
  let finalSettled;
  const finalSettlement = new Promise((resolve) => {
    finalSettled = resolve;
  });
  discoveryStarted = false;
  await page.route('**/subtitles', async (route) => {
    discoveryStarted = true;
    await finalGate;
    await route
      .fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(actual),
      })
      .catch(() => {});
    finalSettled();
  });
  await page.getByRole('button', { name: '▶ Resume', exact: true }).click();
  await expect.poll(() => discoveryStarted).toBe(true);
  await page.getByRole('button', { name: 'Back to details' }).click();
  releaseFinal();
  await finalSettlement;
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Direct');
  await expect(video).toHaveCount(0);
  assert.deepEqual(failures, []);
  checks.push('leaving during discovery discards completion');
  await writeFile(
    join(evidence, 'checks.json'),
    JSON.stringify(
      {
        browser: browser.version(),
        fixtures:
          'Original FFmpeg color/sine + authored multilingual text; host loopback only.',
        checks,
      },
      null,
      2,
    ),
  );
  console.log(checks.join('\n'));
  console.log('Synthetic subtitle screenshots: .local/subtitle-evidence');
} finally {
  await browser?.close();
  await vite?.close();
  if (server.exitCode === null) {
    const stopped = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await stopped;
  }
}
