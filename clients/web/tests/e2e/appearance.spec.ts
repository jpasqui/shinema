import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import {
  defaultTheme,
  midnightTheme,
  archiveTheme,
  MAX_THEME_BYTES,
  themeCssVariables,
} from '../../../../packages/design-tokens/theme.ts';
import type { Theme } from '../../../../packages/design-tokens/theme.ts';
import {
  test,
  expect,
  idFor,
  mediaFor,
  openMovie,
  pauseDecoded,
} from './fixtures.ts';

const storageKey = 'shinema.appearance.v1';

async function openAppearance(page: Page) {
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Appearance', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openThemeTransfer(dialog: Locator) {
  await dialog.getByText('Import or export a theme', { exact: true }).click();
  await expect(dialog.getByLabel('Theme JSON', { exact: true })).toBeVisible();
}

async function expectAppliedTheme(page: Page, theme: Theme) {
  const expected = themeCssVariables(theme);
  await expect
    .poll(() =>
      page.evaluate((keys) => {
        const style = getComputedStyle(document.documentElement);
        return Object.fromEntries(
          keys.map((key) => [key, style.getPropertyValue(key).trim()]),
        );
      }, Object.keys(expected)),
    )
    .toEqual(expected);
}

async function savedPreferences(page: Page) {
  const raw = await page.evaluate(
    (key) => localStorage.getItem(key),
    storageKey,
  );
  return raw === null ? null : JSON.parse(raw);
}

async function expectMotionDisabled(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  const movingElements = await page.evaluate(() => {
    const positiveDuration = (value: string) =>
      value.split(',').some((duration) => Number.parseFloat(duration) > 0);
    return [...document.querySelectorAll('*')].flatMap((node) => {
      const style = getComputedStyle(node);
      return (style.animationName !== 'none' &&
        positiveDuration(style.animationDuration)) ||
        positiveDuration(style.transitionDuration) ||
        style.scrollBehavior !== 'auto'
        ? [node.tagName + (node.className ? `.${node.className}` : '')]
        : [];
    });
  });
  expect(movingElements).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((animation) => animation.playState === 'running').length,
    ),
  ).toBe(0);
}

async function rectangle(locator: Locator) {
  return locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      x: rect.x + scrollX,
      y: rect.y + scrollY,
      width: rect.width,
      height: rect.height,
    };
  });
}

test.beforeEach(async ({ api }) => {
  api.total = 3;
});

test.afterEach(async ({ api }) => {
  expect(api.blockedRequests).toEqual([]);
});

test('Marquee defaults, presets and custom palette persist, and reset restores defaults', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await expectAppliedTheme(page, defaultTheme);
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
  const dialog = await openAppearance(page);
  await expect(dialog.getByLabel('Theme name', { exact: true })).toHaveValue(
    'Marquee',
  );

  await dialog.getByRole('button', { name: 'Midnight', exact: true }).click();
  await expectAppliedTheme(page, midnightTheme);
  await expect(dialog.getByLabel('Theme name', { exact: true })).toHaveValue(
    'Midnight',
  );
  await dialog.getByRole('button', { name: 'Marquee', exact: true }).click();
  await expectAppliedTheme(page, defaultTheme);

  const custom = {
    ...defaultTheme,
    name: 'Night garden',
    colors: {
      ...defaultTheme.colors,
      background: '#0b100d',
      accent: '#b8e2c9',
    },
  } satisfies Theme;
  await dialog.getByLabel('Theme name', { exact: true }).fill(custom.name);
  await dialog
    .getByLabel('Background', { exact: true })
    .fill(custom.colors.background);
  await dialog.getByLabel('Accent', { exact: true }).fill(custom.colors.accent);
  await dialog
    .getByRole('button', { name: 'Apply palette', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expectAppliedTheme(page, custom);
  await dialog.getByLabel('Motion', { exact: true }).selectOption('reduced');
  await expect
    .poll(() => savedPreferences(page))
    .toEqual({
      version: 1,
      theme: custom,
      motion: 'reduced',
    });
  await dialog
    .getByRole('button', { name: 'Close appearance', exact: true })
    .click();
  await page.reload();
  await expectAppliedTheme(page, custom);
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');

  const reopened = await openAppearance(page);
  await expect(reopened.getByLabel('Theme name', { exact: true })).toHaveValue(
    custom.name,
  );
  await expect(reopened.getByLabel('Motion', { exact: true })).toHaveValue(
    'reduced',
  );
  await reopened
    .getByRole('button', { name: 'Reset appearance', exact: true })
    .click();
  await expectAppliedTheme(page, defaultTheme);
  await expect(reopened.getByLabel('Theme name', { exact: true })).toHaveValue(
    'Marquee',
  );
  await expect(reopened.getByLabel('Motion', { exact: true })).toHaveValue(
    'system',
  );
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
  await page.reload();
  await expectAppliedTheme(page, defaultTheme);
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
});

test('custom JSON exports as a local theme file and imports with reload persistence', async ({
  page,
}) => {
  await page.goto('/');
  const dialog = await openAppearance(page);
  await openThemeTransfer(dialog);
  const custom = {
    ...midnightTheme,
    name: 'Evening screening',
    design: {
      ...archiveTheme.design,
      typography: 'system',
      density: 'compact',
      cards: 'landscape',
      motion: 'still',
    },
    colors: {
      ...midnightTheme.colors,
      background: '#0c1018',
      accent: '#ffbb99',
    },
  } satisfies Theme;
  await dialog
    .getByLabel('Theme JSON', { exact: true })
    .fill(JSON.stringify(custom));
  await dialog
    .getByRole('button', { name: 'Apply theme JSON', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expectAppliedTheme(page, custom);

  const downloading = page.waitForEvent('download');
  await dialog
    .getByRole('button', { name: 'Export theme', exact: true })
    .click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.json$/i);
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(path).not.toBeNull();
  const exported = await readFile(path!, 'utf8');
  expect(JSON.parse(exported)).toEqual(custom);

  await dialog
    .getByRole('button', { name: 'Reset appearance', exact: true })
    .click();
  await expectAppliedTheme(page, defaultTheme);
  await dialog.getByLabel('Theme JSON', { exact: true }).fill(exported);
  await dialog
    .getByRole('button', { name: 'Apply theme JSON', exact: true })
    .click();
  await expectAppliedTheme(page, custom);
  await page.reload();
  await expectAppliedTheme(page, custom);
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'archive');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  expect(await savedPreferences(page)).toEqual({
    version: 1,
    theme: custom,
    motion: 'system',
  });
  const reopened = await openAppearance(page);
  await expect(reopened.getByLabel('Theme name', { exact: true })).toHaveValue(
    custom.name,
  );
  await expect(reopened.getByLabel('Background', { exact: true })).toHaveValue(
    custom.colors.background,
  );
});

test('Marquee and Archive change compositions while custom design settings persist and navigation focus returns', async ({
  page,
  api,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  const cards = page.getByRole('button', { name: /^Open Generated movie/ });
  await expect(cards).toHaveCount(3);
  await expect(page.locator('.marquee-feature')).toBeVisible();
  await expect(page.locator('.archive-programme')).toHaveCount(0);
  const catalogRequests = api.requests.filter((path) =>
    path.startsWith('/api/catalog?'),
  ).length;
  const dialog = await openAppearance(page);
  await dialog.getByRole('button', { name: 'Archive', exact: true }).click();
  await expectAppliedTheme(page, archiveTheme);
  await expect(page.locator('.archive-programme')).toBeVisible();
  await expect(page.locator('.marquee-feature')).toHaveCount(0);
  await expect(page.locator('.header')).toHaveClass(/header--archive/);
  await dialog
    .getByLabel('Skin layout', { exact: true })
    .selectOption('marquee');
  await expect(page.locator('.marquee-feature')).toBeVisible();
  await expect(page.locator('.archive-programme')).toHaveCount(0);
  await dialog
    .getByLabel('Skin layout', { exact: true })
    .selectOption('archive');
  await dialog.getByLabel('Typography', { exact: true }).selectOption('system');
  await dialog.getByLabel('Spacing', { exact: true }).selectOption('compact');
  await dialog
    .getByLabel('Card design', { exact: true })
    .selectOption('landscape');
  await dialog.getByLabel('Skin motion', { exact: true }).selectOption('still');
  const custom = {
    ...archiveTheme,
    design: {
      ...archiveTheme.design,
      typography: 'system',
      density: 'compact',
      cards: 'landscape',
      motion: 'still',
    },
  } satisfies Theme;
  await expectAppliedTheme(page, custom);
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'archive');
  await expect(page.locator('html')).toHaveAttribute(
    'data-typography',
    'system',
  );
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await expect(page.locator('html')).toHaveAttribute('data-cards', 'landscape');
  await expectMotionDisabled(page);
  await expect
    .poll(() => savedPreferences(page))
    .toEqual({ version: 1, theme: custom, motion: 'system' });
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Appearance', exact: true }),
  ).toBeFocused();
  await expect(cards).toHaveCount(3);
  expect(
    api.requests.filter((path) => path.startsWith('/api/catalog?')).length,
  ).toBe(catalogRequests);

  await page.reload();
  await expectAppliedTheme(page, custom);
  await expect(page.locator('.archive-programme')).toBeVisible();
  await expectMotionDisabled(page);
  const restored = await openAppearance(page);
  for (const [label, value] of [
    ['Skin layout', 'archive'],
    ['Typography', 'system'],
    ['Spacing', 'compact'],
    ['Card design', 'landscape'],
    ['Skin motion', 'still'],
  ] as const) {
    await expect(restored.getByLabel(label, { exact: true })).toHaveValue(
      value,
    );
  }
  await restored.getByRole('button', { name: 'Done', exact: true }).click();
  const selectedCard = page.getByRole('button', {
    name: `Open ${mediaFor(1).title}`,
    exact: true,
  });
  await selectedCard.click();
  await expect(
    page.locator('.archive-detail-layout .detail-programme-poster'),
  ).toBeVisible();
  await expect(page.locator('.detail-programme-copy h1')).toHaveText(
    mediaFor(1).title,
  );
  for (const skin of ['marquee', 'archive'] as const) {
    const detailDialog = await openAppearance(page);
    await detailDialog
      .getByLabel('Skin layout', { exact: true })
      .selectOption(skin);
    await expect(page.locator('.archive-detail-layout')).toHaveCount(
      skin === 'archive' ? 1 : 0,
    );
    await detailDialog
      .getByRole('button', { name: 'Done', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: mediaFor(1).title, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Appearance', exact: true }),
    ).toBeFocused();
  }
  await page.getByRole('button', { name: /Back to library/ }).click();
  await expect(selectedCard).toBeFocused();
  await expect(page.locator('.archive-programme')).toBeVisible();
});

test('switching skins keeps the same paused decoded video, progress and return focus', async ({
  page,
  api,
}) => {
  await page.goto('/');
  await openMovie(page, 1);
  const video = await pauseDecoded(page);
  await page
    .getByRole('button', { name: 'Forward ten seconds', exact: true })
    .click();
  await expect(video).toHaveJSProperty('seeking', false);
  const position = await video.evaluate(
    (node: HTMLVideoElement) => node.currentTime,
  );
  await expect
    .poll(() => api.remote.get(idFor(1))?.positionSeconds)
    .toBeCloseTo(position, 1);
  const original = await video.elementHandle();
  expect(original).not.toBeNull();
  const source = await video.getAttribute('src');
  const playbackRequests = api.requests.filter((path) =>
    path.endsWith('/playback'),
  ).length;
  for (const name of ['Archive', 'Marquee'] as const) {
    const dialog = await openAppearance(page);
    await dialog.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute(
      'data-skin',
      name.toLowerCase(),
    );
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Appearance', exact: true }),
    ).toBeFocused();
    expect(
      await page.evaluate(
        (node) => document.querySelector('video') === node,
        original!,
      ),
    ).toBe(true);
    await expect(video).toHaveJSProperty('paused', true);
    await expect(video).toHaveAttribute('src', source!);
    expect(
      await video.evaluate((node: HTMLVideoElement) => node.currentTime),
    ).toBeCloseTo(position, 1);
    expect(api.remote.get(idFor(1))?.positionSeconds).toBeCloseTo(position, 1);
    expect(
      api.requests.filter((path) => path.endsWith('/playback')).length,
    ).toBe(playbackRequests);
  }
  await page.getByRole('button', { name: /Back to details/ }).click();
  await expect(
    page.getByRole('heading', { name: mediaFor(1).title, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Resume/ })).toBeVisible();
  await page.getByRole('button', { name: /Back to library/ }).click();
  await expect(
    page.getByRole('button', {
      name: `Open ${mediaFor(1).title}`,
      exact: true,
    }),
  ).toBeFocused();
  await original!.dispose();
});

const rejectedImports = [
  {
    name: 'CSS URL color',
    value: JSON.stringify({
      ...defaultTheme,
      colors: {
        ...defaultTheme.colors,
        background: 'url(https://theme.invalid/image)',
      },
    }),
    error: /six-digit hex/i,
  },
  {
    name: 'script markup',
    value: JSON.stringify({
      ...defaultTheme,
      name: '<script>globalThis.__themeExecuted=1</script>',
    }),
    error: /theme name/i,
  },
  {
    name: 'unknown version',
    value: JSON.stringify({ ...defaultTheme, version: 2 }),
    error: /version/i,
  },
  {
    name: 'low contrast',
    value: JSON.stringify({
      ...defaultTheme,
      colors: { ...defaultTheme.colors, text: defaultTheme.colors.background },
    }),
    error: /contrast/i,
  },
  {
    name: 'oversized JSON',
    value: `${JSON.stringify(defaultTheme)}${' '.repeat(MAX_THEME_BYTES)}`,
    error: /bytes/i,
  },
  {
    name: 'extra CSS property',
    value: JSON.stringify({ ...defaultTheme, css: 'body { display: none; }' }),
    error: /exactly/i,
  },
  {
    name: 'unsupported design enum',
    value: JSON.stringify({
      ...defaultTheme,
      design: { ...defaultTheme.design, skin: 'unregistered' },
    }),
    error: /design\.skin must be one of/i,
  },
  {
    name: 'remote component URL',
    value: JSON.stringify({
      ...defaultTheme,
      design: {
        ...defaultTheme.design,
        componentUrl: 'https://theme.invalid/skin.js',
      },
    }),
    error: /Theme\.design must contain exactly/i,
  },
] as const;

for (const invalid of rejectedImports) {
  test(`rejecting ${invalid.name} keeps the active theme and stored preference`, async ({
    page,
  }) => {
    await page.goto('/');
    const dialog = await openAppearance(page);
    await dialog.getByRole('button', { name: 'Midnight', exact: true }).click();
    await expectAppliedTheme(page, midnightTheme);
    const before = await savedPreferences(page);
    await openThemeTransfer(dialog);
    await dialog.getByLabel('Theme JSON', { exact: true }).fill(invalid.value);
    await dialog
      .getByRole('button', { name: 'Apply theme JSON', exact: true })
      .click();
    await expect(dialog.getByRole('alert')).toContainText(invalid.error);
    await expectAppliedTheme(page, midnightTheme);
    expect(await savedPreferences(page)).toEqual(before);
    expect(await page.evaluate(() => '__themeExecuted' in globalThis)).toBe(
      false,
    );
    await page.reload();
    await expectAppliedTheme(page, midnightTheme);
  });
}

test('invalid saved preferences fall back visibly and can be replaced with reset', async ({
  page,
}) => {
  await page.addInitScript(
    ({ key, theme }) => {
      if (localStorage.getItem(key) === null) {
        localStorage.setItem(
          key,
          JSON.stringify({ version: 2, theme, motion: 'system' }),
        );
      }
    },
    { key: storageKey, theme: midnightTheme },
  );
  await page.goto('/');
  await expectAppliedTheme(page, defaultTheme);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /saved appearance was invalid/i }),
  ).toBeVisible();
  const dialog = await openAppearance(page);
  await expect(dialog.getByLabel('Theme name', { exact: true })).toHaveValue(
    'Marquee',
  );
  await dialog
    .getByRole('button', { name: 'Reset appearance', exact: true })
    .click();
  await expect
    .poll(() => savedPreferences(page))
    .toEqual({ version: 1, theme: defaultTheme, motion: 'system' });
  await page.reload();
  await expectAppliedTheme(page, defaultTheme);
  await expect(page.getByText(/saved appearance was invalid/i)).toHaveCount(0);
});

test('system motion changes are live and explicit reduced motion persists without animations or smooth scrolling', async ({
  page,
  api,
}) => {
  api.total = 60;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const cards = page.getByRole('button', { name: /^Open Generated movie/ });
  await expect(cards).toHaveCount(60);
  await expectMotionDisabled(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
  const dialog = await openAppearance(page);
  await dialog.getByLabel('Motion', { exact: true }).selectOption('reduced');
  await expectMotionDisabled(page);
  await dialog
    .getByRole('button', { name: 'Close appearance', exact: true })
    .click();
  await cards.first().focus();
  await cards.first().press('End');
  await expect(cards.last()).toBeFocused();
  await expectMotionDisabled(page);
  await page.reload();
  await expectMotionDisabled(page);
  const reopened = await openAppearance(page);
  await expect(reopened.getByLabel('Motion', { exact: true })).toHaveValue(
    'reduced',
  );
});

test('featured artwork stays visible with reduced motion and a failed image retains useful details', async ({
  page,
  api,
}) => {
  api.total = 1;
  const item = mediaFor(0);
  const backdropPath = `/api/media/${item.id}/backdrop`;
  let failArtwork = false;
  await page.route('http://127.0.0.1:4187/api/catalog?**', (route) =>
    route.fulfill({
      json: {
        apiVersion: 1,
        fullLibrary: true,
        total: 1,
        offset: 0,
        limit: 60,
        items: [{ ...item, backdropPath }],
        nextOffset: null,
      },
    }),
  );
  await page.route(`http://127.0.0.1:4187${backdropPath}`, (route) =>
    route.fulfill(
      failArtwork
        ? { status: 404, body: '' }
        : {
            contentType: 'image/svg+xml',
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#314739"/></svg>',
          },
    ),
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const feature = page.getByRole('region', {
    name: 'Featured title',
    exact: true,
  });
  const image = feature.locator('.hero-backdrop img');
  await expect(image).toHaveClass('artwork-loaded');
  await expect(image).toHaveCSS('opacity', '1');
  await expect(image).toHaveCSS('transform', 'none');
  expect(
    await image.evaluate((node: HTMLImageElement) => node.naturalWidth),
  ).toBeGreaterThan(0);
  await expectMotionDisabled(page);

  failArtwork = true;
  await page.reload();
  await expect(feature.locator('.hero-artwork-fallback')).toBeVisible();
  await expect(image).toHaveCount(0);
  await expect(
    feature.getByRole('heading', { name: item.title, exact: true }),
  ).toBeVisible();
  await feature
    .getByRole('button', { name: 'View details', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: item.title, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Back to library/ }),
  ).toBeVisible();
});

test('long featured titles keep hero content in bounds and detail pages free of horizontal overflow at phone, tablet and desktop sizes', async ({
  page,
  api,
}) => {
  api.total = 1;
  const item = {
    ...mediaFor(0),
    title: 'The Last Latitude: A Journey Beyond the Edge of the Known World — '
      .repeat(4)
      .slice(0, 200),
    summary:
      'An expedition crosses frozen coastlines and unfamiliar seas in search of a vanished observatory. As the map runs out, three travellers must decide what they will leave behind to find their way home.',
    year: 2025,
    genres: ['Adventure', 'Science fiction'],
  };
  await page.route('http://127.0.0.1:4187/api/catalog?**', (route) =>
    route.fulfill({
      json: {
        apiVersion: 1,
        fullLibrary: true,
        total: 1,
        offset: 0,
        limit: 60,
        items: [item],
        nextOffset: null,
      },
    }),
  );
  await page.route(
    `http://127.0.0.1:4187/api/media/${item.id}/metadata`,
    (route) => route.fulfill({ json: { apiVersion: 1, items: [item] } }),
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const title of [item.title, 'W'.repeat(200)]) {
    item.title = title;
    expect(title).toHaveLength(200);
    await page.goto('/');
    const feature = page.locator('.marquee-feature');
    await expect(
      feature.getByRole('heading', { name: item.title, exact: true }),
    ).toBeVisible();
    await expect(feature.locator('.hero-summary')).toHaveText(item.summary);
    await expect(feature.locator('.feature-meta')).toContainText('2025');
    await expect(feature.locator('.feature-meta')).toContainText(
      'Science fiction',
    );
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 768, height: 900 },
      { width: 1100, height: 900 },
      { width: 1280, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      for (const density of ['comfortable', 'compact'] as const) {
        const dialog = await openAppearance(page);
        await dialog
          .getByLabel('Spacing', { exact: true })
          .selectOption(density);
        await dialog.getByRole('button', { name: 'Done', exact: true }).click();
        await expect(page.locator('html')).toHaveAttribute(
          'data-density',
          density,
        );
        await feature
          .getByRole('button', { name: 'View details', exact: true })
          .click({ trial: true });
        const layout = await feature.evaluate((node) => {
          const bounds = node.getBoundingClientRect().toJSON();
          const children = [
            '.feature-label',
            'h2',
            '.feature-meta',
            '.hero-summary',
            'button',
          ].map((selector) => {
            const child = node.querySelector(selector)!;
            return { selector, ...child.getBoundingClientRect().toJSON() };
          });
          return { bounds, children };
        });
        for (const child of layout.children) {
          const context = `${viewport.width}px ${density} ${child.selector}`;
          expect(child.width, context).toBeGreaterThan(0);
          expect(child.height, context).toBeGreaterThan(0);
          expect(child.left, context).toBeGreaterThanOrEqual(
            layout.bounds.left - 1,
          );
          expect(child.right, context).toBeLessThanOrEqual(
            layout.bounds.right + 1,
          );
          expect(child.top, context).toBeGreaterThanOrEqual(
            layout.bounds.top - 1,
          );
          expect(child.bottom, context).toBeLessThanOrEqual(
            layout.bounds.bottom + 1,
          );
        }
        for (let index = 1; index < layout.children.length; index++) {
          expect(
            layout.children[index].top,
            `${viewport.width}px ${density} text/action overlap`,
          ).toBeGreaterThanOrEqual(layout.children[index - 1].bottom - 1);
        }
        await feature
          .getByRole('button', { name: 'View details', exact: true })
          .click();
        const detailTitle = page.getByRole('heading', {
          name: title,
          exact: true,
        });
        await expect(detailTitle).toBeVisible();
        await expect(detailTitle).toHaveText(title);
        await expect
          .poll(
            () => page.evaluate(() => document.documentElement.scrollWidth),
            {
              message: `${viewport.width}px ${density} detail must fit the viewport`,
            },
          )
          .toBeLessThanOrEqual(viewport.width);
        await page.getByRole('button', { name: /Back to library/ }).click();
        await expect(feature).toBeVisible();
      }
    }
  }
});

test('D-pad reaches every design select and changes values with left and right while up and down move focus', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  const dialog = await openAppearance(page);
  await dialog
    .getByRole('button', { name: 'Close appearance', exact: true })
    .focus();
  for (const setting of [
    { label: 'Skin layout', key: 'skin', initial: 'marquee', next: 'archive' },
    {
      label: 'Typography',
      key: 'typography',
      initial: 'cinema',
      next: 'editorial',
    },
    {
      label: 'Spacing',
      key: 'density',
      initial: 'comfortable',
      next: 'compact',
    },
    {
      label: 'Card design',
      key: 'cards',
      initial: 'poster',
      next: 'landscape',
    },
    { label: 'Skin motion', key: 'motion', initial: 'subtle', next: 'still' },
    { label: 'Motion', key: 'motion', initial: 'system', next: 'reduced' },
  ]) {
    const select = dialog.getByLabel(setting.label, { exact: true });
    for (
      let steps = 0;
      steps < 12 &&
      !(await select.evaluate((node) => node === document.activeElement));
      steps++
    ) {
      await page.keyboard.press('ArrowDown');
    }
    await expect(
      select,
      `D-pad must reach ${setting.label} from Close`,
    ).toBeFocused();
    await expect(select).toHaveValue(setting.initial);
    await page.keyboard.press('ArrowRight');
    await expect(select).toBeFocused();
    await expect(select).toHaveValue(setting.next);
    const saved = await savedPreferences(page);
    expect(
      setting.label === 'Motion'
        ? saved.motion
        : saved.theme.design[setting.key],
    ).toBe(setting.next);
    if (setting.label === 'Skin layout') {
      await expect(page.locator('html')).toHaveAttribute(
        'data-skin',
        'archive',
      );
    } else if (setting.label === 'Skin motion' || setting.label === 'Motion') {
      await expectMotionDisabled(page);
    }
    await page.keyboard.press('ArrowLeft');
    await expect(select).toBeFocused();
    await expect(select).toHaveValue(setting.initial);
  }
  for (const label of [
    'Skin motion',
    'Card design',
    'Spacing',
    'Typography',
    'Skin layout',
  ]) {
    await page.keyboard.press('ArrowUp');
    await expect(dialog.getByLabel(label, { exact: true })).toBeFocused();
  }
  await expectAppliedTheme(page, defaultTheme);
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
  expect(await savedPreferences(page)).toEqual({
    version: 1,
    theme: defaultTheme,
    motion: 'system',
  });
});

test('appearance is a modal focus boundary and Escape leaves the underlying detail intact', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('button', { name: `Open ${mediaFor(0).title}`, exact: true })
    .click();
  const heading = page.getByRole('heading', {
    name: mediaFor(0).title,
    exact: true,
  });
  await expect(heading).toBeVisible();
  const trigger = page.getByRole('button', { name: 'Appearance', exact: true });
  const dialog = await openAppearance(page);
  expect(
    await dialog.evaluate(
      (node) =>
        node instanceof HTMLDialogElement &&
        node.open &&
        node.matches(':modal'),
    ),
  ).toBe(true);
  expect(
    await dialog.evaluate((node) => node.contains(document.activeElement)),
  ).toBe(true);
  const first = dialog.getByRole('button', {
    name: 'Close appearance',
    exact: true,
  });
  const last = dialog.getByRole('button', { name: 'Done', exact: true });
  await last.focus();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();
  await openThemeTransfer(dialog);
  await dialog.getByLabel('Theme JSON', { exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(heading).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Back to library/ }),
  ).toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', {
      name: `Open ${mediaFor(0).title}`,
      exact: true,
    }),
  ).toBeFocused();
});

test('keyboard focus animates the inner poster while preserving remote navigation geometry', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  const cards = page.getByRole('button', { name: /^Open Generated movie/ });
  await expect(cards).toHaveCount(3);
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await cards.first().scrollIntoViewIfNeeded();
  const before = await rectangle(cards.nth(1));
  const viewportY = await cards
    .nth(1)
    .evaluate((node) => node.getBoundingClientRect().y);
  const initialScroll = await page.evaluate(() => scrollY);
  // Enter keyboard modality so :focus-visible is exercised, as with a TV remote.
  await page.keyboard.press('Tab');
  await cards.first().focus();
  await cards.first().press('ArrowRight');
  await expect(cards.nth(1)).toBeFocused();
  const poster = cards.nth(1).locator('.poster');
  await expect
    .poll(() => poster.evaluate((node) => getComputedStyle(node).transform))
    .not.toBe('none');
  expect(
    await poster.evaluate((node) =>
      getComputedStyle(node)
        .transitionProperty.split(',')
        .map((property) => property.trim()),
    ),
  ).toContain('transform');
  expect(
    await cards.nth(1).evaluate((node) => getComputedStyle(node).transform),
  ).toBe('none');
  const after = await rectangle(cards.nth(1));
  const finalViewportY = await cards
    .nth(1)
    .evaluate((node) => node.getBoundingClientRect().y);
  const finalScroll = await page.evaluate(() => scrollY);
  // Focusing a partially visible card may legitimately scroll the viewport;
  // scrolling must account for that movement without changing document layout.
  expect(finalViewportY - viewportY).toBeCloseTo(
    initialScroll - finalScroll,
    1,
  );
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(after[key]).toBeCloseTo(before[key], 1);
  }
  await cards.nth(1).press('ArrowLeft');
  await expect(cards.first()).toBeFocused();
});
