import type { Page } from '@playwright/test';
import {
  test,
  expect,
  idFor,
  openMovie,
  pauseDecoded,
  revealMovie,
} from './fixtures.ts';
import type { SyntheticApi } from './fixtures.ts';

// Structural ceilings, not wall-clock targets. This suite uses the Vite dev
// server: React.StrictMode repeats summary and library-discovery mount effects.
// The lazy feed shares its initial in-flight catalogue request. These ceilings
// allow future reductions; they are not production request-count guarantees.
const initialBrowseBudget = {
  mountedCards: 60,
  catalogLimit: 60,
  invalidLimits: 0,
  catalogRequests: 1,
  summaryRequests: 2,
  descriptorRequests: 2,
  totalApiRequests: 5,
  unrequestedPages: 0,
  mediaRequests: 0,
  externalRequests: 0,
} as const;
// Two complete batches may coexist; after a third loads, virtualization must
// keep the mounted set bounded independently of the accumulated loaded extent.
const appendedBrowseBudget = {
  ...initialBrowseBudget,
  mountedCards: 120,
  catalogRequests: 2,
  totalApiRequests: 6,
} as const;
const virtualizedBrowseBudget = {
  ...appendedBrowseBudget,
  catalogRequests: 3,
  totalApiRequests: 7,
} as const;
const playbackBudget = {
  playbackDescriptors: 2,
  otherTitles: 0,
  externalRequests: 0,
} as const;

function enforceBudgets(
  measured: Record<string, number>,
  budgets: Readonly<Record<string, number>>,
) {
  for (const [name, maximum] of Object.entries(budgets)) {
    const value = measured[name];
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
      throw new Error(`${name} budget exceeded: ${value}; maximum ${maximum}`);
  }
}

declare global {
  interface Window {
    __shinemaMaxMountedCards: number;
  }
}

async function observeMountedCards(page: Page) {
  await page.addInitScript(() => {
    window.__shinemaMaxMountedCards = 0;
    const sample = () => {
      // Include offscreen and hidden nodes: keeping an old page mounted still
      // consumes resources even if its cards are no longer visible.
      window.__shinemaMaxMountedCards = Math.max(
        window.__shinemaMaxMountedCards,
        document.querySelectorAll(
          '[data-testid="library-feed"] [data-browse-slot]',
        ).length,
      );
    };
    new MutationObserver(sample).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-browse-slot'],
    });
  });
}

async function browseCounts(
  page: Page,
  api: SyntheticApi,
  requestedOffsets: readonly number[],
) {
  const catalog = api.requests
    .map((path) => new URL(path, 'http://fixture.invalid'))
    .filter((url) => url.pathname === '/api/catalog');
  const limits = catalog.map((url) => Number(url.searchParams.get('limit')));
  return {
    mountedCards: await page.evaluate(() => window.__shinemaMaxMountedCards),
    catalogLimit: Math.max(0, ...limits),
    invalidLimits: limits.filter(
      (limit) => !Number.isSafeInteger(limit) || limit <= 0,
    ).length,
    catalogRequests: catalog.length,
    summaryRequests: api.requests.filter((path) => path === '/api/library')
      .length,
    descriptorRequests: api.requests.filter((path) => path === '/api/libraries')
      .length,
    totalApiRequests: api.requests.length,
    unrequestedPages: catalog.filter(
      (url) =>
        !requestedOffsets.includes(
          Number(url.searchParams.get('offset') ?? 0),
        ) ||
        !!url.searchParams.get('search') ||
        url.searchParams.get('collection') !== 'movies' ||
        url.searchParams.get('library') !== 'movies' ||
        url.searchParams.get('revision') !== '1',
    ).length,
    mediaRequests: api.requests.filter((path) => path.startsWith('/api/media/'))
      .length,
    externalRequests: api.blockedRequests.length,
  };
}

test('resource budget enforcement rejects every exceeded ceiling and invalid measurement', () => {
  for (const budget of [
    initialBrowseBudget,
    appendedBrowseBudget,
    virtualizedBrowseBudget,
    playbackBudget,
  ]) {
    enforceBudgets(budget, budget);
    for (const [name, maximum] of Object.entries(budget)) {
      expect(() =>
        enforceBudgets({ ...budget, [name]: maximum + 1 }, budget),
      ).toThrow(`${name} budget exceeded`);
    }
  }
  for (const invalid of [NaN, Infinity, -1, 0.5]) {
    expect(() =>
      enforceBudgets(
        { ...initialBrowseBudget, mountedCards: invalid },
        initialBrowseBudget,
      ),
    ).toThrow('mountedCards budget exceeded');
  }
  expect(() => enforceBudgets({}, initialBrowseBudget)).toThrow(
    'mountedCards budget exceeded',
  );
});

test('10,001-title lazy first/append/back browsing stays within card and request budgets', async ({
  page,
  api,
}) => {
  api.total = 10001;
  await observeMountedCards(page);
  await page.clock.install();
  await page.goto('/');
  const feed = page.getByTestId('library-feed');
  const slots = feed.locator('[data-browse-slot]');
  await expect(slots).toHaveCount(60);
  await expect(feed).toHaveAttribute('data-loaded-count', '60');
  await expect(page.getByText(/10,001 movies/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Next page|Previous page/ }),
  ).toHaveCount(0);
  // Advance logical time to expose accidental background polling/prefetch.
  // No elapsed-time assertion or host-speed assumption is involved.
  await page.clock.fastForward(60_000);
  enforceBudgets(await browseCounts(page, api, [0]), initialBrowseBudget);

  await revealMovie(page, 61);
  await expect(feed).toHaveAttribute('data-loaded-count', '120');
  await expect(slots).toHaveCount(120);
  await page.clock.fastForward(60_000);
  enforceBudgets(await browseCounts(page, api, [0, 60]), appendedBrowseBudget);

  // Crossing a third batch proves old offscreen cards are unmounted rather
  // than accumulating one complete DOM page for every scroll gesture.
  await revealMovie(page, 121);
  await expect(feed).toHaveAttribute('data-loaded-count', '180');
  expect(await slots.count()).toBeLessThanOrEqual(120);
  await page.clock.fastForward(60_000);
  enforceBudgets(
    await browseCounts(page, api, [0, 60, 120]),
    virtualizedBrowseBudget,
  );

  await revealMovie(page, 0);
  await expect(feed).toHaveAttribute('data-loaded-count', '180');
  expect(await slots.count()).toBeLessThanOrEqual(120);
  await page.clock.fastForward(60_000);
  // The first batches remain retained; moving back needs no catalogue call.
  enforceBudgets(
    await browseCounts(page, api, [0, 60, 120]),
    virtualizedBrowseBudget,
  );
});

test('opening one title bounds StrictMode playback descriptors to that title', async ({
  page,
  api,
}) => {
  api.total = 10001;
  await page.goto('/');
  await revealMovie(page, 61);
  await openMovie(page, 61);
  await pauseDecoded(page);
  const selectedPath = `/api/media/${idFor(61)}/`;
  const descriptors = api.requests.filter((path) => path.endsWith('/playback'));
  expect(descriptors.length).toBeGreaterThan(0);
  expect(new Set(descriptors)).toEqual(new Set([`${selectedPath}playback`]));
  enforceBudgets(
    {
      playbackDescriptors: descriptors.length,
      otherTitles: api.requests.filter(
        (path) =>
          path.startsWith('/api/media/') && !path.startsWith(selectedPath),
      ).length,
      externalRequests: api.blockedRequests.length,
    },
    playbackBudget,
  );
});
