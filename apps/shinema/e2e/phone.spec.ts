import { expect, test } from '@playwright/test';

const OPEN = 'http://127.0.0.1:8791';

// Phones use touch: the same screens must fit a narrow portrait screen.
test('fits a phone screen and opens a title by tapping', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'phone', 'phone layout only');
  await page.goto(OPEN);
  await page.evaluate(() => localStorage.clear());
  await page.goto(OPEN);
  await page.getByLabel('Server address').fill('127.0.0.1:8791');
  await page.getByRole('button', { name: 'Connect' }).tap();
  await expect(page.getByText('Northern Lines').first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole('button', { name: 'Settings' })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('home.png') });
  await page
    .getByRole('button', { name: /^Northern Lines/ })
    .first()
    .tap();
  await expect(
    page.getByRole('button', { name: 'Play', exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: info.outputPath('detail.png') });
});
