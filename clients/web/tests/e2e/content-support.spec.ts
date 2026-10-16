import type { Page } from '@playwright/test';
import {
  builtinContentRegistry,
  defaultLibraries,
} from '../../../../packages/contracts/index.ts';
import type { Libraries } from '../../../../packages/contracts/index.ts';
import {
  archiveTheme,
  defaultTheme,
} from '../../../../packages/design-tokens/theme.ts';
import { test, expect, idFor, mediaFor } from './fixtures.ts';

type Skin = 'marquee' | 'archive';
declare global {
  interface Window {
    __shinemaSupportVideoMounts: number;
  }
}

const savedProgress = { positionSeconds: 24, durationSeconds: 90 };
const musicId = 'audio-shelf';
function documentFixture(): Libraries {
  const registry = builtinContentRegistry();
  registry.contentTypes.push({
    id: 'music',
    name: 'Music',
    availability: 'available',
    capabilities: { metadata: true, play: true, view: true, launch: true },
  });
  registry.formats.push({
    id: 'future-video',
    name: 'Future video',
    availability: 'available',
    capabilities: { metadata: true, play: true, view: true, launch: true },
    extensions: ['future-video'],
    mimeTypes: ['video/x-future'],
  });
  return {
    ...defaultLibraries(),
    revision: 4,
    registry,
    libraries: [
      ...defaultLibraries().libraries,
      {
        id: musicId,
        name: 'Music',
        mediaType: 'music',
        contentTypeId: 'music',
        visible: true,
        order: 2,
      },
    ],
  };
}

async function prepare(page: Page, skin: Skin) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(
    ({ theme, progress, id }) => {
      localStorage.setItem(
        'shinema.appearance.v1',
        JSON.stringify({
          version: 1,
          theme,
          motion: 'reduced',
        }),
      );
      localStorage.setItem(
        'shinema.web.cache.v1',
        JSON.stringify({
          catalog: null,
          progress: { [id]: progress },
          pending: {},
        }),
      );
      window.__shinemaSupportVideoMounts = 0;
      new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes) {
            if (node instanceof Element) {
              window.__shinemaSupportVideoMounts +=
                Number(node.matches('video')) +
                node.querySelectorAll('video').length;
            }
          }
      }).observe(document, { childList: true, subtree: true });
    },
    {
      theme: skin === 'archive' ? archiveTheme : defaultTheme,
      progress: savedProgress,
      id: idFor(0),
    },
  );
}

async function mockDocument(page: Page) {
  const document = { current: documentFixture() };
  await page.route('http://127.0.0.1:4187/api/libraries', (route) =>
    route.fulfill({ json: document.current }),
  );
  await page.route('http://127.0.0.1:4187/api/content-registry', (route) =>
    route.fulfill({ json: document.current.registry }),
  );
  return document;
}

function observe(page: Page) {
  const requests: Array<{
    path: string;
    library: string | null;
    method: string;
  }> = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/'))
      requests.push({
        path: url.pathname,
        library: url.searchParams.get('library'),
        method: request.method(),
      });
  });
  return requests;
}

async function paint(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function expectNoPlayer(page: Page) {
  await paint(page);
  await expect(page.locator('video')).toHaveCount(0);
  expect(await page.evaluate(() => window.__shinemaSupportVideoMounts)).toBe(0);
}

async function expectSavedProgress(page: Page) {
  expect(
    await page.evaluate((id) => {
      const cache = JSON.parse(localStorage.getItem('shinema.web.cache.v1')!);
      return { progress: cache.progress[id], pending: cache.pending };
    }, idFor(0)),
  ).toEqual({ progress: savedProgress, pending: {} });
}

test.afterEach(async ({ api }) => {
  expect(api.blockedRequests).toEqual([]);
});

for (const skin of ['marquee', 'archive'] as const) {
  test(`${skin}: an advertised Music type keeps its canonical selection without inventing a client handler`, async ({
    page,
    api,
  }) => {
    api.total = 1;
    await prepare(page, skin);
    const document = await mockDocument(page);
    const requests = observe(page);
    await page.goto('/');
    await expect(page.locator(`[data-browse-id="${idFor(0)}"]`)).toBeVisible();
    const collections = page.getByRole('navigation', {
      name: 'Collections',
      exact: true,
    });
    const beforeMusic = requests.length;
    await collections
      .getByRole('button', { name: 'Music', exact: true })
      .click();
    const unavailable = page.getByRole('region', {
      name: 'Unsupported library',
      exact: true,
    });
    await expect(unavailable).toBeVisible();
    await expect(page.locator('[data-browse-id]')).toHaveCount(0);
    await expect(unavailable).toContainText(
      'This client has no playback handler for content type “Music”.',
    );
    await expect(
      collections.getByRole('button', { name: 'Music', exact: true }),
    ).toHaveClass(/\bactive\b/);
    await expect(
      page.getByLabel('Search titles', { exact: true }),
    ).toBeDisabled();

    document.current.revision++;
    document.current.libraries.find((library) => library.id === musicId)!.name =
      'Listening room';
    await page.evaluate(() =>
      window.dispatchEvent(new Event('shinema:libraries-refresh')),
    );
    await expect(
      page.getByRole('heading', {
        name: 'Listening room',
        level: 1,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      collections.getByRole('button', { name: 'Listening room', exact: true }),
    ).toHaveClass(/\bactive\b/);
    await expect(unavailable).toBeVisible();
    expect(
      await page.evaluate(
        (id) =>
          JSON.parse(
            localStorage.getItem('shinema.web.libraries.v1')!,
          ).libraries.find((library: { id: string }) => library.id === id)
            .contentTypeId,
        musicId,
      ),
    ).toBe('music');
    expect(
      requests.filter(
        (request) =>
          ['/api/catalog', '/api/series'].includes(request.path) &&
          request.library === musicId,
      ),
    ).toEqual([]);
    expect(
      requests
        .slice(beforeMusic)
        .filter((request) =>
          ['/api/catalog', '/api/series'].includes(request.path),
        ),
    ).toEqual([]);
    expect(
      requests.filter((request) =>
        /\/api\/media\/[^/]+\/(?:progress|playback|stream|hls)(?:\/|$)/.test(
          request.path,
        ),
      ),
    ).toEqual([]);
    await expectNoPlayer(page);
    await collections
      .getByRole('button', { name: 'Movies', exact: true })
      .click();
    await expect(page.locator(`[data-browse-id="${idFor(0)}"]`)).toBeVisible();
  });

  test(`${skin}: an advertised unknown format retains its card and progress while card and feature activation stay blocked`, async ({
    page,
    api,
  }) => {
    await prepare(page, skin);
    await mockDocument(page);
    const requests = observe(page);
    await page.route('http://127.0.0.1:4187/api/catalog?**', (route) =>
      route.fulfill({
        json: {
          apiVersion: 1,
          fullLibrary: true,
          total: 1,
          offset: 0,
          limit: 60,
          nextOffset: null,
          items: [
            {
              ...mediaFor(0),
              contentTypeId: 'movies',
              formatId: 'future-video',
              container: 'future-video',
            },
          ],
        },
      }),
    );
    await page.goto('/');
    const card = page.locator(`[data-browse-id="${idFor(0)}"]`);
    await expect(card).toHaveAttribute('aria-disabled', 'true');
    await card.focus();
    await page.keyboard.press('Enter');
    await expect(
      page.locator('.browse-notice-slot .notice[role="status"]').filter({
        hasText: 'This client has no playback handler for this format.',
      }),
    ).toHaveText('This client has no playback handler for this format.');
    await expect(
      page.getByRole('heading', { name: 'Movies', level: 1, exact: true }),
    ).toBeVisible();
    const featureAction = page
      .getByTestId('library-feature')
      .getByRole('button', { name: /View details/ });
    if (await featureAction.isEnabled()) await featureAction.click();
    else await expect(featureAction).toBeDisabled();
    await expect(card).toBeAttached();
    await expect(page.locator('.detail')).toHaveCount(0);
    await expectNoPlayer(page);
    await expectSavedProgress(page);
    expect(api.writes).toEqual([]);
    expect(
      requests.filter((request) =>
        /\/api\/media\/[^/]+\/(?:metadata|progress|playback|stream|hls)(?:\/|$)/.test(
          request.path,
        ),
      ),
    ).toEqual([]);
  });

  test(`${skin}: revoking support during a held resume GET never mounts a player or loses saved progress`, async ({
    page,
    api,
  }) => {
    await prepare(page, skin);
    const document = await mockDocument(page);
    const requests = observe(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = 0;
    const progressPath = `/api/media/${idFor(0)}/progress`;
    await page.route(`http://127.0.0.1:4187${progressPath}`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      held++;
      await gate;
      await route.fulfill({ json: savedProgress }).catch(() => {});
    });
    try {
      await page.goto('/');
      await page.locator(`[data-browse-id="${idFor(0)}"]`).click();
      const heading = page.getByRole('heading', {
        name: mediaFor(0).title,
        level: 1,
        exact: true,
      });
      await expect(heading).toBeVisible();
      const play = page.locator('.detail-copy .primary');
      await expect(play).toBeEnabled();
      await play.click();
      await expect.poll(() => held).toBe(1);
      document.current.revision++;
      const movies = document.current.registry!.contentTypes.find(
        (type) => type.id === 'movies',
      )!;
      movies.availability = 'unavailable';
      movies.capabilities.play = false;
      movies.reason = 'Synthetic handler became unavailable.';
      await page.evaluate(() =>
        window.dispatchEvent(new Event('shinema:libraries-refresh')),
      );
      await expect(
        page.getByText(movies.reason, { exact: true }),
      ).toBeVisible();
      const response = page.waitForResponse(
        (response) => new URL(response.url()).pathname === progressPath,
      );
      release();
      await (await response).finished();
      await expect(heading).toBeVisible();
      await expect(play).toBeDisabled();
      await expectNoPlayer(page);
      await expectSavedProgress(page);
      expect(api.writes).toEqual([]);
      expect(
        requests.filter((request) =>
          /\/api\/media\/[^/]+\/(?:playback|stream|hls)(?:\/|$)/.test(
            request.path,
          ),
        ),
      ).toEqual([]);
      expect(
        requests.filter((request) => request.path === progressPath),
      ).toEqual([{ path: progressPath, library: null, method: 'GET' }]);
    } finally {
      release();
    }
  });
}
