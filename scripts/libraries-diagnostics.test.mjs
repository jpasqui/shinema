import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import test from 'node:test';
import {
  closeLibraryResources,
  diagnosticCategory,
  libraryDiagnosticLog,
  libraryDiagnostics,
  redactDiagnosticText,
} from './libraries-diagnostics.mjs';

test('owned teardown is bounded and still attempts later resources after a stuck close', async () => {
  const closed = [];
  const started = Date.now();
  const failed = await closeLibraryResources(
    {
      context: { close: () => new Promise(() => {}) },
      browser: { close: async () => closed.push('browser') },
      vite: {
        close: async () => {
          throw new Error('Generated private marker');
        },
      },
      stopServer: async () => closed.push('server'),
    },
    25,
  );
  assert.deepEqual(failed, ['context', 'vite']);
  assert.deepEqual(closed, ['browser', 'server']);
  assert(Date.now() - started < 2000);
});

const revision = 'a'.repeat(40);
const syntheticSecret = 'generated-ephemeral-operator-' + 'x'.repeat(40);
async function fixture(body) {
  const directory = await mkdtemp(
    join(tmpdir(), 'shinema-library-diagnostics-'),
  );
  try {
    await body(directory);
  } finally {
    assert(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    assert(basename(directory).startsWith('shinema-library-diagnostics-'));
    await rm(directory, { recursive: true, force: true });
  }
}

test('diagnostic screenshot text removes addresses, host paths and credentials', () => {
  const inputs = [
    syntheticSecret,
    'C:/Users/generated-fixture/private',
    'C:\\Users\\generated-fixture\\private',
    '/home/generated-fixture/private',
    '/volume1/generated-fixture',
    'https://fixture:password@example.invalid/private',
    'ghp_' + 'x'.repeat(36),
    'Bearer ' + 'x'.repeat(40),
    '192.168.2.3',
    '172.16.2.3',
    '10.2.3.4',
    'id_ed25519',
  ];
  for (const value of inputs) {
    const result = redactDiagnosticText(`Library failure ${value}`, [
      syntheticSecret,
    ]);
    assert(!result.includes(value));
    assert(result.startsWith('Library failure '));
  }
  assert.equal(
    redactDiagnosticText('Library settings: Anime'),
    'Library settings: Anime',
  );
});

test('error classification returns only a bounded category, never the message', () => {
  assert.equal(
    diagnosticCategory({ name: 'AssertionError', message: syntheticSecret }),
    'assertion',
  );
  assert.equal(
    diagnosticCategory({ name: 'TimeoutError', message: syntheticSecret }),
    'timeout',
  );
  assert.equal(
    diagnosticCategory(new TypeError('fetch failed: ' + syntheticSecret)),
    'network',
  );
  assert.equal(
    diagnosticCategory(
      new Error('Synthetic server exited: ' + syntheticSecret),
    ),
    'startup',
  );
  assert.equal(diagnosticCategory(new Error(syntheticSecret)), 'runner');
});

test('redaction spans text nodes so split credentials and paths cannot survive', () => {
  const parts = [
    'Safe ',
    syntheticSecret.slice(0, 20),
    syntheticSecret.slice(20, 40),
    syntheticSecret.slice(40),
    ' ending',
  ];
  const redacted = redactDiagnosticText(parts, [syntheticSecret]);
  assert.equal(redacted[0], 'Safe ');
  assert.equal(redacted.at(-1), ' ending');
  assert(!redacted.join('').includes(syntheticSecret));
  assert(redacted.slice(1, -1).every((part) => part === '[redacted]'));
  assert(
    !redactDiagnosticText(['C:/Users/', 'generated-fixture/', 'private'])
      .join('')
      .includes('generated-fixture'),
  );
});

test('a wedged renderer produces bounded metadata-only diagnostics', async () => {
  await fixture(async (directory) => {
    const page = {
      isClosed: () => false,
      url: () => 'http://127.0.0.1:1234',
      evaluate: () => new Promise(() => {}),
      screenshot: async () =>
        assert.fail('Screenshot must not run after a stalled scrub'),
    };
    const started = Date.now();
    const data = await libraryDiagnostics({
      directory,
      revision,
      timeoutMs: 25,
    }).save({ page, stage: 'browser-settings', completedChecks: 4 });
    assert.equal(data.screenshot, false);
    assert(Date.now() - started < 2000);
    assert.deepEqual((await readdir(directory)).sort(), [
      'browser-test.log',
      'failure.json',
    ]);
  });
});

test('failure artifacts retain event counts and canonical metadata without raw errors or state', async () => {
  await fixture(async (directory) => {
    const diagnostics = libraryDiagnostics({
      directory,
      revision,
      secrets: [syntheticSecret],
    });
    const context = new EventEmitter();
    const page = new EventEmitter();
    context.pages = () => [page];
    diagnostics.observe(context);
    page.emit('console', { type: () => 'error', text: () => syntheticSecret });
    page.emit(
      'pageerror',
      new Error('/home/generated-fixture/private ' + syntheticSecret),
    );
    page.emit('requestfailed', {
      url: () => 'https://fixture:password@example.invalid',
    });
    const data = await diagnostics.save({
      stage: 'browser-settings',
      error: new Error(syntheticSecret),
      completedChecks: 7,
    });
    assert.deepEqual(data.events, {
      consoleErrors: 1,
      pageErrors: 1,
      requestFailures: 1,
    });
    assert.equal(data.screenshot, false);
    assert.deepEqual((await readdir(directory)).sort(), [
      'browser-test.log',
      'failure.json',
    ]);
    const log = await readFile(join(directory, 'browser-test.log'), 'utf8');
    assert.equal(log, libraryDiagnosticLog(data));
    const summary = await readFile(join(directory, 'failure.json'), 'utf8');
    assert(!summary.includes(syntheticSecret));
    assert(!summary.includes('/home/'));
    assert(!summary.includes('message'));
    assert(!summary.includes('storage'));
    assert(!log.includes(syntheticSecret));
  });
});

test('unexpected pages and screenshot failures produce metadata only', async () => {
  for (const url of ['https://untrusted.example', 'http://127.0.0.1:1234']) {
    await fixture(async (directory) => {
      const page = {
        isClosed: () => false,
        url: () => url,
        evaluate: async () => {},
        screenshot: async () => {
          throw new Error(syntheticSecret);
        },
      };
      const data = await libraryDiagnostics({ directory, revision }).save({
        page,
        stage: 'browser-search',
        error: new Error(syntheticSecret),
        completedChecks: 4,
      });
      assert.equal(data.screenshot, false);
      assert.deepEqual((await readdir(directory)).sort(), [
        'browser-test.log',
        'failure.json',
      ]);
    });
  }
});

test('fixed image bounds omit oversized or unexpected viewport images', async () => {
  for (const [width, height, size] of [
    [1280, 900, 100],
    [1440, 1000, 2 * 1024 * 1024 + 1],
  ]) {
    await fixture(async (directory) => {
      const bytes = Buffer.alloc(size);
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
      bytes.writeUInt32BE(width, 16);
      bytes.writeUInt32BE(height, 20);
      const page = {
        isClosed: () => false,
        url: () => 'http://127.0.0.1:1234',
        evaluate: async () => {},
        screenshot: async () => bytes,
      };
      const data = await libraryDiagnostics({ directory, revision }).save({
        page,
        stage: 'browser-settings',
        error: new Error('fixture'),
        completedChecks: 4,
      });
      assert.equal(data.screenshot, false);
      assert(!(await readdir(directory)).includes('failure-1.png'));
    });
  }
});

test('diagnostic metadata is bounded and existing output is never overwritten', async () => {
  await fixture(async (directory) => {
    assert.throws(() =>
      libraryDiagnostics({ directory, revision: '/home/generated/private' }),
    );
    const diagnostics = libraryDiagnostics({ directory, revision });
    await assert.rejects(
      diagnostics.save({ stage: 'raw ' + syntheticSecret, completedChecks: 1 }),
    );
    await assert.rejects(
      diagnostics.save({ stage: 'setup', completedChecks: 1001 }),
    );
    await writeFile(join(directory, 'existing.txt'), 'generated fixture');
    await assert.rejects(
      diagnostics.save({ stage: 'setup', completedChecks: 0 }),
    );
    assert.equal(
      await readFile(join(directory, 'existing.txt'), 'utf8'),
      'generated fixture',
    );
  });
});
