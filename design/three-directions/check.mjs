import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '../../clients/web/node_modules/playwright/index.mjs';
import { startServer } from './serve.mjs';

const output = resolve('.local/design-evidence');
await mkdir(output, { recursive: true });
const server = startServer(0);
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const failures = [];
const results = [];
const options = ['marquee', 'archive', 'signal'];
const views = ['home', 'library', 'detail', 'series', 'player'];
async function screenshot(page, name) {
  await page.screenshot({
    path: resolve(output, `${name}.png`),
    animations: 'disabled',
  });
}
async function load(page, option, view = 'home', state = 'ready') {
  await page.goto(
    `${base}/screen.html?${new URLSearchParams({ option, view, state })}`,
  );
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    () =>
      document.activeElement !== document.body ||
      !!document.querySelector('[aria-busy="true"]'),
  );
}
try {
  for (const option of options) {
    for (const [device, viewport] of [
      ['tv', { width: 1600, height: 900 }],
      ['phone', { width: 390, height: 844 }],
    ]) {
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
      page.on('pageerror', (error) =>
        failures.push(`${option}/${device}: ${error.message}`),
      );
      page.on('response', (response) => {
        if (response.status() >= 400 && !response.url().endsWith('favicon.ico'))
          failures.push(`${response.status()} ${response.url()}`);
      });
      for (const view of views) {
        await load(page, option, view);
        const geometry = await page.evaluate(() => ({
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        }));
        assert.ok(
          geometry.scrollWidth <= viewport.width,
          `${option}/${device}/${view} horizontal overflow: ${JSON.stringify(geometry)}`,
        );
        if (device === 'tv')
          assert.ok(
            geometry.height <= 900,
            `${option}/${view} exceeds TV viewport: ${geometry.height}`,
          );
        assert.ok(await page.locator('h1,h2').count());
        await screenshot(page, `${option}-${device}-${view}`);
        results.push({ option, device, view, ...geometry });
      }
      for (const state of ['empty', 'loading']) {
        await load(page, option, 'home', state);
        await screenshot(page, `${option}-${device}-${state}`);
        if (state === 'empty') {
          await page
            .getByRole('button', { name: 'Explore the demo collection' })
            .click();
          assert.equal(await page.locator('.state-ready').count(), 1);
        } else
          assert.equal(await page.locator('[aria-busy="true"]').count(), 1);
      }
      await load(page, option, 'library');
      const title = page.getByRole('button', { name: 'Red Horizon, 2025' });
      await title.focus();
      await page.keyboard.press('Enter');
      assert.equal(
        await page.locator('.detail-copy h1').innerText(),
        'Red Horizon',
      );
      await page.keyboard.press('Escape');
      assert.equal(
        await page.locator(':focus').getAttribute('data-focus'),
        'film-3',
      );
      await load(page, option, 'detail');
      if (option === 'signal')
        assert.equal(
          await page
            .getByRole('button', { name: 'Episodes', exact: true })
            .count(),
          0,
        );
      await page
        .getByRole('button', { name: 'My list', exact: true })
        .last()
        .click();
      assert.equal(
        await page
          .getByRole('button', { name: 'In my list', exact: true })
          .count(),
        1,
      );
      await page.getByRole('button', { name: 'Search library' }).click();
      await page.getByRole('searchbox').fill('Evergreen');
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('.library-posters .poster').count(), 1);
      await load(page, option, 'player');
      await page.getByRole('slider').focus();
      await page.keyboard.press('ArrowDown');
      assert.equal(
        await page.locator(':focus').getAttribute('data-action'),
        'toggle',
      );
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.getByRole('slider').inputValue(), '2470');
      await page.keyboard.press('Space');
      await page.waitForFunction(
        () => document.activeElement?.dataset.action === 'toggle',
      );
      assert.equal(
        await page.getByRole('button', { name: 'Pause', exact: true }).count(),
        1,
      );
      await page.keyboard.press('ArrowDown');
      assert.equal(
        await page.locator(':focus').getAttribute('data-action'),
        'captions',
      );
      await page.keyboard.press('Enter');
      await screenshot(page, `${option}-${device}-subtitles`);
      const dialog = page.getByRole('dialog', { name: 'Subtitle options' });
      await dialog
        .getByRole('button', { name: 'English CC', exact: true })
        .click();
      await page.getByRole('button', { name: 'Subtitle options' }).click();
      assert.equal(
        await dialog
          .getByRole('button', { name: 'English CC', exact: true })
          .getAttribute('aria-pressed'),
        'true',
      );
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.view-detail').count(), 1);
      await load(page, option, 'library');
      await page
        .getByRole('button', { name: 'Shows', exact: true })
        .last()
        .click();
      assert.equal(
        await page.locator('.library-heading h1 > span').innerText(),
        '02',
      );
      await load(page, option, 'series');
      await page.locator('[data-action="episode-0"]').click();
      assert.match(
        await page.locator('.player-title-row .eyebrow').innerText(),
        /E1/,
      );
      await page.getByRole('button', { name: 'Playback settings' }).click();
      await page.getByRole('button', { name: '1080p · Compatible' }).click();
      await page.getByRole('button', { name: 'Playback settings' }).click();
      assert.equal(
        await page
          .getByRole('button', { name: '1080p · Compatible' })
          .getAttribute('aria-pressed'),
        'true',
      );
      await page.close();
    }
  }
  const comparison = await browser.newPage({
    viewport: { width: 1600, height: 1300 },
    reducedMotion: 'reduce',
  });
  await comparison.goto(base);
  for (const option of options) {
    await comparison.locator(`[data-option="${option}"]`).click();
    assert.equal(
      await comparison
        .locator(`[data-option="${option}"]`)
        .getAttribute('aria-pressed'),
      'true',
    );
  }
  await comparison.locator('[data-option="marquee"]').click();
  await comparison.waitForTimeout(150);
  await screenshot(comparison, 'interactive-comparison');
  await comparison.close();
  assert.deepEqual(failures, []);
  const data = async (name) =>
    `data:image/png;base64,${(await readFile(resolve(output, `${name}.png`))).toString('base64')}`;
  const board = await browser.newPage({
    viewport: { width: 1800, height: 1740 },
    reducedMotion: 'reduce',
  });
  const descriptions = {
    marquee: [
      '01',
      'Marquee',
      'Immersive artwork. A quieter cinema at home.',
      'Best for discovery · Fewer titles visible at once',
    ],
    archive: [
      '02',
      'Archive',
      'A considered catalogue for collectors.',
      'Best for a large owned collection · Brighter, less theatrical',
    ],
    signal: [
      '03',
      'Signal',
      'A direct path from finding to watching.',
      'Best for remote speed · An unfamiliar split browser',
    ],
  };
  for (const option of options) {
    const [number, name, subtitle, tradeoff] = descriptions[option];
    const image = async (suffix, label, klass = '') =>
      `<figure class="${klass}"><figcaption>${label}</figcaption><img src="${await data(`${option}-${suffix}`)}"/></figure>`;
    const html = `<html><head><style>*{box-sizing:border-box}body{margin:0;padding:44px 50px;background:#171b18;color:#f0eee5;font-family:Arial,sans-serif}header{display:flex;align-items:end;justify-content:space-between;padding-bottom:27px;border-bottom:1px solid #ffffff25;margin-bottom:22px}.number{font:12px monospace;color:#a3ad9d;letter-spacing:2px}h1{font-size:47px;font-weight:400;letter-spacing:-1.8px;margin:7px 0}header p{margin:0;color:#b4bcae;font-size:17px}.tradeoff{font-size:12px;color:#c3c9bc;text-align:right}figure{margin:0}figcaption{font:10px Arial,sans-serif;letter-spacing:1.7px;color:#aab4a2;margin-bottom:10px}img{display:block;width:100%;box-shadow:0 8px 24px #0005}.tv{display:grid;grid-template-columns:1fr 1fr;gap:23px;margin-top:18px}.phones{display:grid;grid-template-columns:repeat(4,1fr) 1.6fr;gap:26px;margin-top:29px}.phones figure>img{width:100%;height:auto}.states{display:flex;flex-direction:column;gap:23px}.states img{box-shadow:none}.footer{margin-top:27px;border-top:1px solid #ffffff25;padding-top:17px;display:flex;justify-content:space-between;color:#94a08c;font:10px Arial,sans-serif;letter-spacing:.5px}</style></head><body><header><div><div class="number">SHINEMA / DIRECTION ${number}</div><h1>${name}</h1><p>${subtitle}</p></div><div class="tradeoff">${tradeoff}<br><br>TV + PHONE / INTERACTIVE DESIGN STUDY</div></header><div class="tv">${await image('tv-home', 'TV / HOME — VISIBLE REMOTE FOCUS')}${await image('tv-detail', 'TV / FILM DETAIL')}${await image('tv-series', 'TV / SHOW DETAIL')}${await image('tv-player', 'TV / PLAYER CONTROLS')}</div><div class="phones">${await image('phone-home', 'PHONE / HOME')}${await image('phone-detail', 'PHONE / FILM')}${await image('phone-series', 'PHONE / SHOW')}${await image('phone-player', 'PHONE / PLAYER')}<div class="states">${await image('tv-empty', 'EMPTY LIBRARY')}${await image('tv-loading', 'LOADING')}${await image('tv-subtitles', 'SUBTITLE SELECTION')}</div></div><div class="footer"><span>Fictional collection · Original generated artwork · Simulated playback · No final direction selected</span><span>Chromium render / no hardware validation</span></div></body></html>`;
    await board.setContent(html);
    await board.evaluate(() =>
      Promise.all([...document.images].map((img) => img.decode())),
    );
    await board.screenshot({
      path: resolve(output, `${option}-board.png`),
      fullPage: true,
    });
  }
  await board.close();
  await writeFile(
    resolve(output, 'verification.json'),
    JSON.stringify(
      {
        result: 'passed',
        screenshots: 52,
        screenMatrix: results,
        assertions:
          '30 layouts, 12 empty/loading states, focus restoration, search, list toggle, player seek/toggle, subtitle selection, back navigation, comparison switching, no page errors or horizontal overflow',
        fixtureOnly: true,
        hardwareValidated: false,
      },
      null,
      2,
    ),
  );
  console.log(
    `Design check passed: ${results.length} screen layouts, all interactions and state checks. Evidence: .local/design-evidence`,
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
