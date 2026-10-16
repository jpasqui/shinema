import type { Page, Route } from '@playwright/test';
import type { Media } from '../../../../packages/contracts/index.ts';
import { defaultLibraries } from '../../../../packages/contracts/index.ts';
import {
  archiveTheme,
  defaultTheme,
} from '../../../../packages/design-tokens/theme.ts';
import { test, expect, idFor, mediaFor } from './fixtures.ts';

type Skin = 'marquee' | 'archive';
type Box = { x: number; y: number; width: number; height: number };
type Geometry = Record<string, Box>;
type Shift = {
  value: number;
  hadRecentInput: boolean;
  startTime: number;
  sources: Array<{
    selector: string;
    nodeType: string;
    previous: Box;
    current: Box;
  }>;
};
declare global {
  interface Window {
    __shinemaShifts: { entries: Shift[]; observer: PerformanceObserver };
  }
}

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Every delay is explicitly released by the test; no network/timer sleeps. */
async function libraryMock(page: Page, total = 180) {
  const holds = new Map<string, ReturnType<typeof latch>>();
  const calls: Array<{
    key: string;
    offset: number;
    search: string;
    library: string | null;
    revision: string | null;
    done: boolean;
  }> = [];
  const failures = new Map<string, number>();
  const overlaps = new Set<string>();
  let rich = false;
  const item = (index: number, enriched = rich): Media => ({
    ...mediaFor(index),
    collection: 'movies',
    ...(enriched
      ? {
          title: `The Last Latitude ${index}: A Journey Beyond the Edge of the Known World`,
          summary:
            'A synthetic expedition follows a forgotten map across unfamiliar seas. The crew must find a vanished observatory before the winter closes every route home. Original fixture content only.',
          year: 2025,
          genres: ['Adventure', 'Science fiction'],
        }
      : {}),
    posterPath: `/api/media/${idFor(index)}/poster`,
    backdropPath: `/api/media/${idFor(index)}/backdrop`,
  });
  const keyFor = (url: URL) => {
    if (url.pathname === '/api/libraries') return 'descriptors';
    if (url.pathname === '/api/library') return 'summary';
    if (url.pathname === '/api/catalog' || url.pathname === '/api/series')
      return `${url.pathname === '/api/series' ? 'series' : 'catalog'}:${url.searchParams.get('library') ?? url.searchParams.get('collection') ?? 'movies'}:${url.searchParams.get('search') ?? ''}:${Number(url.searchParams.get('offset') ?? 0)}`;
    if (url.pathname.endsWith('/metadata')) return 'metadata';
    return 'images';
  };
  const handle = async (route: Route) => {
    const url = new URL(route.request().url());
    const key = keyFor(url);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const search = url.searchParams.get('search') ?? '';
    const library = url.searchParams.get('library');
    const revision = url.searchParams.get('revision');
    const call = { key, offset, search, library, revision, done: false };
    calls.push(call);
    await holds.get(key)?.promise;
    let body: unknown;
    let status = 200;
    if ((failures.get(key) ?? 0) > 0) {
      failures.set(key, failures.get(key)! - 1);
      status = 503;
      body = { error: 'Synthetic temporary disconnect' };
    } else if (key === 'descriptors') {
      body = { ...defaultLibraries(), revision: 1 };
    } else if (key === 'summary') {
      body =
        library === 'tv'
          ? { movies: 0, tv: 6, series: 3, total: 6 }
          : { movies: total, tv: 0, series: 0, total };
    } else if (key === 'metadata') {
      const index = Number.parseInt(url.pathname.split('/')[3], 16);
      body = { apiVersion: 1, items: [item(index, true)] };
    } else if (key === 'images') {
      const missing = url.pathname.includes(idFor(1));
      try {
        await route.fulfill({
          status: missing ? 404 : 200,
          contentType: missing ? 'text/plain' : 'image/svg+xml',
          body: missing
            ? ''
            : '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="360"><rect width="240" height="360" fill="#314739"/><circle cx="120" cy="120" r="60" fill="#b9c0b8"/></svg>',
        });
      } catch {
        /* Old query/navigation requests may already be aborted. */
      }
      call.done = true;
      return;
    } else {
      const isSeries = url.pathname === '/api/series';
      const count = search || isSeries ? 3 : total;
      const first = isSeries
        ? 90000
        : search === 'fresh'
          ? 10000
          : search === 'newer'
            ? 20000
            : search
              ? 30000
              : 0;
      const limit = Number(url.searchParams.get('limit') ?? 60);
      const length = Math.max(0, Math.min(limit, count - offset));
      body = {
        apiVersion: 1,
        fullLibrary: true,
        total: count,
        offset,
        limit,
        items: Array.from({ length }, (_, index) =>
          isSeries
            ? {
                id: idFor(first + offset + index),
                title: `Synthetic series ${first + offset + index}`,
                libraryId: 'tv',
                episodes: 2,
                seasons: 1,
              }
            : item(first + offset + index),
        ),
        nextOffset: offset + length < count ? offset + length : null,
      };
    }
    if (overlaps.delete(key) && offset > 0 && status === 200) {
      // Valid within this batch, invalid against the preceding retained batch.
      (body as { items: Media[] }).items[0] = item(offset - 1);
    }
    try {
      await route.fulfill({ status, json: body });
    } catch {
      /* A stale generation is allowed to cancel its transport. */
    }
    call.done = true;
  };
  await page.route('http://127.0.0.1:4187/api/catalog?**', handle);
  await page.route('http://127.0.0.1:4187/api/series?**', handle);
  await page.route('http://127.0.0.1:4187/api/libraries', handle);
  await page.route(
    /http:\/\/127\.0\.0\.1:4187\/api\/library(?:\?.*)?$/,
    handle,
  );
  await page.route(
    /http:\/\/127\.0\.0\.1:4187\/api\/media\/[a-f0-9]{64}\/(metadata|poster|backdrop)$/,
    handle,
  );
  return {
    calls,
    hold(key: string) {
      const gate = latch();
      holds.set(key, gate);
    },
    release(key: string) {
      holds.get(key)?.release();
      holds.delete(key);
    },
    releaseAll() {
      for (const gate of holds.values()) gate.release();
      holds.clear();
    },
    failNext(key: string) {
      failures.set(key, 1);
    },
    overlapNext(key: string) {
      overlaps.add(key);
    },
    enrich() {
      rich = true;
    },
    waitFor(key: string) {
      return expect
        .poll(() => calls.filter((call) => call.key === key).length)
        .toBeGreaterThan(0);
    },
  };
}

async function prepare(page: Page, skin: Skin, width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const theme = skin === 'archive' ? archiveTheme : defaultTheme;
  await page.addInitScript((theme) => {
    localStorage.setItem(
      'shinema.appearance.v1',
      JSON.stringify({ version: 1, theme, motion: 'reduced' }),
    );
    const entries: Shift[] = [];
    const sourceSelector = (node: Node | null | undefined) => {
      let element = node instanceof Element ? node : node?.parentElement;
      const parts: string[] = [];
      for (let depth = 0; element && depth < 6; depth++) {
        const id = element.getAttribute('id');
        const testId = element.getAttribute('data-testid');
        const classes = [...element.classList]
          .map((name) => `.${CSS.escape(name)}`)
          .join('');
        const siblings = element.parentElement
          ? [...element.parentElement.children].filter(
              (sibling) => sibling.localName === element!.localName,
            )
          : [];
        const position =
          siblings.length > 1
            ? `:nth-of-type(${siblings.indexOf(element) + 1})`
            : '';
        parts.unshift(
          `${element.localName}${id ? `#${CSS.escape(id)}` : testId ? `[data-testid=${JSON.stringify(testId)}]` : classes + position}`,
        );
        if (id || testId) break;
        element = element.parentElement;
      }
      return parts.join(' > ') || '<detached>';
    };
    const box = (rect: DOMRectReadOnly): Box => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
          sources?: Array<{
            node?: Node | null;
            previousRect: DOMRectReadOnly;
            currentRect: DOMRectReadOnly;
          }>;
        };
        entries.push({
          value: shift.value,
          hadRecentInput: shift.hadRecentInput,
          startTime: shift.startTime,
          sources: (shift.sources ?? []).map((source) => ({
            selector: sourceSelector(source.node),
            nodeType:
              source.node?.nodeType === Node.TEXT_NODE ? 'text' : 'element',
            previous: box(source.previousRect),
            current: box(source.currentRect),
          })),
        });
      }
    });
    observer.observe({ type: 'layout-shift', buffered: true });
    window.__shinemaShifts = { entries, observer };
  }, theme);
}

async function paint(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function resetShifts(page: Page) {
  await paint(page);
  await page.evaluate(() => {
    window.__shinemaShifts.observer.takeRecords();
    window.__shinemaShifts.entries.length = 0;
  });
}

async function shifts(page: Page) {
  await paint(page);
  return page.evaluate(() => {
    const entries = window.__shinemaShifts.entries;
    return {
      count: entries.length,
      raw: entries.reduce((sum, entry) => sum + entry.value, 0),
      cls: entries
        .filter((entry) => !entry.hadRecentInput)
        .reduce((sum, entry) => sum + entry.value, 0),
      entries,
    };
  });
}

async function expectNoLayoutShift(page: Page) {
  const report = await shifts(page);
  expect(
    report.cls,
    `Load-induced layout shifts, excluding recent input:\n${JSON.stringify(report, null, 2)}`,
  ).toBe(0);
}

async function snapshot(
  page: Page,
  selectors: Record<string, string>,
): Promise<Geometry> {
  await paint(page);
  return page.evaluate(
    (selectors) =>
      Object.fromEntries(
        Object.entries(selectors).map(([name, selector]) => {
          const node = document.querySelector(selector);
          if (!node) throw new Error(`Missing geometry anchor: ${name}`);
          const rect = node.getBoundingClientRect();
          return [
            name,
            {
              x: rect.x + scrollX,
              y: rect.y + scrollY,
              width: rect.width,
              height: rect.height,
            },
          ];
        }),
      ),
    selectors,
  );
}

function differences(before: Geometry, after: Geometry) {
  return Object.entries(before).flatMap(([name, rect]) =>
    (['x', 'y', 'width', 'height'] as const)
      .filter((key) => Math.abs(rect[key] - after[name][key]) > 1)
      .map((key) => `${name}.${key}: ${rect[key]} → ${after[name][key]}`),
  );
}

const navigationAnchors = {
  brand: '.brand',
  header: '.header',
  navigation: '.top-navigation',
  navigationItems: '.top-navigation-items',
  navigationPrimary: '.top-navigation-items > button',
  navigationSettings: '.navigation-settings-button',
};

const shell = {
  ...navigationAnchors,
  feature: '[aria-label="Featured title"]',
  title: '.full-library .page-title',
  toolbar: '.browse-toolbar',
  search: '#library-search',
  searchAction: '.browse-toolbar button[type="submit"]',
  refresh: '.browse-toolbar > button',
  heading: '.library-section .section-heading',
  card: '[data-testid="library-feed"] .media-card',
  poster: '[data-testid="library-feed"] .media-card .poster',
  cardTitle: '[data-testid="library-feed"] .media-card h3',
  cardMeta: '[data-testid="library-feed"] .media-card .card-copy > span',
};

function featureSlots(skin: Skin) {
  return skin === 'marquee'
    ? {
        featureTitle: '.feature-copy h2',
        featureMeta: '.feature-meta',
        featureSummary: '.hero-summary',
        featureAction: '.feature-copy button',
      }
    : {
        featureTitle: '.programme-copy h2',
        featureMeta: '.programme-meta',
        featureSummary: '.programme-summary',
        featureAction: '.programme-copy button',
      };
}

async function visibleIds(page: Page) {
  return page
    .locator('[data-browse-id]')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-browse-id')!),
    );
}

function datasetProblems(ids: string[], allowed: Set<string>) {
  return [
    ...(ids.length ? [] : ['empty']),
    ...(new Set(ids).size === ids.length ? [] : ['duplicate']),
    ...(ids.some((id, index) => index > 0 && id < ids[index - 1])
      ? ['order']
      : []),
    ...ids.filter((id) => !allowed.has(id)).map(() => 'stale'),
  ];
}

async function appendEdge(page: Page) {
  await page.getByTestId('library-sentinel').scrollIntoViewIfNeeded();
  // A genuine scroll change re-arms the edge without synthetic observer events.
  await page.mouse.wheel(0, 2);
}

test.afterEach(async ({ api }) => {
  expect(api.blockedRequests).toEqual([]);
});

for (const skin of ['marquee', 'archive'] as const) {
  for (const width of [390, 1280]) {
    test(`${skin} ${width}: cold shell, delayed artwork/summary and late local font keep reserved geometry`, async ({
      page,
      api,
    }) => {
      api.total = 60;
      const mock = await libraryMock(page, 60);
      for (const key of [
        'descriptors',
        'catalog:movies::0',
        'summary',
        'images',
      ])
        mock.hold(key);
      try {
        await prepare(page, skin, width);
        await page.goto('/');
        await mock.waitFor('descriptors');
        await expect(
          page.getByRole('navigation', {
            name: 'Main navigation',
            exact: true,
          }),
        ).toBeVisible();
        const descriptorPending = await snapshot(page, navigationAnchors);
        expect(
          mock.calls.filter(
            (call) =>
              call.key.startsWith('catalog:') || call.key.startsWith('series:'),
          ),
        ).toHaveLength(0);
        await resetShifts(page);
        mock.release('descriptors');
        await mock.waitFor('catalog:movies::0');
        expect(
          mock.calls
            .filter((call) => call.key.startsWith('catalog:'))
            .every(
              (call) => call.library === 'movies' && call.revision === '1',
            ),
        ).toBe(true);
        await expect(page.getByTestId('library-feed')).toBeVisible();
        expect(
          differences(
            descriptorPending,
            await snapshot(page, navigationAnchors),
          ),
        ).toEqual([]);
        const anchors = { ...shell, ...featureSlots(skin) };
        const loading = await snapshot(page, anchors);
        mock.release('catalog:movies::0');
        await expect(
          page.locator(`[data-browse-id="${idFor(0)}"]`),
        ).toBeVisible();
        await mock.waitFor('images');
        expect(differences(loading, await snapshot(page, anchors))).toEqual([]);
        mock.release('summary');
        await expect(page.locator('.full-library .page-title p')).toContainText(
          '60',
        );
        expect(differences(loading, await snapshot(page, anchors))).toEqual([]);
        mock.release('images');
        await expect(
          page.locator(`[data-browse-id="${idFor(0)}"] img`),
        ).toHaveClass('artwork-loaded');
        await expect(
          page.locator(`[data-browse-id="${idFor(1)}"] .poster-unavailable`),
        ).toBeVisible();
        expect(differences(loading, await snapshot(page, anchors))).toEqual([]);

        // Production has no downloaded font. Publish a delayed local face with
        // wider glyph metrics to exercise the same late-font layout boundary.
        await page.evaluate(async () => {
          const face = new FontFace(
            'DelayedFixture',
            'local("Arial"), local("Liberation Sans"), local("DejaVu Sans"), local("Segoe UI")',
            { sizeAdjust: '130%' } as FontFaceDescriptors & {
              sizeAdjust: string;
            },
          );
          await face.load();
          document.fonts.add(face);
          document.documentElement.style.setProperty(
            '--font-ui',
            'DelayedFixture, sans-serif',
          );
          document.documentElement.style.setProperty(
            '--font-display',
            'DelayedFixture, sans-serif',
          );
          await document.fonts.ready;
        });
        expect(differences(loading, await snapshot(page, anchors))).toEqual([]);
        await expectNoLayoutShift(page);
      } finally {
        mock.releaseAll();
      }
    });

    test(`${skin} ${width}: late detail metadata and failed artwork do not move text or playback controls`, async ({
      page,
      api,
    }) => {
      api.total = 3;
      const mock = await libraryMock(page, 3);
      mock.hold('metadata');
      mock.hold('images');
      try {
        await prepare(page, skin, width);
        await page.goto('/');
        const card = page.locator(`[data-browse-id="${idFor(1)}"]`);
        await expect(card).toBeVisible();
        await card.evaluate((node: HTMLButtonElement) => node.click());
        await mock.waitFor('metadata');
        const anchors = {
          title: '.detail-copy h1',
          metadata: '.detail-copy .metadata',
          description: '.detail-copy .description',
          play: '.detail-copy .primary',
          artwork:
            skin === 'marquee' ? '.detail-backdrop' : '.detail-layout .poster',
          back: '.detail > .back-button',
        };
        const waiting = await snapshot(page, anchors);
        await resetShifts(page);
        mock.release('metadata');
        await expect(page.locator('.detail-copy h1')).toContainText(
          'The Last Latitude',
        );
        expect(differences(waiting, await snapshot(page, anchors))).toEqual([]);
        mock.release('images');
        const artwork = page.locator(
          skin === 'marquee' ? '.detail-backdrop' : '.detail-layout .poster',
        );
        await expect(artwork).toHaveAttribute('data-artwork-state', 'failed');
        if (skin === 'archive')
          await expect(artwork.locator('.poster-unavailable')).toBeVisible();
        else await expect(artwork).toBeVisible();
        expect(differences(waiting, await snapshot(page, anchors))).toEqual([]);
        await expectNoLayoutShift(page);
      } finally {
        mock.releaseAll();
      }
    });
  }

  test(`${skin}: lazy append retains focused row geometry, scroll and identity without duplicate or stationary refetch`, async ({
    page,
    api,
  }) => {
    api.total = 1200;
    const mock = await libraryMock(page, 1200);
    mock.hold('catalog:movies::60');
    try {
      await prepare(page, skin);
      await page.goto('/');
      await expect(
        page.locator(`[data-browse-id="${idFor(0)}"]`),
      ).toBeVisible();
      await appendEdge(page);
      await mock.waitFor('catalog:movies::60');
      const anchor = page.locator(`[data-browse-id="${idFor(59)}"]`);
      await anchor.focus();
      const original = await anchor.elementHandle();
      const selector = { selected: `[data-browse-id="${idFor(59)}"]` };
      const before = await snapshot(page, selector);
      for (let trigger = 0; trigger < 4; trigger++)
        await page.mouse.wheel(0, 1);
      await paint(page);
      const scroll = await page.evaluate(() => scrollY);
      expect(
        mock.calls.filter((call) => call.key === 'catalog:movies::60'),
      ).toHaveLength(1);
      mock.release('catalog:movies::60');
      await expect(
        page.locator(`[data-browse-id="${idFor(60)}"]`),
      ).toBeAttached();
      await expect(anchor).toBeFocused();
      expect(
        await anchor.evaluate((node, previous) => node === previous, original!),
      ).toBe(true);
      expect(differences(before, await snapshot(page, selector))).toEqual([]);
      expect(await page.evaluate(() => scrollY)).toBeCloseTo(scroll, 0);
      await paint(page);
      expect(
        mock.calls.filter((call) => call.key === 'catalog:movies::120'),
      ).toHaveLength(0);
      expect(
        datasetProblems(
          await visibleIds(page),
          new Set(Array.from({ length: 120 }, (_, index) => idFor(index))),
        ),
      ).toEqual([]);
      await expect(
        page.getByRole('button', { name: /Next page|Previous page/ }),
      ).toHaveCount(0);
      for (const offset of [120, 180, 240, 300]) {
        await appendEdge(page);
        await mock.waitFor(`catalog:movies::${offset}`);
        await expect(
          page.locator(`[data-browse-id="${idFor(offset)}"]`),
        ).toBeAttached();
        const ids = await visibleIds(page);
        expect(ids.length).toBeLessThanOrEqual(120);
        expect(
          datasetProblems(
            ids,
            new Set(
              Array.from({ length: offset + 60 }, (_, index) => idFor(index)),
            ),
          ),
        ).toEqual([]);
      }
      await original!.dispose();
    } finally {
      mock.releaseAll();
    }
  });

  test(`${skin}: query and collection changes discard delayed old append/search results`, async ({
    page,
    api,
  }) => {
    api.total = 180;
    const mock = await libraryMock(page);
    mock.hold('catalog:movies::60');
    mock.hold('catalog:movies:slow:0');
    try {
      await prepare(page, skin);
      await page.goto('/');
      await expect(
        page.locator(`[data-browse-id="${idFor(0)}"]`),
      ).toBeVisible();
      await appendEdge(page);
      await mock.waitFor('catalog:movies::60');
      const search = page.getByLabel('Search titles', { exact: true });
      await search.fill('fresh');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(
        page.locator(`[data-browse-id="${idFor(10000)}"]`),
      ).toBeVisible();
      mock.release('catalog:movies::60');
      await expect
        .poll(() =>
          mock.calls
            .filter((call) => call.key === 'catalog:movies::60')
            .every((call) => call.done),
        )
        .toBe(true);
      expect(await visibleIds(page)).toEqual([10000, 10001, 10002].map(idFor));
      await search.fill('slow');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await mock.waitFor('catalog:movies:slow:0');
      await search.fill('newer');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(
        page.locator(`[data-browse-id="${idFor(20000)}"]`),
      ).toBeVisible();
      await page.getByRole('button', { name: 'TV shows', exact: true }).click();
      await expect(
        page.locator(`[data-browse-id="${idFor(90000)}"]`),
      ).toBeVisible();
      mock.release('catalog:movies:slow:0');
      await expect
        .poll(() =>
          mock.calls
            .filter((call) => call.key === 'catalog:movies:slow:0')
            .every((call) => call.done),
        )
        .toBe(true);
      expect(await visibleIds(page)).toEqual([90000, 90001, 90002].map(idFor));
      await expect(
        page.getByRole('heading', { name: 'TV shows', exact: true }),
      ).toBeVisible();
      expect(
        mock.calls
          .filter((call) => call.key.startsWith('series:'))
          .every((call) => call.library === 'tv' && call.revision === '1'),
      ).toBe(true);
    } finally {
      mock.releaseAll();
    }
  });

  test(`${skin}: append failure/retry reserves status space and resize does not duplicate rows`, async ({
    page,
    api,
  }) => {
    api.total = 180;
    const mock = await libraryMock(page);
    mock.hold('catalog:movies::60');
    mock.failNext('catalog:movies::60');
    try {
      await prepare(page, skin, 390);
      await page.goto('/');
      await expect(
        page.locator(`[data-browse-id="${idFor(0)}"]`),
      ).toBeVisible();
      await appendEdge(page);
      await mock.waitFor('catalog:movies::60');
      const last = page.locator(`[data-browse-id="${idFor(59)}"]`);
      await last.focus();
      const selector = {
        card: `[data-browse-id="${idFor(59)}"]`,
        tail: '.browse-tail',
      };
      const before = await snapshot(page, selector);
      mock.release('catalog:movies::60');
      const retry = page.getByRole('button', {
        name: 'Retry loading',
        exact: true,
      });
      await expect(retry).toBeVisible();
      await expect(last).toBeFocused();
      expect(differences(before, await snapshot(page, selector))).toEqual([]);
      mock.hold('catalog:movies::60');
      mock.failNext('catalog:movies::60');
      const columns = await page
        .getByTestId('library-feed')
        .evaluate(
          (node) =>
            getComputedStyle(node).gridTemplateColumns.split(' ').length,
        );
      await page.keyboard.down('ArrowDown');
      await expect
        .poll(
          () =>
            mock.calls.filter((call) => call.key === 'catalog:movies::60')
              .length,
        )
        .toBe(2);
      await expect(last).toBeFocused();
      mock.release('catalog:movies::60');
      await expect(retry).toBeVisible();
      await expect(last).toBeFocused();
      // An auto-repeating held remote key must not hammer a failed boundary.
      await page.keyboard.down('ArrowDown');
      await page.keyboard.down('ArrowDown');
      await paint(page);
      expect(
        mock.calls.filter((call) => call.key === 'catalog:movies::60'),
      ).toHaveLength(2);
      await page.keyboard.up('ArrowDown');
      mock.hold('catalog:movies::60');
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(
          () =>
            mock.calls.filter((call) => call.key === 'catalog:movies::60')
              .length,
        )
        .toBe(3);
      await expect(last).toBeFocused();
      mock.release('catalog:movies::60');
      await expect(
        page.locator(`[data-browse-id="${idFor(60)}"]`),
      ).toBeAttached();
      await expect(
        page.locator(`[data-browse-id="${idFor(59 + columns)}"]`),
      ).toBeFocused();
      await expect(retry).toHaveCount(0);
      mock.hold('catalog:movies::120');
      await page.setViewportSize({ width: 1100, height: 900 });
      await paint(page);
      mock.overlapNext('catalog:movies::120');
      await appendEdge(page);
      await mock.waitFor('catalog:movies::120');
      const resizedAnchor = page.locator(`[data-browse-id="${idFor(119)}"]`);
      await resizedAnchor.focus();
      const resizedSelector = { card: `[data-browse-id="${idFor(119)}"]` };
      const resized = await snapshot(page, resizedSelector);
      const resizedScroll = await page.evaluate(() => scrollY);
      mock.release('catalog:movies::120');
      await expect(retry).toBeVisible();
      expect(
        differences(resized, await snapshot(page, resizedSelector)),
      ).toEqual([]);
      expect(
        datasetProblems(
          await visibleIds(page),
          new Set(Array.from({ length: 120 }, (_, index) => idFor(index))),
        ),
      ).toEqual([]);
      await retry.evaluate((node: HTMLButtonElement) => node.click());
      await expect(
        page.locator(`[data-browse-id="${idFor(120)}"]`),
      ).toBeAttached();
      await expect(resizedAnchor).toBeFocused();
      expect(
        differences(resized, await snapshot(page, resizedSelector)),
      ).toEqual([]);
      expect(await page.evaluate(() => scrollY)).toBeCloseTo(resizedScroll, 0);
      const ids = await visibleIds(page);
      expect(ids.length).toBeLessThanOrEqual(120);
      expect(
        datasetProblems(
          ids,
          new Set(Array.from({ length: 180 }, (_, index) => idFor(index))),
        ),
      ).toEqual([]);
      expect(
        mock.calls.filter((call) => call.key === 'catalog:movies::60'),
      ).toHaveLength(3);
    } finally {
      mock.releaseAll();
    }
  });
}

test('negative controls prove geometry/CLS and duplicate/stale dataset oracles detect broken reservation', async ({
  page,
  api,
}) => {
  api.total = 60;
  const mock = await libraryMock(page, 60);
  mock.hold('catalog:movies::0');
  try {
    await prepare(page, 'marquee');
    await page.goto('/');
    await mock.waitFor('catalog:movies::0');
    await expect(page.getByTestId('library-feed')).toBeVisible();
    // Deliberately remove the empty poster's reserved space, leaving loaded
    // posters untouched. The same sampler used above must reject this defect.
    await page.addStyleTag({
      content:
        '[data-testid="library-feed"][aria-busy="true"] .poster, [data-testid="library-feed"][aria-busy="true"] .skeleton { aspect-ratio: auto !important; height: 0 !important; min-height: 0 !important; }',
    });
    await expect(
      page.locator('[data-testid="library-feed"] .poster').first(),
    ).toHaveCSS('height', '0px');
    const before = await snapshot(page, shell);
    await resetShifts(page);
    mock.release('catalog:movies::0');
    await expect(page.locator(`[data-browse-id="${idFor(0)}"]`)).toBeVisible();
    expect(
      differences(before, await snapshot(page, shell)).length,
    ).toBeGreaterThan(0);
    // The broken poster can be below the fold, where CLS correctly ignores
    // movement. Independently calibrate the observer with a visible, ordinary
    // flow displacement so a disconnected observer cannot pass this suite.
    const brand = page.locator('.brand');
    await expect(brand).toBeInViewport({ ratio: 1 });
    const visibleBefore = await snapshot(page, { brand: '.brand' });
    await resetShifts(page);
    await page.addStyleTag({
      content: '.header { margin-top: 32px !important; }',
    });
    const visibleAfter = await snapshot(page, { brand: '.brand' });
    expect(
      Math.abs(visibleAfter.brand.y - visibleBefore.brand.y),
    ).toBeGreaterThan(8);
    const induced = await shifts(page);
    expect(induced.raw, JSON.stringify(induced, null, 2)).toBeGreaterThan(0);
    const allowed = new Set(
      Array.from({ length: 60 }, (_, index) => idFor(index)),
    );
    expect(datasetProblems(await visibleIds(page), allowed)).toEqual([]);
    await page
      .locator('[data-browse-id]')
      .first()
      .evaluate((node) => node.after(node.cloneNode(true)));
    expect(datasetProblems(await visibleIds(page), allowed)).toContain(
      'duplicate',
    );
    await page
      .locator('[data-browse-id]')
      .first()
      .evaluate((node) => {
        const clone = node.cloneNode(true) as HTMLElement;
        clone.dataset.browseId = 'f'.repeat(64);
        node.after(clone);
      });
    expect(datasetProblems(await visibleIds(page), allowed)).toContain('stale');
  } finally {
    mock.releaseAll();
  }
});
