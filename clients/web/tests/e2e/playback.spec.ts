import {
  test,
  expect,
  duration,
  idFor,
  mediaFor,
  openMovie,
  pauseDecoded,
} from './fixtures.ts';

for (const driver of ['direct', 'transcode'] as const) {
  test(`${driver}: seek controls clamp at both ends and slider keys move only once`, async ({
    page,
    api,
  }) => {
    api.descriptor = driver;
    await page.goto('/');
    await openMovie(page);
    const video = await pauseDecoded(page);
    const player = page.getByRole('main', { name: 'Video player' });
    const slider = page.getByLabel('Playback position');
    const settledAt = async (position: number) => {
      await expect
        .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
        .toBeCloseTo(position, 1);
      await expect(video).toHaveJSProperty('seeking', false);
      await expect
        .poll(() => slider.inputValue().then(Number))
        .toBeCloseTo(position, 1);
    };

    await player.focus();
    await page.keyboard.press('ArrowLeft');
    await settledAt(0);
    await page
      .getByRole('button', { name: 'Back ten seconds', exact: true })
      .click();
    await settledAt(0);
    await page
      .getByRole('button', { name: 'Forward ten seconds', exact: true })
      .click();
    await settledAt(10);
    await player.focus();
    await page.keyboard.press('ArrowRight');
    await settledAt(20);

    await slider.focus();
    await slider.press('ArrowRight');
    await settledAt(20.1);
    await slider.press('End');
    await settledAt(duration);
    await page
      .getByRole('button', { name: 'Forward ten seconds', exact: true })
      .click();
    await settledAt(duration);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect
      .poll(() => api.remote.get(idFor(0))?.positionSeconds)
      .toBeCloseTo(duration, 1);
    await expect(video).toHaveJSProperty('paused', true);
  });

  test(`${driver}: completed progress starts over and saves a new position`, async ({
    page,
    api,
  }) => {
    api.descriptor = driver;
    api.remote.set(idFor(0), {
      positionSeconds: duration - 1,
      durationSeconds: duration,
    });
    await page.goto('/');
    await openMovie(page);
    const video = await pauseDecoded(page);
    const position = await video.evaluate(
      (v: HTMLVideoElement) => v.currentTime,
    );
    expect(position).toBeGreaterThan(0);
    expect(position).toBeLessThan(5);
    await expect
      .poll(() => api.remote.get(idFor(0))?.positionSeconds)
      .toBeLessThan(5);
    await page
      .getByRole('button', { name: 'Back to details', exact: false })
      .click();
    await page.getByRole('button', { name: /Resume/ }).click();
    const resumed = await pauseDecoded(page);
    expect(
      await resumed.evaluate((v: HTMLVideoElement) => v.currentTime),
    ).toBeGreaterThanOrEqual(position);
  });
}

for (const failure of ['unavailable', 'malformed', 'disconnected'] as const) {
  test(`${failure} playback reports failure, preserves resume, and can reopen`, async ({
    page,
    api,
  }) => {
    const saved = { positionSeconds: 24, durationSeconds: duration };
    api.remote.set(idFor(0), saved);
    if (failure === 'disconnected') api.stream = 'disconnected';
    else api.descriptor = failure;
    await page.goto('/');
    await openMovie(page);
    await expect(page.getByRole('alert')).toContainText('could not play');
    await expect(page.getByRole('status')).toHaveCount(0);
    if (failure !== 'disconnected')
      expect(await page.locator('video').getAttribute('src')).toBeNull();
    await page
      .getByRole('button', { name: 'Back to details', exact: false })
      .click();
    expect(api.remote.get(idFor(0))).toEqual(saved);
    expect(api.writes).toEqual([]);
    if (failure !== 'disconnected') {
      expect(api.requests.some((path) => path.endsWith('/stream'))).toBe(false);
    }
    expect(api.blockedRequests).toEqual([]);
    api.descriptor = 'direct';
    api.stream = 'ok';
    await page.getByRole('button', { name: /Play|Resume/ }).click();
    const video = await pauseDecoded(page);
    expect(
      await video.evaluate((v: HTMLVideoElement) => v.currentTime),
    ).toBeGreaterThanOrEqual(saved.positionSeconds);
    expect(
      await video.evaluate((v: HTMLVideoElement) => v.currentTime),
    ).toBeLessThan(saved.positionSeconds + 5);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

test('HLS segment disconnect after decoding reports fatal failure and reopens at last seek', async ({
  page,
  api,
}) => {
  api.descriptor = 'transcode';
  await page.goto('/');
  await openMovie(page);
  const video = await pauseDecoded(page);
  api.stream = 'disconnected';
  // Force a real segment request beyond the bounded HLS buffer. No media or HLS
  // error event is synthesized: the actual loader must surface this failure.
  await video.evaluate((node: HTMLVideoElement) => {
    node.currentTime = 72;
  });
  await expect(page.getByRole('alert')).toContainText('Playback stopped', {
    timeout: 45000,
  });
  expect(
    api.requests.some((path) => /hls\/segment-03[5-9]\.ts$/.test(path)),
  ).toBe(true);
  await page
    .getByRole('button', { name: 'Back to details', exact: false })
    .click();
  await expect
    .poll(() => api.remote.get(idFor(0))?.positionSeconds)
    .toBeGreaterThan(60);
  const saved = api.remote.get(idFor(0))!;
  api.stream = 'ok';
  await page.getByRole('button', { name: /Resume/ }).click();
  await pauseDecoded(page);
  const resumedPosition = await video.evaluate(
    (node: HTMLVideoElement) => node.currentTime,
  );
  expect(resumedPosition).toBeGreaterThanOrEqual(saved.positionSeconds);
  expect(resumedPosition).toBeLessThan(saved.positionSeconds + 5);
  await expect(video).toHaveJSProperty('seeking', false);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('offline progress survives reload on a large library page and syncs only its selected ID', async ({
  page,
  api,
}) => {
  api.total = 10001;
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: /^Open Generated movie/ }),
  ).toHaveCount(60);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.pagination')).toContainText(
    '61\u2013120 of 10001',
  );
  api.failProgress = true;
  await openMovie(page, 61);
  const video = await pauseDecoded(page);
  await page
    .getByRole('button', { name: 'Forward ten seconds', exact: true })
    .click();
  const position = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await page
    .getByRole('button', { name: 'Back to details', exact: false })
    .click();
  await page
    .getByRole('button', { name: 'Back to library', exact: false })
    .click();
  await expect(
    page.getByRole('button', {
      name: `Open ${mediaFor(61).title}`,
      exact: true,
    }),
  ).toBeFocused();
  await expect(page.locator('.pagination')).toContainText(
    '61\u2013120 of 10001',
  );
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('shinema.web.cache.v1')!),
  );
  expect(stored.pending[idFor(61)].positionSeconds).toBeCloseTo(position, 1);
  expect(api.writes).toEqual([]);

  await page.reload();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await openMovie(page, 61);
  const resumed = await pauseDecoded(page);
  expect(
    await resumed.evaluate((v: HTMLVideoElement) => v.currentTime),
  ).toBeGreaterThanOrEqual(position);
  await page
    .getByRole('button', { name: 'Back to details', exact: false })
    .click();
  await page
    .getByRole('button', { name: 'Back to library', exact: false })
    .click();
  api.failProgress = false;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => api.writes.length).toBeGreaterThan(0);
  expect(new Set(api.writes.map((write) => write.id))).toEqual(
    new Set([idFor(61)]),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('shinema.web.cache.v1')!).pending,
      ),
    )
    .toEqual({});
  expect(api.remote.get(idFor(0))).toBeUndefined();
  await expect(
    page.getByRole('button', { name: /^Open Generated movie/ }),
  ).toHaveCount(60);
  expect(
    Math.max(
      ...api.requests
        .filter((path) => path.startsWith('/api/catalog?'))
        .map((path) =>
          Number(
            new URL(path, 'http://fixture.invalid').searchParams.get('limit'),
          ),
        ),
    ),
  ).toBe(60);
});
