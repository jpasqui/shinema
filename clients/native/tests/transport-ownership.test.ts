import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NativeTransportPolicy,
  NativeTransportScope,
} from '../src/transport.ts';

const first = 'http://127.0.0.1:29991';
const second = 'http://127.0.0.1:29992';
const grant = (origin: string) => Object.freeze({ localHttpOrigin: origin });

/** Model the native singleton: replacement revokes before asynchronous DNS. */
function nativeSingleton() {
  let generation = 0;
  let origin: string | null = null;
  const calls: (string | null)[] = [];
  const approvals: (() => void)[] = [];
  const replace = (next: string | null): Promise<void> => {
    const ticket = ++generation;
    origin = null;
    calls.push(next);
    if (next === null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      approvals.push(() => {
        if (ticket !== generation)
          reject(new Error('Superseded native policy'));
        else {
          origin = next;
          resolve();
        }
      });
    });
  };
  return { calls, approvals, replace, origin: () => origin };
}

test('late old-App cleanup cannot revoke a new App that already holds the native grant', async () => {
  const native = nativeSingleton();
  const scope = new NativeTransportScope();
  const oldApp = new NativeTransportPolicy(native.replace, undefined, scope);
  oldApp.claim();
  const firstActivation = oldApp.activate(first, grant(first));
  native.approvals.shift()!();
  assert.equal(await firstActivation, true);
  const nextApp = new NativeTransportPolicy(native.replace, undefined, scope);
  nextApp.claim();
  assert.equal(oldApp.permits(first, grant(first)), false);
  const nextActivation = nextApp.activate(second, grant(second));
  native.approvals.shift()!();
  assert.equal(await nextActivation, true);

  assert.equal(await oldApp.dispose(), false);
  assert.equal(await oldApp.activate(first, grant(first)), false);
  assert.equal(await oldApp.restore(first, grant(first)), false);
  assert.equal(await oldApp.revoke(), false);
  assert.equal(await nextApp.restore(second, grant(second)), true);
  assert.deepEqual(native.calls, [first, second]);
  assert.equal(native.origin(), second);
  assert.equal(nextApp.permits(second, grant(second)), true);
});

test('old cleanup and late old restore cannot cancel the next App pending native approval', async () => {
  const native = nativeSingleton();
  const scope = new NativeTransportScope();
  const oldApp = new NativeTransportPolicy(native.replace, undefined, scope);
  oldApp.claim();
  const firstActivation = oldApp.activate(first, grant(first));
  native.approvals.shift()!();
  await firstActivation;
  const nextApp = new NativeTransportPolicy(native.replace, undefined, scope);
  nextApp.claim();
  const nextActivation = nextApp.activate(second, grant(second));
  assert.equal(await oldApp.restore(first, grant(first)), false);
  assert.equal(await oldApp.dispose(), false);
  assert.deepEqual(native.calls, [first, second]);
  native.approvals.shift()!();
  assert.equal(await nextActivation, true);
  assert.equal(native.origin(), second);
  assert.equal(nextApp.permits(second, grant(second)), true);
});

test('a queued old completion cannot mark its policy ready after a new owner claims', async () => {
  const completions: (() => void)[] = [];
  const calls: (string | null)[] = [];
  // Also exercise a host transport that does not reject a superseded result.
  const replace = (origin: string | null) => {
    calls.push(origin);
    return new Promise<void>((resolve) => completions.push(resolve));
  };
  const scope = new NativeTransportScope();
  const oldApp = new NativeTransportPolicy(replace, undefined, scope);
  oldApp.claim();
  const oldActivation = oldApp.activate(first, grant(first));
  const nextApp = new NativeTransportPolicy(replace, undefined, scope);
  nextApp.claim();
  const nextActivation = nextApp.activate(second, grant(second));
  completions.shift()!();
  assert.equal(await oldActivation, false);
  assert.equal(oldApp.permits(first, grant(first)), false);
  completions.shift()!();
  assert.equal(await nextActivation, true);
  assert.equal(nextApp.permits(second, grant(second)), true);
  assert.deepEqual(calls, [first, second]);
});

test('current-owner revoke stays immediate, and final disposal revokes and blocks late work', async () => {
  const native = nativeSingleton();
  const scope = new NativeTransportScope();
  const app = new NativeTransportPolicy(native.replace, undefined, scope);
  assert.equal(await app.activate(first, grant(first)), false);
  assert.deepEqual(native.calls, []);
  app.claim();
  const pending = app.activate(first, grant(first));
  const revoked = app.revoke();
  assert.deepEqual(native.calls, [first, null]);
  native.approvals.shift()!();
  assert.equal(await pending, false);
  assert.equal(await revoked, true);
  const activation = app.activate(first, grant(first));
  native.approvals.shift()!();
  await activation;
  const disposed = app.dispose();
  assert.equal(native.origin(), null);
  assert.equal(app.permits(first, grant(first)), false);
  assert.equal(await disposed, true);
  assert.equal(await app.restore(first, grant(first)), false);
  assert.equal(await app.dispose(), false);
  assert.deepEqual(native.calls, [first, null, first, null]);
});

test('effect cleanup and re-setup can claim a fresh lease on the same policy', async () => {
  const native = nativeSingleton();
  const scope = new NativeTransportScope();
  const app = new NativeTransportPolicy(native.replace, undefined, scope);
  app.claim();
  const obsolete = app.activate(first, grant(first));
  const disposed = app.dispose();
  app.claim();
  const current = app.activate(second, grant(second));
  native.approvals.shift()!();
  assert.equal(await obsolete, false);
  assert.equal(await disposed, false);
  native.approvals.shift()!();
  assert.equal(await current, true);
  assert.equal(native.origin(), second);
  assert.equal(app.permits(second, grant(second)), true);
  assert.deepEqual(native.calls, [first, null, second]);
});
