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
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import PlaybackDiagnostics, {
  failureRecord,
  safeLayoutDiagnostic,
  supportedPlaybackScreenshot,
} from './e2e/diagnostics-reporter.ts';

const supportedViewports = [
  [390, 844],
  [390, 900],
  [768, 900],
  [1100, 900],
  [1280, 900],
  [1600, 900],
] as const;

function pngChunk(type: string, bytes: Buffer) {
  const chunk = Buffer.alloc(bytes.length + 12);
  chunk.writeUInt32BE(bytes.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  bytes.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

/** Complete generated grayscale PNG, including CRCs and decodable scanlines. */
function screenshotBytes(width: number, height = 900, extraTextBytes = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    ...(extraTextBytes
      ? [
          pngChunk(
            'tEXt',
            Buffer.concat([
              Buffer.from('Description\0'),
              Buffer.alloc(extraTextBytes, 65),
            ]),
          ),
        ]
      : []),
    pngChunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function assertValidPng(bytes: Buffer, width: number, height: number) {
  assert.deepEqual(
    bytes.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  assert.equal(bytes.readUInt32BE(16), width);
  assert.equal(bytes.readUInt32BE(20), height);
  const imageData: Buffer[] = [];
  const chunks: string[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const end = offset + size + 12;
    assert(end <= bytes.length);
    assert.equal(
      bytes.readUInt32BE(end - 4),
      crc32(bytes.subarray(offset + 4, end - 4)),
    );
    chunks.push(type);
    if (type === 'IDAT') imageData.push(bytes.subarray(offset + 8, end - 4));
    offset = end;
  }
  assert.equal(chunks[0], 'IHDR');
  assert.equal(chunks.at(-1), 'IEND');
  assert.equal(offset, bytes.length);
  const decoded = inflateSync(Buffer.concat(imageData));
  assert.equal(decoded.length, (width + 1) * height);
  assert(decoded.every((value) => value === 0));
}

test('playback screenshots accept every exact tracked responsive viewport as a valid PNG', () => {
  for (const [width, height] of supportedViewports) {
    const png = screenshotBytes(width, height);
    assertValidPng(png, width, height);
    assert.equal(supportedPlaybackScreenshot(png), true, `${width}x${height}`);
  }
});

test('playback screenshots reject cross-paired, adjacent and oversized PNGs', () => {
  const adjacent = supportedViewports.flatMap(([width, height]) => [
    [width - 1, height],
    [width + 1, height],
    [width, height - 1],
    [width, height + 1],
  ]);
  for (const [width, height] of [
    ...adjacent,
    [768, 844],
    [1100, 844],
    [1280, 844],
    [1600, 844],
    [844, 390],
    [900, 1280],
  ]) {
    const png = screenshotBytes(width, height);
    assertValidPng(png, width, height);
    assert.equal(supportedPlaybackScreenshot(png), false, `${width}x${height}`);
  }
  const oversized = screenshotBytes(1280, 900, 2 * 1024 * 1024);
  assertValidPng(oversized, 1280, 900);
  assert(oversized.length > 2 * 1024 * 1024);
  assert.equal(supportedPlaybackScreenshot(oversized), false);
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

for (const [width, height] of supportedViewports)
  test(`reporter retains a real ${width}x${height} screenshot and flushes hooks before its final log`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'shinema-reporter-'));
    try {
      const screenshot = join(temporary, 'generated.png');
      const png = screenshotBytes(width, height);
      assertValidPng(png, width, height);
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
