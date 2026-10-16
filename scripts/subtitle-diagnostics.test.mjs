import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { subtitleDiagnostics } from './subtitle-diagnostics.mjs';

async function temporary(context) {
  const directory = await mkdtemp(
    join(tmpdir(), 'shinema-subtitle-diagnostics-'),
  );
  context.after(async () => {
    const target = resolve(directory);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith('shinema-subtitle-diagnostics-')
    )
      throw new Error('Unexpected temporary cleanup target');
    await rm(target, { recursive: true, force: true });
  });
  return directory;
}

function screenshot(width = 1280, height = 1080) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test('failure retention keeps a fixed screenshot and useful source location, excluding raw input', async (context) => {
  const directory = await temporary(context);
  const diagnostics = subtitleDiagnostics(directory);
  await diagnostics.prepare();
  diagnostics.at('subtitle-playback');
  let pageError;
  const page = {
    on: (_event, handler) => {
      pageError = handler;
    },
    isClosed: () => false,
    url: () => 'http://127.0.0.1:29883/',
    screenshot: async (options) => {
      assert.equal(options.fullPage, false);
      assert.equal(options.timeout, 5000);
      return screenshot();
    },
  };
  diagnostics.observe(page);
  for (let index = 0; index < 150; index++)
    pageError(new Error('Private page message'));
  const source = new URL('./subtitle-smoke.mjs', import.meta.url).href;
  await diagnostics.save(
    { stack: `Private raw error /home/generated/private\n at ${source}:321:9` },
    {
      page,
      completedChecks: 4,
      serverState: 'running',
    },
  );
  const data = JSON.parse(
    await readFile(join(directory, 'failure.json'), 'utf8'),
  );
  assert.equal(data.line, 321);
  assert.equal(data.phase, 'subtitle-playback');
  assert.equal(data.completedChecks, 4);
  assert.equal(data.pageErrors, 100);
  assert.equal(data.screenshot, true);
  assert.equal(
    await readFile(join(directory, 'browser-test.log'), 'utf8'),
    'Generated-only subtitle smoke: failed\nscripts/subtitle-smoke.mjs:321 phase=subtitle-playback\ncompletedChecks=4 pageErrors=100 serverState=running screenshot=failure.png\n',
  );
  const retained =
    (await readFile(join(directory, 'failure.json'), 'utf8')) +
    (await readFile(join(directory, 'browser-test.log'), 'utf8'));
  assert.equal(retained.includes('Private'), false);
  assert.equal(retained.includes('/home/'), false);
});

test('startup and unavailable or unsuitable screenshots still retain only structured logs', async (context) => {
  for (const page of [
    undefined,
    { isClosed: () => true },
    {
      isClosed: () => false,
      url: () => 'https://example.invalid/',
      screenshot: () => {
        throw new Error('Must not capture');
      },
    },
    {
      isClosed: () => false,
      url: () => 'http://127.0.0.1:29883/',
      screenshot: async () => {
        throw new Error('Private browser stack');
      },
    },
    {
      isClosed: () => false,
      url: () => 'http://127.0.0.1:29883/',
      screenshot: async () => screenshot(1280, 900),
    },
    {
      isClosed: () => false,
      url: () => 'http://127.0.0.1:29883/',
      screenshot: async () => Buffer.alloc(2 * 1024 * 1024 + 1),
    },
  ]) {
    const directory = await temporary(context);
    const diagnostics = subtitleDiagnostics(directory);
    await diagnostics.prepare();
    await diagnostics.save(new Error('Private startup error'), {
      page,
      completedChecks: Infinity,
      serverState: 'raw private value',
    });
    assert.deepEqual((await readdir(directory)).sort(), [
      'browser-test.log',
      'failure.json',
    ]);
    const data = JSON.parse(
      await readFile(join(directory, 'failure.json'), 'utf8'),
    );
    assert.equal(data.screenshot, false);
    assert.equal(data.line, 0);
    assert.equal(data.completedChecks, 0);
    assert.equal(data.serverState, 'not-started');
    assert.throws(() => diagnostics.at('raw private phase'));
  }
});

test('prepare removes only stale allowlisted files and refuses unexpected entries or links', async (context) => {
  const directory = await temporary(context);
  const diagnostics = subtitleDiagnostics(directory);
  for (const name of ['failure.png', 'failure.json', 'browser-test.log'])
    await writeFile(join(directory, name), 'stale');
  await diagnostics.prepare();
  assert.deepEqual(await readdir(directory), []);
  await writeFile(join(directory, 'private.txt'), 'unrelated');
  await assert.rejects(diagnostics.prepare(), /Unexpected/);
  assert.equal(
    await readFile(join(directory, 'private.txt'), 'utf8'),
    'unrelated',
  );
  const nested = join(await temporary(context), 'failure.png');
  await mkdir(nested);
  await assert.rejects(
    subtitleDiagnostics(dirname(nested)).prepare(),
    /Unexpected/,
  );
  const linked = await temporary(context);
  try {
    await symlink(join(directory, 'private.txt'), join(linked, 'failure.json'));
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return;
    throw error;
  }
  await assert.rejects(subtitleDiagnostics(linked).prepare(), /Unexpected/);
});
