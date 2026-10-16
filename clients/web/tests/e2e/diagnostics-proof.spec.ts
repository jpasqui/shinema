import { test, expect } from './fixtures.ts';

test('intentional generated-only diagnostic verification', async ({
  page,
  api: _api,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('button', {
      name: 'Open Generated movie 00000',
      exact: true,
    }),
  ).toBeVisible();
  throw new Error(
    'Synthetic diagnostic check: C:\\Users\\fixture\\private /Users/fixture/private synthetic-sensitive-marker',
  );
});
