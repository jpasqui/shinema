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
  };
  let completed = false;
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
    await route.fulfill({ json: startupCatalog() });
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
    await summary.pending;
    await route.fulfill({ json: { movies: 60, tv: 0, series: 0, total: 60 } });
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
    const beforeMount = await startupTrace(page);
    expect(beforeMount.samples.some((sample) => !sample.meaningful)).toBe(true);
    expect(beforeMount.samples.some((sample) => sample.meaningful)).toBe(false);
    phases.entryReleased = Date.now();
    entry.release();
    await expect
      .poll(() => calls.descriptors + calls.catalog)
      .toBeGreaterThan(0);
    await expect
      .poll(async () =>
        (await startupTrace(page)).samples.some((sample) => sample.meaningful),
      )
      .toBe(true);
    const held = await startupTrace(page);
    expect(
      held.samples.some(
        (sample) =>
          Object.keys(sample.anchors).filter((name) => /^slot\d+$/.test(name))
            .length >= (options.historical ? 3 : 12),
      ),
    ).toBe(true);
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
      await startupTrace(page);
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
          name: 'Open Generated movie 00000',
          exact: true,
        }),
      ).toBeVisible();
      if (options.retryDiscovery)
        await expect(page.locator('.section-heading')).toContainText(
          'Connected',
        );
      await expect.poll(() => calls.artwork).toBeGreaterThan(0);
      await startupTrace(page);
    } else {
      catalog.release();
      await expect(
        page.getByText('No libraries are visible.', { exact: false }),
      ).toBeVisible();
    }
    await expect.poll(() => calls.summary).toBeGreaterThan(0);
    await startupTrace(page);
    summary.release();
    await expect(page.locator('.page-title p')).toContainText(
      /60 movies.*0 episodes.*0 series/,
    );
    artwork.release();
    if (
      descriptorDocument.libraries.some((library) => library.visible) ||
      options.historical
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
    }).slice(0, 40),
  ).toEqual([]);
  expect(
    trace.shifts
      .filter((entry) => !entry.recentInput)
      .reduce((sum, entry) => sum + entry.value, 0),
  ).toBe(0);
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
