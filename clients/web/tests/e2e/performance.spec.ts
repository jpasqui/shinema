import type { Page } from '@playwright/test';
import {
  test,
  expect,
  idFor,
  mediaFor,
  openMovie,
  pauseDecoded,
} from './fixtures.ts';
import type { SyntheticApi } from './fixtures.ts';

// Structural ceilings, not wall-clock targets. This suite uses the Vite dev
// server: React.StrictMode repeats mount effects. Bootstrap and LibraryBrowser
// each fetch twice. These ceilings allow current development behavior and allow
// future reductions; they are not production request-count guarantees.
const initialBrowseBudget = {
  mountedCards: 60,
  catalogLimit: 60,
  invalidLimits: 0,
  catalogRequests: 4,
  summaryRequests: 2,
  totalApiRequests: 6,
  unrequestedPages: 0,
  mediaRequests: 0,
  externalRequests: 0,
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
        document.querySelectorAll('button[aria-label^="Open Generated movie"]')
          .length,
      );
    };
    new MutationObserver(sample).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-label'],
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
    totalApiRequests: api.requests.length,
    unrequestedPages: catalog.filter(
      (url) =>
        !requestedOffsets.includes(
          Number(url.searchParams.get('offset') ?? 0),
        ) ||
        !!url.searchParams.get('search') ||
        url.searchParams.get('collection') !== 'movies',
    ).length,
    mediaRequests: api.requests.filter((path) => path.startsWith('/api/media/'))
      .length,
    externalRequests: api.blockedRequests.length,
  };
}

test('resource budget enforcement rejects every exceeded ceiling and invalid measurement', () => {
  for (const budget of [initialBrowseBudget, playbackBudget]) {
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

test('10,001-title first/next/back browsing stays within card and request budgets', async ({
  page,
  api,
}) => {
  api.total = 10001;
  await observeMountedCards(page);
  await page.clock.install();
  await page.goto('/');
  const cards = page.getByRole('button', {
    name: /^Open Generated movie/,
    includeHidden: true,
  });
  await expect(cards).toHaveCount(60);
  await expect(page.getByText(/10,001 movies/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Next page', exact: true }),
  ).toBeEnabled();
  // Advance logical time to expose accidental background polling/prefetch.
  // No elapsed-time assertion or host-speed assumption is involved.
  await page.clock.fastForward(60_000);
  enforceBudgets(await browseCounts(page, api, [0]), initialBrowseBudget);

  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(
    page.getByRole('button', {
      name: `Open ${mediaFor(60).title}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(cards).toHaveCount(60);
  await expect(
    page.getByRole('button', { name: 'Previous page', exact: true }),
  ).toBeEnabled();
  await page.clock.fastForward(60_000);
  enforceBudgets(await browseCounts(page, api, [0, 60]), {
    ...initialBrowseBudget,
    catalogRequests: 5,
    totalApiRequests: 7,
  });

  await page
    .getByRole('button', { name: 'Previous page', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: `Open ${mediaFor(0).title}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(cards).toHaveCount(60);
  await expect(
    page.getByRole('button', { name: 'Next page', exact: true }),
  ).toBeEnabled();
  await page.clock.fastForward(60_000);
  enforceBudgets(await browseCounts(page, api, [0, 60]), {
    ...initialBrowseBudget,
    catalogRequests: 6,
    totalApiRequests: 8,
  });
});

test('opening one title bounds StrictMode playback descriptors to that title', async ({
  page,
  api,
}) => {
  api.total = 10001;
  await page.goto('/');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
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
