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
} from './e2e/diagnostics-reporter.ts';

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

test('reporter flushes non-awaited hooks before declaring screenshots in the final log', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'shinema-reporter-'));
  try {
    const screenshot = join(temporary, 'generated.png');
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(1280, 16);
    png.writeUInt32BE(900, 20);
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
