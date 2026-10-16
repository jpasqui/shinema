import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  FullResult,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PlaybackDiagnostics, {
  failureRecord,
  safeLayoutDiagnostic,
  supportedPlaybackScreenshot,
} from './e2e/diagnostics-reporter.ts';

function screenshotBytes(width: number, height = 900) {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

test('playback screenshots accept only exact phone/desktop sizes within the byte bound', () => {
  for (const width of [390, 1280])
    assert.equal(supportedPlaybackScreenshot(screenshotBytes(width)), true);
  for (const [width, height] of [
    [389, 900],
    [391, 900],
    [1279, 900],
    [1281, 900],
    [390, 899],
    [1280, 901],
    [900, 390],
  ])
    assert.equal(
      supportedPlaybackScreenshot(screenshotBytes(width, height)),
      false,
    );
  for (const bytes of [
    Buffer.alloc(0),
    screenshotBytes(390).subarray(0, 23),
    Buffer.alloc(24),
    Buffer.alloc(2 * 1024 * 1024 + 1),
  ])
    assert.equal(supportedPlaybackScreenshot(bytes), false);
});

const numericDiagnostic = () => {
  const rect = { x: 1, y: 2, width: 390, height: 50 };
  return {
    schema: 1,
    line: 42,
    skin: 'marquee',
    width: 390,
    omittedSnapshots: 0,
    snapshots: [{ step: 1, scroll: [0, 128], anchors: { brand: { ...rect } } }],
    shifts: {
      count: 1,
      cls: 0.000078212345,
      entries: [
        {
          value: 0.000078212345,
          recentInput: false,
          time: 1200,
          sources: [
            {
              anchor: 'brand',
              kind: 'text',
              previous: { ...rect },
              current: { ...rect, y: 3 },
            },
          ],
        },
      ],
    },
  };
};

test('numeric layout logs retain small shifts and accept only the bounded static protocol', () => {
  const data = numericDiagnostic();
  const encoded = JSON.stringify(data);
  assert.equal(safeLayoutDiagnostic(Buffer.from(encoded)), encoded);
  assert.equal(
    JSON.parse(safeLayoutDiagnostic(Buffer.from(encoded))!).shifts.cls,
    0.000078212345,
  );
  for (const mutate of [
    (value: ReturnType<typeof numericDiagnostic>) =>
      Object.assign(value, { error: 'synthetic-sensitive-marker' }),
    (value: ReturnType<typeof numericDiagnostic>) =>
      Object.assign(value.snapshots[0].anchors, {
        'synthetic-sensitive-marker': { x: 1, y: 1, width: 1, height: 1 },
      }),
    (value: ReturnType<typeof numericDiagnostic>) =>
      Object.assign(value.shifts.entries[0].sources[0], {
        selector: 'synthetic-sensitive-marker',
      }),
    (value: ReturnType<typeof numericDiagnostic>) =>
      Object.assign(value.shifts.entries[0].sources[0].current, {
        text: 'synthetic-sensitive-marker',
      }),
    (value: ReturnType<typeof numericDiagnostic>) => {
      value.snapshots[0].anchors.brand.x = Infinity;
    },
    (value: ReturnType<typeof numericDiagnostic>) => {
      value.snapshots[0].anchors.brand.width = -1;
    },
    (value: ReturnType<typeof numericDiagnostic>) => {
      value.snapshots[0].scroll[0] = 1000001;
    },
    (value: ReturnType<typeof numericDiagnostic>) => {
      value.shifts.entries[0].sources[0].anchor = 'synthetic-sensitive-marker';
    },
    (value: ReturnType<typeof numericDiagnostic>) => {
      value.shifts.entries[0].value = 1.01;
    },
    (value: ReturnType<typeof numericDiagnostic>) => {
      value.shifts.entries[0].recentInput = 'false' as unknown as boolean;
    },
    (value: ReturnType<typeof numericDiagnostic>) => {
      value.skin = ['marquee'] as unknown as string;
    },
    (value: ReturnType<typeof numericDiagnostic>) => {
      value.width = 768;
    },
    (value: ReturnType<typeof numericDiagnostic>) => {
      value.snapshots = Array.from({ length: 17 }, () => value.snapshots[0]);
    },
    (value: ReturnType<typeof numericDiagnostic>) => {
      value.shifts.entries = Array.from(
        { length: 17 },
        () => value.shifts.entries[0],
      );
    },
    (value: ReturnType<typeof numericDiagnostic>) => {
      value.shifts.entries[0].sources = Array.from(
        { length: 6 },
        () => value.shifts.entries[0].sources[0],
      );
    },
  ]) {
    const invalid = numericDiagnostic();
    mutate(invalid);
    assert.equal(
      safeLayoutDiagnostic(Buffer.from(JSON.stringify(invalid))),
      undefined,
    );
  }
  assert.equal(
    safeLayoutDiagnostic(Buffer.from('x'.repeat(30 * 1024 + 1))),
    undefined,
  );
  assert.equal(safeLayoutDiagnostic(Buffer.from('{')), undefined);
});

test('playback diagnostic records keep only bounded source-relative failure fields', () => {
  const secret = 'synthetic-sensitive-marker';
  const record = failureRecord(
    {
      title: secret,
      location: {
        file: 'C:\\Users\\fixture\\private\\playback.spec.ts',
        line: 42,
      },
    } as TestCase,
    {
      status: 'failed',
      errors: [{ message: secret, stack: '/Users/fixture/private/source.ts' }],
      attachments: [{ name: 'private state', body: Buffer.from(secret) }],
    } as unknown as TestResult,
  );
  assert.deepEqual(record, {
    source: 'tests/e2e/playback.spec.ts',
    line: 42,
    outcome: 'failed',
    errorCount: 1,
    screenshot: false,
  });
  assert(!JSON.stringify(record).includes(secret));
  assert(!JSON.stringify(record).includes('Users'));
});

for (const width of [390, 1280])
  test(`reporter flushes non-awaited hooks before declaring ${width}px screenshots in the final log`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'shinema-reporter-'));
    try {
      const screenshot = join(temporary, 'generated.png');
      const png = screenshotBytes(width);
      await writeFile(screenshot, png);
      const reporter = new PlaybackDiagnostics();
      reporter.onBegin();
      reporter.onTestEnd(
        {
          expectedStatus: 'passed',
          location: { file: 'playback.spec.ts', line: 42 },
        } as TestCase,
        {
          status: 'failed',
          errors: [{}],
          attachments: [
            { name: 'screenshot', contentType: 'image/png', path: screenshot },
          ],
        } as TestResult,
      );
      await reporter.onEnd({ status: 'failed' } as FullResult);
      const output = new URL(
        '../../../ci-artifacts/playback-failure/',
        import.meta.url,
      );
      const data = JSON.parse(
        await readFile(new URL('failure.json', output), 'utf8'),
      );
      assert.equal(data.failures[0].screenshot, true);
      assert.deepEqual(await readFile(new URL('failure-1.png', output)), png);
      assert.match(
        await readFile(new URL('browser-test.log', output), 'utf8'),
        /screenshot=failure-1\.png/,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
