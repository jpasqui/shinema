import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const OPEN = 'http://127.0.0.1:8791';
const PAIRED = 'http://127.0.0.1:8792';
const mediaId = (title: string) =>
  createHash('sha256').update(`movies/${title}.mkv`).digest('hex');

/** The accessible name of whatever has keyboard focus. */
const focused = (page: Page) =>
  page.evaluate(
    () =>
      document.activeElement?.getAttribute('aria-label') ??
      document.activeElement?.textContent ??
      '',
  );

async function connect(page: Page, origin: string) {
  await page.goto(origin);
  await page.evaluate(() => localStorage.clear());
  await page.goto(origin);
  const address = page.getByLabel('Server address');
  await address.fill(origin.replace('http://', ''));
  await address.press('Enter');
}

test('browses the library with arrow keys and returns to the same poster', async ({
  page,
}, info) => {
  await connect(page, OPEN);
  await expect(page.getByText('Northern Lines').first()).toBeVisible();
  await expect.poll(() => focused(page)).toContain('The Lighthouse Keeper');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => focused(page)).toContain('Northern Lines');
  await page.screenshot({ path: info.outputPath('library.png') });

  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Play', exact: true }),
  ).toBeFocused();
  await page.screenshot({ path: info.outputPath('detail.png') });

  await page.keyboard.press('Escape');
  await expect.poll(() => focused(page)).toContain('Northern Lines');
});

test('library tabs switch on select without stealing focus', async ({
  page,
}) => {
  await connect(page, OPEN);
  await expect.poll(() => focused(page)).toContain('The Lighthouse Keeper');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => focused(page)).toBe('TV');
  // Focus alone does not switch libraries.
  await expect(page.getByText('The Lighthouse Keeper').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Harbour Lights').first()).toBeVisible();
  await expect.poll(() => focused(page)).toBe('TV');
});

test('plays, seeks with repeated presses, saves progress and offers Resume', async ({
  page,
}, info) => {
  test.skip(!process.env.SHINEMA_MOCK_VIDEO, 'needs a generated test clip');
  // Each viewport watches its own title; the mock server keeps progress.
  const title = info.project.name === 'tv' ? 'Paper Moons' : 'Low Tide';
  await connect(page, OPEN);
  await expect.poll(() => focused(page)).toContain('The Lighthouse Keeper');
  await page
    .getByRole('button', { name: new RegExp(`^${title}`) })
    .press('Enter');
  await page.getByRole('button', { name: 'Play', exact: true }).press('Enter');

  const video = page.locator('video');
  await expect
    .poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime))
    .toBeGreaterThan(0.5);
  await expect(page.getByText('Generated caption one')).toBeVisible();
  await page.screenshot({ path: info.outputPath('player.png') });

  // Two quick presses add up even before the player reports the first seek.
  const before = await video.evaluate(
    (node: HTMLVideoElement) => node.currentTime,
  );
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime))
    .toBeGreaterThan(before + 18);
  await page.keyboard.press(' ');
  await expect
    .poll(() => video.evaluate((node: HTMLVideoElement) => node.paused))
    .toBe(true);

  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: /^Resume from/ }),
  ).toBeVisible();

  // The position reached the server.
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `${OPEN}/api/media/${mediaId(title)}/progress`,
      );
      return ((await response.json()) as { positionSeconds?: number } | null)
        ?.positionSeconds;
    })
    .toBeGreaterThan(15);
});

test('pairs with a code when the server requires it', async ({ page }) => {
  await connect(page, PAIRED);
  await expect(
    page
      .getByRole('heading', { name: 'Pair this device' })
      .or(page.getByText('Pair this device')),
  ).toBeVisible();
  await page.getByLabel('Pairing code').fill('000-000');
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByText(/did not work/)).toBeVisible();
  await page.getByLabel('Pairing code').fill('123-456');
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByText('Northern Lines').first()).toBeVisible();
  // Images and streams carry the device token; the API sends it as a header.
  const stored = await page.evaluate(() =>
    Object.values({ ...localStorage }).join(' '),
  );
  expect(stored).toContain('"token":"' + 'e'.repeat(64));
});
