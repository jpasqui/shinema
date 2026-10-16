import type { Page, TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { defaultLibraries } from '../../../../packages/contracts/index.ts';
import type { Libraries } from '../../../../packages/contracts/libraries.ts';
import { archiveTheme } from '../../../../packages/design-tokens/theme.ts';
import { test, expect, mediaFor } from './fixtures.ts';
import { startupCatalog } from './cold-start-fixtures.ts';
import { browsePath, initialBrowse, rememberPage } from '../../src/browse.ts';
import {
  installStartupProbe,
  startupProblems,
  startupTrace,
  startupShellAnchors,
} from './cold-start-probe.ts';

function latch() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}

async function startupCheckpoint(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            window.__shinemaStartup.capture();
            resolve();
          }),
        ),
      ),
  );
}

async function coldStartup(
  page: Page,
  info: TestInfo,
  options: {
    libraries?: Libraries;
    saved?: Record<string, string>;
    width?: number;
    height?: number;
    historical?: boolean;
    reduced?: boolean;
    noStorage?: boolean;
    font?: boolean;
    descriptorFailure?: boolean;
    removedPendingCollectionPositions?: number[];
    cachedFeed?: boolean;
    beforeDescriptors?: (page: Page) => Promise<void>;
    retryDiscovery?: boolean;
    expectedInitialSlots?: 3;
    catalog?: ReturnType<typeof startupCatalog>;
  } = {},
) {
  await page.setViewportSize({
    width: options.width ?? 1280,
    height: options.height ?? 900,
  });
  await page.emulateMedia({
    reducedMotion: options.reduced ? 'reduce' : 'no-preference',
  });
  await installStartupProbe(page, {
    saved: options.saved,
    noStorage: options.noStorage,
    requiredAnchors: [
      ...startupShellAnchors,
      ...(options.saved?.['shinema.web.top-navigation.v1']
        ? ['navigationSlotCustom', 'navigationSlotSearch', 'navSearch']
        : ['navLibrary']),
    ],
  });
  const entry = latch();
  const descriptors = latch();
  const catalog = latch();
  const summary = latch();
  const artwork = latch();
  const calls = {
    entry: 0,
    descriptors: 0,
    catalog: 0,
    summary: 0,
    artwork: 0,
  };
  const phases = {
    start: Date.now(),
    entryReleased: 0,
    descriptorsReleased: 0,
    complete: 0,
    descriptors: [] as Array<{
      received: number;
      released: number;
      fulfilled: number;
      status: number;
    }>,
    summary: [] as Array<{
      started: number | null;
      received: number;
      released: number;
      fulfilled: number;
      status: number;
    }>,
  };
  let completed = false;
  // Routed mocks have no network startTime; record the actual request event
  // separately from entering and releasing the response gate.
  const summaryStarts = new WeakMap<object, number>();
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/library')
      summaryStarts.set(request, Date.now());
  });
  const catalogDocument = options.catalog ?? startupCatalog();
  const hasArtwork = catalogDocument.items.some(
    (item) => item.posterPath || item.backdropPath,
  );
  const descriptorDocument = options.libraries ?? {
    ...defaultLibraries(),
    revision: 7,
  };
  let discoveryRetryReleased = false;
  await page.route(/\/src\/main\.tsx(?:\?.*)?$/, async (route) => {
    calls.entry++;
    await entry.pending;
    await route.continue();
  });
  await page.route('**/api/libraries', async (route) => {
    calls.descriptors++;
    const phase = {
      received: Date.now(),
      released: 0,
      fulfilled: 0,
      status: 0,
    };
    phases.descriptors.push(phase);
    await descriptors.pending;
    phase.released = Date.now();
    const failed =
      options.descriptorFailure &&
      (!options.retryDiscovery || !discoveryRetryReleased);
    phase.status = failed ? 503 : 200;
    await route.fulfill(
      failed
        ? { status: 503, json: { error: 'Synthetic descriptor failure' } }
        : { json: descriptorDocument },
    );
    phase.fulfilled = Date.now();
  });
  await page.route('**/api/content-registry', async (route) => {
    await descriptors.pending;
    await route.fulfill({ json: defaultLibraries().registry });
  });
  await page.route('**/api/catalog?**', async (route) => {
    calls.catalog++;
    await catalog.pending;
    await route.fulfill({ json: catalogDocument });
  });
  await page.route(
    /\/api\/media\/[a-f0-9]{64}\/(poster|backdrop)$/,
    async (route) => {
      calls.artwork++;
      await artwork.pending;
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="180"><rect width="120" height="180" fill="#226254"/></svg>',
      });
    },
  );
  await page.route(/\/api\/library(?:\?.*)?$/, async (route) => {
    calls.summary++;
    const phase = {
      started: summaryStarts.get(route.request()) ?? null,
      received: Date.now(),
      released: 0,
      fulfilled: 0,
      status: 0,
    };
    phases.summary.push(phase);
    await summary.pending;
    phase.released = Date.now();
    phase.status = 200;
    await route.fulfill({ json: { movies: 60, tv: 0, series: 0, total: 60 } });
    phase.fulfilled = Date.now();
  });
  try {
    const response = await page.goto(
      options.historical ? '/__cold-history/633b063/' : '/',
      { waitUntil: 'commit' },
    );
    if (options.historical)
      expect(response?.headers()['x-shinema-cold-history']).toBe(
        '633b063e1ab7599d47569d659c9e0886896db92b',
      );
    await expect.poll(() => calls.entry).toBeGreaterThan(0);
    await startupCheckpoint(page);
    const beforeMount = await page.evaluate(() => ({
      blank: window.__shinemaStartup.samples.some(
        (sample) => !sample.meaningful,
      ),
      painted: window.__shinemaStartup.samples.some(
        (sample) => sample.meaningful,
      ),
    }));
    expect(beforeMount.blank).toBe(true);
    expect(beforeMount.painted).toBe(false);
    phases.entryReleased = Date.now();
    entry.release();
    await expect
      .poll(() => calls.descriptors + calls.catalog)
      .toBeGreaterThan(0);
    await page.waitForFunction(
      () => window.__shinemaStartup.samples.at(-1)?.meaningful,
      undefined,
      { timeout: 10000 },
    );
    await startupCheckpoint(page);
    expect(
      await page.evaluate(
        () =>
          Object.keys(
            window.__shinemaStartup.samples.find((sample) => sample.meaningful)!
              .anchors,
          ).filter((name) => /^slot\d+$/.test(name)).length,
      ),
    ).toBe(options.expectedInitialSlots ?? (options.historical ? 3 : 12));
    await options.beforeDescriptors?.(page);
    phases.descriptorsReleased = Date.now();
    descriptors.release();
    if (options.retryDiscovery) {
      await expect(page.locator('.section-heading')).toContainText(
        'Library discovery unavailable',
      );
      if (!options.saved?.['shinema.web.libraries.v1']) {
        await expect(
          page.locator('[data-testid="library-feed"]'),
        ).toHaveAttribute('aria-busy', 'false');
        await expect(page.locator('[data-browse-slot]')).toHaveCount(12);
        await expect(page.locator('.browse-tail')).toContainText(
          'Library discovery is unavailable. Refresh to retry.',
        );
      }
      await startupCheckpoint(page);
      const previousDiscoveryCalls = calls.descriptors;
      discoveryRetryReleased = true;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect
        .poll(() => calls.descriptors)
        .toBeGreaterThan(previousDiscoveryCalls);
    }
    if (
      descriptorDocument.libraries.some((library) => library.visible) ||
      options.historical
    ) {
      if (!options.cachedFeed)
        await expect.poll(() => calls.catalog).toBeGreaterThan(0);
      catalog.release();
      await expect(
        page.getByRole('button', {
          name: `Open ${catalogDocument.items[0].title}`,
          exact: true,
        }),
      ).toBeVisible();
      if (options.retryDiscovery)
        await expect(page.locator('.section-heading')).toContainText(
          'Connected',
        );
      if (hasArtwork) await expect.poll(() => calls.artwork).toBeGreaterThan(0);
      await startupCheckpoint(page);
    } else {
      catalog.release();
      await expect(
        page.getByText('No libraries are visible.', { exact: false }),
      ).toBeVisible();
    }
    await expect.poll(() => calls.summary).toBeGreaterThan(0);
    await startupCheckpoint(page);
    summary.release();
    await expect(page.locator('.page-title p')).toContainText(
      /60 movies.*0 episodes.*0 series/,
    );
    artwork.release();
    if (
      (descriptorDocument.libraries.some((library) => library.visible) ||
        options.historical) &&
      hasArtwork
    )
      await page.waitForFunction(() => {
        const visible = [...document.images].filter((image) => {
          const box = image.getBoundingClientRect();
          return (
            image.loading !== 'lazy' ||
            (box.bottom > 0 &&
              box.right > 0 &&
              box.top < innerHeight &&
              box.left < innerWidth)
          );
        });
        return (
          visible.length > 0 &&
          visible.every((image) => image.complete && image.naturalWidth > 0)
        );
      });
    await page.evaluate(async () => {
      await Promise.all(
        [...document.images]
          .filter((image) => {
            const box = image.getBoundingClientRect();
            return (
              image.loading !== 'lazy' ||
              (box.bottom > 0 &&
                box.right > 0 &&
                box.top < innerHeight &&
                box.left < innerWidth)
            );
          })
          .map((image) => image.decode()),
      );
    });
    if (options.font) {
      const fontProof = await page.evaluate(async () => {
        const metrics = () => {
          const title = document.querySelector(
            '.feature-copy h2, .programme-copy h2',
          )!;
          const range = document.createRange();
          range.selectNodeContents(title);
          const style = getComputedStyle(title);
          return {
            time: performance.now(),
            family: style.fontFamily,
            size: style.fontSize,
            adjust: style.fontSizeAdjust,
            lineHeight: style.lineHeight,
            fragments: [...range.getClientRects()].map((box) => ({
              x: box.x,
              y: box.y,
              width: box.width,
              height: box.height,
            })),
          };
        };
        const font = new FontFace(
          'ColdDelayedFixture',
          'local("Arial"), local("Liberation Sans"), local("DejaVu Sans"), local("Segoe UI")',
          { sizeAdjust: '130%' } as FontFaceDescriptors,
        );
        await font.load();
        document.fonts.add(font);
        const before = metrics();
        const appliedAt = performance.now();
        window.__shinemaStartup.fontAppliedAt = appliedAt;
        document.documentElement.style.setProperty(
          '--font-ui',
          'ColdDelayedFixture, sans-serif',
        );
        document.documentElement.style.setProperty(
          '--font-display',
          'ColdDelayedFixture, sans-serif',
        );
        await document.fonts.ready;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return {
          loaded: font.status,
          family: getComputedStyle(document.body).fontFamily,
          available: document.fonts.check('16px ColdDelayedFixture'),
          appliedAt,
          before,
          after: metrics(),
        };
      });
      await writeFile(
        info.outputPath('font-metrics.json'),
        JSON.stringify(fontProof),
      );
      expect(fontProof.loaded).toBe('loaded');
      expect(fontProof.available).toBe(true);
      expect(fontProof.family).toContain('ColdDelayedFixture');
    }
    const trace = await startupTrace(page);
    await writeFile(
      info.outputPath('whole-startup.json'),
      JSON.stringify({
        ...trace,
        problems: startupProblems(trace, {
          removedPendingCollectionPositions:
            options.removedPendingCollectionPositions,
          allLibrariesHidden: !descriptorDocument.libraries.some(
            (library) => library.visible,
          ),
          allowEmptySlots: !descriptorDocument.libraries.some(
            (library) => library.visible,
          ),
        }),
      }),
    );
    completed = true;
    return trace;
  } finally {
    entry.release();
    descriptors.release();
    catalog.release();
    summary.release();
    artwork.release();
    phases.complete = Date.now();
    await writeFile(
      info.outputPath('startup-phases.json'),
      JSON.stringify(phases),
    );
    if (!completed) {
      try {
        await writeFile(
          info.outputPath('whole-startup-incomplete.json'),
          JSON.stringify(await startupTrace(page)),
        );
      } catch {
        /* The phase receipt remains available if the document closed. */
      }
    }
  }
}

function expectStable(
  trace: Awaited<ReturnType<typeof startupTrace>>,
  allowEmptySlots = false,
  removedPendingCollectionPositions: number[] = [],
  options: { allowCatalogRevisionReset?: boolean } = {},
) {
  expect(trace.initialStorage).toBe(0);
  expect(trace.firstContentfulPaint).not.toBeNull();
  expect(trace.samples[0].time).toBeLessThanOrEqual(
    trace.firstContentfulPaint!,
  );
  expect(
    startupProblems(trace, {
      allowEmptySlots,
      allLibrariesHidden: allowEmptySlots,
      removedPendingCollectionPositions,
      ...options,
    }).slice(0, 40),
  ).toEqual([]);
  expect(trace.shifts.reduce((sum, entry) => sum + entry.value, 0)).toBe(0);
}

test('whole startup preserves the shell when authoritative libraries are all hidden', async ({
  page,
  api,
}, info) => {
  expect(api.blockedRequests).toEqual([]);
  const trace = await coldStartup(page, info, {
    libraries: {
      ...defaultLibraries(),
      revision: 7,
      libraries: defaultLibraries().libraries.map((library) => ({
        ...library,
        visible: false,
      })),
    },
  });
  expectStable(trace, true);
});

test('whole startup reserves saved custom navigation before descriptor discovery', async ({
  page,
  api,
}, info) => {
  expect(api.blockedRequests).toEqual([]);
  const libraries = defaultLibraries();
  const trace = await coldStartup(page, info, {
    libraries: {
      ...libraries,
      revision: 7,
      libraries: [
        ...libraries.libraries,
        {
          id: 'custom',
          name: 'Custom',
          mediaType: 'movies',
          contentTypeId: 'movies',
          order: 2,
          visible: true,
        },
      ],
    },
    saved: {
      'shinema.web.top-navigation.v1': JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'custom-link',
            label: 'Custom',
            destination: { kind: 'library', libraryId: 'custom' },
            order: 0,
            visible: true,
          },
          {
            id: 'search-link',
            label: 'Search',
            destination: { kind: 'search' },
            order: 1,
            visible: true,
          },
        ],
      }),
    },
  });
  expectStable(trace);
});

test('whole startup keeps phone collection controls fixed when discovery adds a library', async ({
  page,
  api,
}, info) => {
  expect(api.blockedRequests).toEqual([]);
  const libraries = defaultLibraries();
  const trace = await coldStartup(page, info, {
    width: 390,
    libraries: {
      ...libraries,
      revision: 7,
      libraries: [
        ...libraries.libraries,
        {
          id: 'music',
          name: 'Music',
          mediaType: 'music',
          contentTypeId: 'music',
          order: 2,
          visible: true,
        },
      ],
    },
  });
  expectStable(trace);
});

test('whole startup reserves a saved collection ordered before undiscovered libraries', async ({
  page,
  api,
}, info) => {
  expect(api.blockedRequests).toEqual([]);
  const libraries = defaultLibraries();
  const trace = await coldStartup(page, info, {
    libraries: {
      ...libraries,
      revision: 7,
      libraries: [
        ...libraries.libraries,
        {
          id: 'custom',
          name: 'Custom',
          mediaType: 'movies',
          contentTypeId: 'movies',
          order: 0,
          visible: true,
        },
      ],
    },
    saved: {
      'shinema.web.navigation.v1': JSON.stringify({
        order: ['custom', 'movies', 'tv'],
        hidden: [],
      }),
    },
  });
  expectStable(trace);
});

for (const width of [390, 1280]) {
  test(`whole startup is stable from fresh storage through delayed artwork and font at ${width}`, async ({
    page,
    api,
  }, info) => {
    const trace = await coldStartup(page, info, { width, font: true });
    expectStable(trace);
    expect(api.blockedRequests).toEqual([]);
  });
  test(`whole startup preserves remembered Archive compact landscape with stale catalog at ${width}`, async ({
    page,
    api,
  }, info) => {
    const theme = {
      ...archiveTheme,
      design: {
        ...archiveTheme.design,
        density: 'compact',
        cards: 'landscape',
      },
    };
    const trace = await coldStartup(page, info, {
      width,
      font: true,
      saved: {
        'shinema.appearance.v1': JSON.stringify({
          version: 1,
          theme,
          motion: 'system',
        }),
        'shinema.web.libraries.v1': JSON.stringify({
          ...defaultLibraries(),
          revision: 1,
        }),
        'shinema.web.cache.v1': JSON.stringify({
          catalog: {
            apiVersion: 1,
            fullLibrary: true,
            items: [mediaFor(0), mediaFor(1), mediaFor(2)],
            total: 3,
          },
          progress: {},
          pending: {},
        }),
      },
    });
    expectStable(trace);
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'archive');
    await expect(page.locator('html')).toHaveAttribute(
      'data-density',
      'compact',
    );
    await expect(page.locator('html')).toHaveAttribute(
      'data-cards',
      'landscape',
    );
    expect(api.blockedRequests).toEqual([]);
  });
  test(`whole startup keeps the shell stable when browser storage is unavailable at ${width}`, async ({
    page,
    api,
  }, info) => {
    const trace = await coldStartup(page, info, {
      width,
      noStorage: true,
      font: true,
    });
    expectStable(trace);
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'Browser storage is unavailable' }),
    ).toBeVisible();
    expect(api.blockedRequests).toEqual([]);
  });
}

test('whole startup keeps cached collections stable when fresh discovery inserts a new first library', async ({
  page,
  api,
}, info) => {
  expect(api.blockedRequests).toEqual([]);
  const libraries = defaultLibraries();
  const trace = await coldStartup(page, info, {
    libraries: {
      ...libraries,
      revision: 3,
      libraries: [
        {
          id: 'custom',
          name: 'Custom',
          mediaType: 'movies',
          contentTypeId: 'movies',
          order: 0,
          visible: true,
        },
        ...libraries.libraries.map((library) => ({
          ...library,
          order: library.order + 1,
        })),
      ],
    },
    saved: {
      'shinema.web.libraries.v1': JSON.stringify({ ...libraries, revision: 2 }),
    },
  });
  expectStable(trace);
});

for (const result of ['hidden', 'removed', 'error'] as const) {
  test(`whole startup preserves Search when cached custom navigation becomes ${result}`, async ({
    page,
    api,
  }, info) => {
    const libraries = defaultLibraries();
    const custom = {
      id: 'custom',
      name: 'Custom',
      mediaType: 'movies',
      contentTypeId: 'movies',
      order: 2,
      visible: true,
    };
    const cached = {
      ...libraries,
      revision: 2,
      libraries: [...libraries.libraries, custom],
    };
    const trace = await coldStartup(page, info, {
      libraries: {
        ...libraries,
        revision: 3,
        libraries:
          result === 'removed'
            ? libraries.libraries
            : [
                ...libraries.libraries,
                { ...custom, visible: result !== 'hidden' },
              ],
      },
      descriptorFailure: result === 'error',
      removedPendingCollectionPositions: result === 'error' ? [] : [2],
      saved: {
        'shinema.web.libraries.v1': JSON.stringify(cached),
        'shinema.web.top-navigation.v1': JSON.stringify({
          version: 1,
          entries: [
            {
              id: 'custom-link',
              label: 'Custom',
              destination: { kind: 'library', libraryId: 'custom' },
              order: 0,
              visible: true,
            },
            {
              id: 'search-link',
              label: 'Search',
              destination: { kind: 'search' },
              order: 1,
              visible: true,
            },
          ],
        }),
      },
    });
    expectStable(trace, false, result === 'error' ? [] : [2]);
    await expect(
      page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Search', exact: true }),
    ).toBeVisible();
    if (result !== 'error') {
      await expect(
        page.getByRole('button', { name: 'Custom', exact: true }),
      ).toHaveCount(0);
      await expect(
        page.locator('[data-navigation-slot="custom-link"]'),
      ).toHaveAttribute('aria-hidden', 'true');
    }
    expect(api.blockedRequests).toEqual([]);
  });
}

test('whole startup is stable with system reduced motion from fresh storage', async ({
  page,
  api,
}, info) => {
  const trace = await coldStartup(page, info, {
    width: 390,
    reduced: true,
    font: true,
  });
  expectStable(trace);
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  expect(api.blockedRequests).toEqual([]);
});

test('whole startup oracle detects a painted move then restore and equal-rectangle shell replacement', async ({
  page,
  api,
}, info) => {
  expect(api.blockedRequests).toEqual([]);
  const healthy = await coldStartup(page, info);
  expectStable(healthy);
  const original = healthy.samples.at(-1)!.anchors.header.rect;
  await page.locator('.header').evaluate((node) => {
    (node as HTMLElement).style.transform = 'translateY(8px)';
  });
  const moved = await startupTrace(page);
  await page.locator('.header').evaluate((node) => {
    (node as HTMLElement).style.removeProperty('transform');
  });
  const restored = await startupTrace(page);
  expect(restored.samples.at(-1)!.anchors.header.rect).toEqual(original);
  expect(
    startupProblems(moved).some(
      (problem) =>
        problem.anchor === 'header' &&
        problem.kind === 'y' &&
        problem.delta === 8,
    ),
  ).toBe(true);
  expect(
    startupProblems(restored).some(
      (problem) => problem.anchor === 'header' && problem.kind === 'y',
    ),
  ).toBe(true);
  const previous = restored.samples.at(-1)!.anchors.main.rect;
  await page.locator('.app main').evaluate((node) => {
    node.replaceWith(node.cloneNode(true));
  });
  const replaced = await startupTrace(page);
  expect(replaced.samples.at(-1)!.anchors.main.rect).toEqual(previous);
  expect(
    startupProblems(replaced).some(
      (problem) =>
        problem.anchor === 'main' &&
        ['replaced', 'removed'].includes(problem.kind),
    ),
  ).toBe(true);
});

test('whole startup oracle detects removal of a nonfirst logical card even when later cards fill its position', async ({
  page,
  api,
}, info) => {
  expect(api.blockedRequests).toEqual([]);
  const healthy = await coldStartup(page, info);
  expectStable(healthy);
  const second = page.locator('[data-browse-slot="1"]');
  await expect(second).toBeInViewport();
  await second.evaluate((node) => {
    node.remove();
  });
  const removed = await startupTrace(page);
  expect(
    startupProblems(removed).some(
      (problem) => problem.anchor === 'slot1' && problem.kind === 'missing',
    ),
  ).toBe(true);
});

test('actual historical 633 client is rejected for its three-slot shell replacement', async ({
  page,
  api,
}, info) => {
  test.skip(
    process.env.SHINEMA_COLD_HISTORY !== '1',
    'Optional local proof requires the pinned local historical Git object',
  );
  expect(api.blockedRequests).toEqual([]);
  const historical = await coldStartup(page, info, { historical: true });
  const problems = startupProblems(historical);
  expect(
    problems.some(
      (problem) =>
        problem.anchor === 'main' &&
        ['removed', 'replaced'].includes(problem.kind),
    ),
  ).toBe(true);
  expect(problems.some((problem) => Math.abs(problem.delta ?? 0) > 40)).toBe(
    true,
  );
});

for (const viewport of [
  { width: 1600, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`whole opening viewport is stable at ${viewport.width}x${viewport.height}`, async ({
    page,
    api,
  }, info) => {
    const trace = await coldStartup(page, info, { ...viewport, font: true });
    expectStable(trace);
    expect(api.blockedRequests).toEqual([]);
  });
  test(`whole startup restores a real bounded browse page cache at ${viewport.width}x${viewport.height}`, async ({
    page,
    api,
  }, info) => {
    const path = browsePath({
      ...initialBrowse(),
      libraryId: 'movies',
      revision: 7,
    });
    const cache = rememberPage({}, path, startupCatalog());
    const trace = await coldStartup(page, info, {
      ...viewport,
      cachedFeed: true,
      font: false,
      saved: {
        'shinema.web.libraries.v1': JSON.stringify({
          ...defaultLibraries(),
          revision: 7,
        }),
        'shinema.web.browse.v1': JSON.stringify(cache),
      },
      beforeDescriptors: async (page) => {
        await expect(
          page.locator('[data-testid="library-feed"]'),
        ).toHaveAttribute('data-loaded-count', '60');
        await expect(
          page.getByRole('button', {
            name: 'Open Generated movie 00000',
            exact: true,
          }),
        ).toBeVisible();
      },
    });
    expectStable(trace);
    expect(api.blockedRequests).toEqual([]);
  });
}

test('whole startup oracle rejects an entirely missing required header from the first app frame', async ({
  page,
  api,
}, info) => {
  await page.addInitScript(() => {
    // Registered before the probe: remove the header before its first census.
    new MutationObserver(() =>
      document.querySelector('.header')?.remove(),
    ).observe(document, { childList: true, subtree: true });
  });
  const trace = await coldStartup(page, info);
  expect(
    trace.samples
      .filter((sample) => sample.meaningful)
      .every((sample) => !sample.anchors.header),
  ).toBe(true);
  expect(
    startupProblems(trace).some(
      (problem) =>
        problem.anchor === 'header' && problem.kind === 'required-missing',
    ),
  ).toBe(true);
  expect(api.blockedRequests).toEqual([]);
});

test('whole startup oracle rejects three initial logical slots even when the reserved grid restores all twelve', async ({
  page,
  api,
}, info) => {
  await page.addInitScript(() => {
    const removed = new Map<number, Element>();
    const observer = new MutationObserver(() => {
      for (const node of document.querySelectorAll('[data-browse-slot]')) {
        const index = Number(node.getAttribute('data-browse-slot'));
        if (index >= 3 && index < 12) {
          removed.set(index, node);
          node.remove();
        }
      }
    });
    observer.observe(document, { childList: true, subtree: true });
    Object.assign(window, {
      __restoreInitialSlots: () => {
        observer.disconnect();
        const grid = document.querySelector('[data-testid="library-feed"]')!;
        for (const [, node] of [...removed].sort(([a], [b]) => a - b))
          grid.append(node);
      },
    });
  });
  const trace = await coldStartup(page, info, {
    expectedInitialSlots: 3,
    beforeDescriptors: async (page) => {
      const before = await startupTrace(page);
      const initial = before.samples.find((sample) => sample.meaningful)!;
      await page.evaluate(() =>
        (
          window as unknown as { __restoreInitialSlots: () => void }
        ).__restoreInitialSlots(),
      );
      const restored = (await startupTrace(page)).samples.at(-1)!;
      expect(restored.anchors.grid.rect).toEqual(initial.anchors.grid.rect);
      expect(restored.anchors.slot0.rect).toEqual(initial.anchors.slot0.rect);
      expect(
        Object.keys(restored.anchors).filter((name) => /^slot\d+$/.test(name)),
      ).toHaveLength(12);
    },
  });
  const first = trace.samples.find((sample) => sample.meaningful)!;
  expect(
    Object.keys(first.anchors).filter((name) => /^slot\d+$/.test(name)),
  ).toEqual(['slot0', 'slot1', 'slot2']);
  expect(trace.samples.some((sample) => sample.terminalEmpty)).toBe(false);
  for (let index = 3; index < 12; index++)
    expect(startupProblems(trace)).toContainEqual({
      frame: first.frame,
      anchor: `slot${index}`,
      kind: 'required-missing',
    });
  expect(api.blockedRequests).toEqual([]);
});

test('whole startup oracle catches inner nonfirst poster and title movement inside a fixed card', async ({
  page,
  api,
}, info) => {
  const healthy = await coldStartup(page, info);
  expectStable(healthy);
  const card = page.locator('[data-browse-slot="1"]');
  const outer = await card.boundingBox();
  const poster = await card.locator('.poster').boundingBox();
  await card.locator('.poster img').evaluate((node) => {
    (node as HTMLElement).style.transition = 'none';
    (node as HTMLElement).style.transform = 'translateX(8px)';
  });
  await card.locator('h3').evaluate((node) => {
    (node as HTMLElement).style.transition = 'none';
    (node as HTMLElement).style.transform = 'translateX(8px)';
  });
  const moved = await startupTrace(page);
  expect(await card.boundingBox()).toEqual(outer);
  expect(await card.locator('.poster').boundingBox()).toEqual(poster);
  expect(
    startupProblems(moved).some(
      (problem) =>
        problem.anchor === 'slot1Artwork' &&
        problem.kind === 'x' &&
        problem.delta === 8,
    ),
  ).toBe(true);
  await card.locator('.poster img').evaluate((node) => {
    (node as HTMLElement).style.removeProperty('transform');
  });
  await card.locator('.poster').evaluate((node) => {
    (node as HTMLElement).style.transition = 'none';
    (node as HTMLElement).style.transform = 'translateX(8px)';
  });
  const wrapperMoved = await startupTrace(page);
  expect(
    startupProblems(wrapperMoved).some(
      (problem) =>
        problem.anchor === 'slot1Poster' &&
        problem.kind === 'x' &&
        problem.delta === 8,
    ),
  ).toBe(true);
  expect(
    startupProblems(moved).some(
      (problem) =>
        problem.anchor === 'slot1Title' &&
        problem.kind === 'x' &&
        problem.delta === 8,
    ),
  ).toBe(true);
  expect(api.blockedRequests).toEqual([]);
});

test('whole startup pending-tail exception rejects a temporary disappearance before the real button returns', async ({
  page,
  api,
}, info) => {
  const libraries = { ...defaultLibraries(), revision: 7 };
  libraries.libraries.push({
    id: 'custom',
    name: 'Custom',
    mediaType: 'movies',
    contentTypeId: 'movies',
    order: 2,
    visible: true,
  });
  const trace = await coldStartup(page, info, {
    libraries,
    removedPendingCollectionPositions: [2],
    saved: { 'shinema.web.libraries.v1': JSON.stringify(libraries) },
    beforeDescriptors: async (page) => {
      await page.locator('.library-sidebar nav').evaluate(async (nav) => {
        const tail = nav.querySelector('[data-collection-position="2"]')!;
        nav.setAttribute('aria-busy', 'false');
        tail.remove();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        nav.append(tail);
      });
    },
  });
  expect(
    startupProblems(trace, { removedPendingCollectionPositions: [2] }).some(
      (problem) =>
        problem.anchor === 'collectionPosition2' && problem.kind === 'missing',
    ),
  ).toBe(true);
  expect(api.blockedRequests).toEqual([]);
});

test('fresh failed discovery stops loading in its reserved shell and recovers on Refresh', async ({
  page,
  api,
}, info) => {
  const trace = await coldStartup(page, info, {
    descriptorFailure: true,
    retryDiscovery: true,
  });
  expectStable(trace);
  expect(api.blockedRequests).toEqual([]);
});

test('cached custom-first discovery failure reserves actionable order through retry removal', async ({
  page,
  api,
}, info) => {
  const libraries = defaultLibraries();
  const cached = {
    ...libraries,
    revision: 7,
    libraries: [
      {
        id: 'custom',
        name: 'Custom',
        mediaType: 'movies',
        contentTypeId: 'movies',
        visible: true,
        order: 0,
      },
      ...libraries.libraries.map((library) => ({
        ...library,
        order: library.order + 1,
      })),
    ],
  };
  const trace = await coldStartup(page, info, {
    libraries: { ...libraries, revision: 8 },
    descriptorFailure: true,
    retryDiscovery: true,
    saved: { 'shinema.web.libraries.v1': JSON.stringify(cached) },
  });
  expectStable(trace);
  await expect(
    page.getByRole('button', { name: 'Custom', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('[data-collection-slot="custom"]')).toHaveAttribute(
    'aria-hidden',
    'true',
  );
  expect(api.blockedRequests).toEqual([]);
});

for (const result of ['hidden', 'removed', 'reordered'] as const) {
  test(`healthy collections preserve physical slots through offline and online ${result} discovery`, async ({
    page,
    context,
    api,
  }, info) => {
    const libraries = defaultLibraries();
    const custom = {
      id: 'custom',
      name: 'Custom',
      mediaType: 'movies',
      contentTypeId: 'movies',
      visible: true,
      order: 0,
    };
    const initial = {
      ...libraries,
      revision: 7,
      libraries: [
        custom,
        ...libraries.libraries.map((library) => ({
          ...library,
          order: library.order + 1,
        })),
      ],
    };
    const healthy = await coldStartup(page, info, {
      width: 1600,
      libraries: initial,
    });
    expectStable(healthy);
    const expectedArtwork = Object.entries(healthy.samples.at(-1)!.anchors)
      .filter(
        ([name, anchor]) =>
          /^slot\d+Artwork$/.test(name) &&
          (anchor.visible || anchor.eagerArtwork),
      )
      .map(([name]) => name);
    expect(expectedArtwork.length).toBeGreaterThan(0);
    await expect(
      page.getByRole('button', { name: 'Custom', exact: true }),
    ).toBeVisible();
    const next = {
      ...libraries,
      revision: 8,
      libraries:
        result === 'removed'
          ? libraries.libraries
          : [
              ...libraries.libraries,
              { ...custom, order: 2, visible: result !== 'hidden' },
            ],
    };
    const refresh = latch();
    let calls = 0;
    const catalogScopes: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/catalog')
        catalogScopes.push(url.searchParams.get('library') ?? 'legacy');
    });
    await page.route('**/api/libraries', async (route) => {
      calls++;
      await refresh.pending;
      await route.fulfill({ json: next });
    });
    try {
      await context.setOffline(true);
      await expect
        .poll(() => page.evaluate(() => navigator.onLine))
        .toBe(false);
      await startupCheckpoint(page);
      // There is no failed descriptor GET in this interval. Reconnection must
      // preserve the real controls established by the earlier healthy result.
      expect(calls).toBe(0);
      await context.setOffline(false);
      await expect.poll(() => calls).toBeGreaterThan(0);
      await startupCheckpoint(page);
      refresh.release();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              JSON.parse(localStorage.getItem('shinema.web.libraries.v1')!)
                .revision,
          ),
        )
        .toBe(8);
      await expect(
        page.getByRole('button', {
          name: 'Open Generated movie 00000',
          exact: true,
        }),
      ).toBeVisible();
      await page.waitForFunction(() =>
        [...document.images].every((image) => {
          const box = image.getBoundingClientRect();
          const visible =
            box.bottom > 0 &&
            box.right > 0 &&
            box.top < innerHeight &&
            box.left < innerWidth;
          return (
            (image.loading === 'lazy' && !visible) ||
            (image.complete && image.naturalWidth > 0)
          );
        }),
      );
      await page.evaluate(async () => {
        await Promise.all(
          [...document.images]
            .filter((image) => {
              const box = image.getBoundingClientRect();
              return (
                image.loading !== 'lazy' ||
                (box.bottom > 0 &&
                  box.right > 0 &&
                  box.top < innerHeight &&
                  box.left < innerWidth)
              );
            })
            .map((image) => image.decode()),
        );
      });
      const trace = await startupTrace(page);
      await writeFile(
        info.outputPath('whole-reconnection.json'),
        JSON.stringify(trace),
      );
      expectStable(trace, false, [], { allowCatalogRevisionReset: true });
      for (const name of expectedArtwork) {
        const artwork = trace.samples.at(-1)!.anchors[name];
        expect(
          artwork,
          `Decoded fixture artwork must return in ${name}`,
        ).toBeDefined();
        expect(artwork.loadedSlot).toBe(true);
        expect(artwork.rendered).toBe(true);
      }
      if (result !== 'reordered') {
        await expect(
          page.getByRole('button', { name: 'Custom', exact: true }),
        ).toHaveCount(0);
        await expect(
          page.locator('[data-collection-slot="custom"]'),
        ).toHaveAttribute('aria-hidden', 'true');
      }
      expect(catalogScopes).not.toContain('custom');
      expect(api.blockedRequests).toEqual([]);
    } finally {
      refresh.release();
      await context.setOffline(false);
    }
  });
}

for (const viewport of [
  { width: 1600, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`Archive artwork-free feature survives a held revision refresh at ${viewport.width}x${viewport.height}`, async ({
    page,
    context,
    api,
  }, info) => {
    const catalog = startupCatalog({
      artwork: false,
      titlePrefix: 'GeneratedControl',
    });
    expect(
      catalog.items.every(
        (item) =>
          !Object.hasOwn(item, 'posterPath') &&
          !Object.hasOwn(item, 'backdropPath'),
      ),
    ).toBe(true);
    const healthy = await coldStartup(page, info, {
      ...viewport,
      catalog,
      saved: {
        'shinema.appearance.v1': JSON.stringify({
          version: 1,
          theme: archiveTheme,
          motion: 'system',
        }),
      },
    });
    expectStable(healthy);
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
    const feature = page.getByTestId('library-feature');
    const action = feature.getByRole('button', {
      name: 'View details',
      exact: true,
    });
    await expect(feature.locator('.programme-copy h2')).toHaveText(
      'GeneratedControl00',
    );
    await expect(
      feature.locator(
        '.programme-poster .poster-unavailable > span:last-child',
      ),
    ).toHaveText('GeneratedControl00');
    await expect(action).toBeEnabled();
    await page.evaluate(() => document.fonts.ready);
    await action.focus();
    const lifetime = await page.evaluateHandle(() => {
      const feature = document.querySelector(
        '[data-testid="library-feature"]',
      )!;
      const caption = feature.querySelector(
        '.programme-poster .poster-unavailable > span:last-child',
      )!;
      const text = caption.firstChild;
      const records: Array<{
        title: string | null;
        caption: string | null;
        sameCaption: boolean;
        sameText: boolean;
        rendered: boolean;
        time: number;
      }> = [];
      let running = true;
      const rendered = (node: Element | null) => {
        if (!node) return false;
        const box = node.getBoundingClientRect();
        if (!box.width || !box.height) return false;
        for (
          let ancestor: Element | null = node;
          ancestor;
          ancestor = ancestor.parentElement
        ) {
          const style = getComputedStyle(ancestor);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            Number(style.opacity) === 0
          )
            return false;
        }
        return true;
      };
      const capture = () => {
        const current = feature.querySelector(
          '.programme-poster .poster-unavailable > span:last-child',
        );
        records.push({
          title:
            feature.querySelector('.programme-copy h2')?.textContent ?? null,
          caption: current?.textContent ?? null,
          sameCaption: current === caption,
          sameText: current?.firstChild === text,
          rendered: rendered(current),
          time: performance.now(),
        });
      };
      const observer = new MutationObserver(capture);
      observer.observe(feature, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
      const tick = () => {
        if (running) {
          capture();
          requestAnimationFrame(tick);
        }
      };
      capture();
      requestAnimationFrame(tick);
      return {
        records,
        capture,
        stop: () => {
          running = false;
          observer.disconnect();
        },
      };
    });
    const replacement = latch();
    let calls = 0;
    const scopes: string[] = [];
    await page.route('**/api/libraries', (route) =>
      route.fulfill({ json: { ...defaultLibraries(), revision: 8 } }),
    );
    await page.route('**/api/catalog?**', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('revision') !== '8') return route.fallback();
      scopes.push(url.searchParams.get('library') ?? 'legacy');
      calls++;
      await replacement.pending;
      await route.fulfill({ json: catalog });
    });
    try {
      const fonts = await page.evaluate(() => document.fonts.status);
      expect(fonts).toBe('loaded');
      await context.setOffline(true);
      const onlineRequestedAt = await page.evaluate(() => performance.now());
      await context.setOffline(false);
      await expect.poll(() => calls).toBeGreaterThan(0);
      await expect(page.getByTestId('library-feed')).toHaveAttribute(
        'data-library-revision',
        '8',
      );
      await expect(page.getByTestId('library-feed')).toHaveAttribute(
        'aria-busy',
        'true',
      );
      await startupCheckpoint(page);
      const pending = {
        title: await feature.locator('.programme-copy h2').textContent(),
        caption: await feature
          .locator('.programme-poster .poster-unavailable > span:last-child')
          .textContent(),
        actionDisabled: await action.isDisabled(),
      };
      await page.keyboard.press('Enter');
      await expect(page.locator('main.detail')).toHaveCount(0);
      replacement.release();
      await expect(page.getByTestId('library-feed')).toHaveAttribute(
        'data-loaded-count',
        '60',
      );
      await expect(page.getByTestId('library-feed')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      await expect(action).toBeEnabled();
      await lifetime.evaluate((state) => state.capture());
      const records = await lifetime.evaluate((state) => state.records);
      const trace = await startupTrace(page);
      await writeFile(
        info.outputPath('archive-no-art-refresh.json'),
        JSON.stringify({ fonts, onlineRequestedAt, pending, records, trace }),
      );
      expect(scopes).toEqual(['movies']);
      expect.soft(pending).toEqual({
        title: 'GeneratedControl00',
        caption: 'GeneratedControl00',
        actionDisabled: true,
      });
      expect
        .soft(
          records.every(
            (record) =>
              record.title === 'GeneratedControl00' &&
              record.caption === 'GeneratedControl00' &&
              record.sameCaption &&
              record.sameText &&
              record.rendered,
          ),
        )
        .toBe(true);
      expectStable(trace, false, [], { allowCatalogRevisionReset: true });
      await expect(page.locator('.real-poster img')).toHaveCount(0);
      expect(api.blockedRequests).toEqual([]);
    } finally {
      replacement.release();
      await lifetime.evaluate((state) => state.stop());
      await context.setOffline(false);
    }
  });
}

test('catalog revision calibration preserves geometry and rejects media replacements outside the one new-scope handoff', async ({
  page,
  api,
}, info) => {
  const healthy = await coldStartup(page, info, { width: 1600 });
  expectStable(healthy);
  const options = { allowCatalogRevisionReset: true };
  const card = page.locator('[data-browse-slot="1"]');
  await card.evaluate((node) => node.replaceWith(node.cloneNode(true)));
  await card
    .locator('img')
    .evaluate((image: HTMLImageElement) => image.decode());
  const premature = await startupTrace(page);
  expect(
    startupProblems(premature, options).some(
      (problem) => problem.anchor === 'slot1' && problem.kind === 'replaced',
    ),
  ).toBe(true);
  await page.evaluate(() => {
    document
      .querySelector('[data-testid="library-feed"]')!
      .setAttribute('data-library-revision', '8');
    const card = document.querySelector('[data-browse-slot="1"]')!;
    card.replaceWith(card.cloneNode(true));
  });
  await card
    .locator('img')
    .evaluate((image: HTMLImageElement) => image.decode());
  const handoff = await startupTrace(page);
  const firstNewScope = handoff.samples.find(
    (sample) => sample.catalogRevision === 8,
  )!.frame;
  expect(
    startupProblems(handoff, options).filter(
      (problem) =>
        problem.frame >= firstNewScope &&
        problem.anchor === 'slot1' &&
        problem.kind === 'replaced',
    ),
  ).toEqual([]);
  const handoffFrame = handoff.samples.at(-1)!.frame;
  const replay = structuredClone(handoff);
  const last = replay.samples.at(-1)!;
  replay.samples.push(
    { ...last, frame: handoffFrame + 1, catalogRevision: 7 },
    {
      ...last,
      frame: handoffFrame + 2,
      catalogRevision: 8,
      anchors: {
        ...last.anchors,
        slot1: { ...last.anchors.slot1, id: last.anchors.slot1.id + 10000 },
      },
    },
  );
  expect(startupProblems(replay, options)).toContainEqual({
    frame: handoffFrame + 1,
    anchor: 'catalogRevision',
    kind: 'revision-regressed',
    delta: -1,
  });
  expect(startupProblems(replay, options)).toContainEqual({
    frame: handoffFrame + 2,
    anchor: 'slot1',
    kind: 'replaced',
  });
  await page.evaluate(() => {
    const card = document.querySelector('[data-browse-slot="1"]')!;
    card.replaceWith(card.cloneNode(true));
    const image = document.querySelector('[data-browse-slot="2"] img')!;
    image.replaceWith(image.cloneNode(true));
    document.querySelector('[data-browse-slot="3"] img')!.remove();
    const header = document.querySelector('.header')!;
    header.replaceWith(header.cloneNode(true));
  });
  await page
    .locator('[data-browse-slot="2"] img')
    .evaluate((image: HTMLImageElement) => image.decode());
  const corrupted = await startupTrace(page);
  const problems = startupProblems(corrupted, options).filter(
    (problem) => problem.frame > handoffFrame,
  );
  for (const [anchor, kind] of [
    ['slot1', 'replaced'],
    ['slot2Artwork', 'replaced'],
    ['slot3Artwork', 'missing'],
    ['header', 'replaced'],
  ])
    expect(
      problems.some(
        (problem) => problem.anchor === anchor && problem.kind === kind,
      ),
    ).toBe(true);
  const boundaryArtwork = corrupted.samples.at(-1)!.anchors.slot4Artwork;
  expect(boundaryArtwork.visible || boundaryArtwork.eagerArtwork).toBe(true);
  await page.evaluate(() => {
    document
      .querySelector('[data-testid="library-feed"]')!
      .setAttribute('data-library-revision', '9');
    document.querySelector('[data-browse-slot="4"] img')!.remove();
  });
  const unresolved = await startupTrace(page);
  expect(unresolved.samples.at(-1)!.anchors.slot4Artwork).toBeUndefined();
  expect(startupProblems(unresolved, options)).toContainEqual({
    frame: unresolved.samples.at(-1)!.frame,
    anchor: 'slot4Artwork',
    kind: 'unresolved-artwork',
  });
  await page.evaluate(() => {
    const image = document
      .querySelector('[data-browse-slot="5"] img')!
      .cloneNode(true) as HTMLImageElement;
    image.style.transition = 'none';
    image.style.opacity = '0';
    document.querySelector('[data-browse-slot="4"] .poster')!.append(image);
  });
  await page
    .locator('[data-browse-slot="4"] img')
    .evaluate((image: HTMLImageElement) => image.decode());
  const transparent = await startupTrace(page);
  expect(transparent.samples.at(-1)!.anchors.slot4Artwork.rendered).toBe(false);
  expect(startupProblems(transparent, options)).toContainEqual({
    frame: transparent.samples.at(-1)!.frame,
    anchor: 'slot4Artwork',
    kind: 'unresolved-artwork',
  });
  expect(api.blockedRequests).toEqual([]);
});

test('whole startup CLS oracle detects text-only movement from an explicitly injected foreign font', async ({
  page,
  api,
}, info) => {
  const path = browsePath({
    ...initialBrowse(),
    libraryId: 'movies',
    revision: 7,
  });
  const trace = await coldStartup(page, info, {
    width: 1600,
    cachedFeed: true,
    font: true,
    saved: {
      'shinema.web.libraries.v1': JSON.stringify({
        ...defaultLibraries(),
        revision: 7,
      }),
      'shinema.web.browse.v1': JSON.stringify(
        rememberPage({}, path, startupCatalog()),
      ),
    },
  });
  // Shipped themes use local enum-selected fonts. This deliberate foreign
  // family swap calibrates CLS detection; it is not an ordinary startup input.
  expect(startupProblems(trace)).toEqual([]);
  expect(trace.fontAppliedAt).not.toBeNull();
  expect(
    trace.shifts.some(
      (shift) =>
        !shift.recentInput &&
        shift.time >= trace.fontAppliedAt! &&
        shift.value > 0 &&
        shift.sources.some(
          (source) =>
            source.anchor === 'featureTitle' && source.kind === 'text',
        ),
    ),
  ).toBe(true);
  expect(api.blockedRequests).toEqual([]);
});

test('whole startup raw CLS oracle also rejects text-only foreign font movement during recent input', async ({
  page,
  api,
}, info) => {
  const path = browsePath({
    ...initialBrowse(),
    libraryId: 'movies',
    revision: 7,
  });
  const healthy = await coldStartup(page, info, {
    width: 1600,
    cachedFeed: true,
    saved: {
      'shinema.web.libraries.v1': JSON.stringify({
        ...defaultLibraries(),
        revision: 7,
      }),
      'shinema.web.browse.v1': JSON.stringify(
        rememberPage({}, path, startupCatalog()),
      ),
    },
  });
  expectStable(healthy);
  await page.evaluate(async () => {
    const font = new FontFace(
      'ColdRecentInputFixture',
      'local("Arial"), local("Liberation Sans"), local("DejaVu Sans"), local("Segoe UI")',
      { sizeAdjust: '130%' } as FontFaceDescriptors,
    );
    await font.load();
    document.fonts.add(font);
    document.addEventListener(
      'keydown',
      () => {
        window.__shinemaStartup.fontAppliedAt = performance.now();
        document.documentElement.style.setProperty(
          '--font-ui',
          'ColdRecentInputFixture, sans-serif',
        );
        document.documentElement.style.setProperty(
          '--font-display',
          'ColdRecentInputFixture, sans-serif',
        );
      },
      { once: true },
    );
  });
  // A real modifier key supplies recent input without scrolling or changing a
  // focused control. The prepared foreign font is applied in that key event.
  await page.keyboard.press('Shift');
  const changed = await startupTrace(page);
  await writeFile(
    info.outputPath('recent-input-negative.json'),
    JSON.stringify(changed),
  );
  expect(startupProblems(changed)).toEqual([]);
  expect(changed.fontAppliedAt).not.toBeNull();
  expect(
    changed.shifts.some(
      (shift) =>
        shift.recentInput &&
        shift.value > 0 &&
        shift.time >= changed.fontAppliedAt! &&
        shift.sources.some(
          (source) =>
            source.anchor === 'featureTitle' && source.kind === 'text',
        ),
    ),
  ).toBe(true);
  expect(() => expectStable(changed)).toThrow();
  expect(api.blockedRequests).toEqual([]);
});
