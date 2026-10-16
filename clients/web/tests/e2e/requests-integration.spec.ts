import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { defaultLibraries } from '../../../../packages/contracts/index.ts';
import { archiveTheme } from '../../../../packages/design-tokens/theme.ts';
import { startupCatalog } from './cold-start-fixtures.ts';
import {
  installStartupProbe,
  startupProblems,
  startupShellAnchors,
  startupTrace,
} from './cold-start-probe.ts';

function latch() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}

for (const skin of ['marquee', 'archive'] as const)
  for (const viewport of [
    { width: 1600, height: 900 },
    { width: 390, height: 844 },
  ])
    test(`${skin} ${viewport.width}: Requests owns its first-paint slot and survives failed discovery`, async ({
      page,
      baseURL,
    }, info) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await installStartupProbe(page, {
        saved:
          skin === 'archive'
            ? {
                'shinema.appearance.v1': JSON.stringify({
                  version: 1,
                  theme: archiveTheme,
                  motion: 'system',
                }),
              }
            : undefined,
        requiredAnchors: [...startupShellAnchors, 'navLibrary', 'navRequests'],
      });
      const discovery = latch();
      const catalogue = latch();
      const calls = { discovery: 0, discoveryFailed: false, requests: 0 };
      const blocked: string[] = [];
      const catalog = startupCatalog({ artwork: false });
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(baseURL!).origin) {
          blocked.push(url.origin);
          return route.abort();
        }
        if (!url.pathname.startsWith('/api/')) return route.continue();
        if (url.pathname === '/api/libraries') {
          calls.discovery++;
          await discovery.pending;
          await route.fulfill({
            status: 503,
            json: { error: 'Synthetic discovery failure' },
          });
          calls.discoveryFailed = true;
          return;
        }
        if (url.pathname === '/api/content-registry') {
          await discovery.pending;
          return route.fulfill({ json: defaultLibraries().registry });
        }
        if (url.pathname === '/api/library')
          return route.fulfill({
            json: { movies: 60, tv: 0, series: 0, total: 60 },
          });
        if (url.pathname === '/api/catalog') {
          await catalogue.pending;
          return route.fulfill({ json: catalog });
        }
        if (url.pathname === '/api/requests/capabilities') {
          calls.requests++;
          return route.fulfill({
            json: {
              apiVersion: 1,
              enabled: false,
              authentication: 'bearer',
              providers: [
                { kind: 'movie', enabled: false },
                { kind: 'series', enabled: false },
              ],
            },
          });
        }
        throw new Error(`Unexpected generated request: ${url.pathname}`);
      });
      try {
        await page.goto('/');
        const requests = page.locator('[data-requests-slot]');
        await expect(requests).toBeAttached();
        await expect(requests).toBeEnabled();
        await expect.poll(() => calls.discovery).toBeGreaterThan(0);
        // Keep the real pending shell across multiple paints. Do not reset the
        // pre-document history when discovery or the catalogue is released.
        await page.evaluate(async () => {
          for (let frame = 0; frame < 8; frame++)
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            );
        });
        await expect(page.locator('.app')).toHaveAttribute(
          'data-route',
          'library',
        );
        expect(calls.requests).toBe(0);
        const startup = await startupTrace(page);
        const problems = startupProblems(startup);
        await writeFile(
          info.outputPath('requests-whole-startup.json'),
          JSON.stringify({ ...startup, problems, calls }, null, 2),
        );
        expect(startup.initialStorage).toBe(0);
        expect(startup.firstContentfulPaint).not.toBeNull();
        expect(startup.samples[0].time).toBeLessThanOrEqual(
          startup.firstContentfulPaint!,
        );
        expect(problems.slice(0, 40)).toEqual([]);
        expect(
          startup.shifts.reduce((sum, shift) => sum + shift.value, 0),
        ).toBe(0);
        const painted = startup.samples.filter((sample) => sample.meaningful);
        expect(painted.length).toBeGreaterThan(8);
        expect(
          new Set(painted.map((sample) => sample.anchors.navRequests.id)).size,
        ).toBe(1);
        // Exercise the actual button handler while discovery is still pending.
        // Calling click on the button avoids deliberately scrolling the strip;
        // header coordinates remain comparable through both route transitions.
        await requests.evaluate((node: HTMLButtonElement) => node.click());
        await expect(
          page.getByRole('heading', { name: 'Requests', exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole('heading', {
            name: 'Requests are not configured yet',
          }),
        ).toBeVisible();
        expect(calls.requests).toBeGreaterThan(0);
        discovery.release();
        catalogue.release();
        await expect.poll(() => calls.discoveryFailed).toBe(true);
        await page.getByRole('button', { name: 'Back to library' }).click();
        await expect(page.locator('.app')).toHaveAttribute(
          'data-route',
          'library',
        );
        await expect(requests).toBeEnabled();
        await requests.evaluate((node: HTMLButtonElement) => node.click());
        await expect(
          page.getByRole('heading', { name: 'Requests', exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole('heading', {
            name: 'Requests are not configured yet',
          }),
        ).toBeVisible();
        const complete = await startupTrace(page);
        await writeFile(
          info.outputPath('requests-whole-routes.json'),
          JSON.stringify({ ...complete, calls }, null, 2),
        );
        expect(complete.truncated).toBe(false);
        const first = complete.samples.findIndex((sample) => sample.meaningful);
        expect(first).toBeGreaterThanOrEqual(0);
        // All pre-document history stays intact, including intentional main
        // route replacements. Header and Requests retain identity and geometry.
        for (const sample of complete.samples.slice(first)) {
          for (const name of [
            'header',
            'navigation',
            'navigationSettings',
            'navRequests',
          ]) {
            expect(sample.anchors[name]?.id).toBe(
              complete.samples[first].anchors[name].id,
            );
            expect(sample.anchors[name]?.rect).toEqual(
              complete.samples[first].anchors[name].rect,
            );
          }
        }
        expect(blocked).toEqual([]);
      } finally {
        discovery.release();
        catalogue.release();
      }
    });
