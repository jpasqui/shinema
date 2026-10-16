import assert from 'node:assert/strict';
import test from 'node:test';
import { moveSetupFocus, setupScrollOffset } from '../src/setup-focus.ts';

test('setup D-pad order reaches explicit HTTP consent, address, and both independent header actions', () => {
  assert.equal(moveSetupFocus('connect', -1), 'http');
  assert.equal(moveSetupFocus('http', -1), 'address');
  assert.equal(moveSetupFocus('address', -1), 'requests');
  assert.equal(moveSetupFocus('requests', -1), 'appearance');
  assert.equal(moveSetupFocus('appearance', -1), 'appearance');
  assert.equal(moveSetupFocus('appearance', 1), 'requests');
  assert.equal(moveSetupFocus('requests', 1), 'address');
  assert.equal(moveSetupFocus('address', 1), 'http');
  assert.equal(moveSetupFocus('http', 1), 'connect');
  assert.equal(moveSetupFocus('connect', 1), 'connect');
});

test('setup reveals the entire measured Connect target in a short TV scene', () => {
  // A 960x540dp TV leaves 368dp for the scene after shell and header.
  const bounds = {
    address: { y: 144, height: 56 },
    http: { y: 216, height: 68 },
    connect: { y: 360, height: 54 },
  };
  const viewport = 368;
  const offset = setupScrollOffset(0, 'connect', 12, bounds, viewport);
  assert.equal(offset, 70);
  assert.ok(12 + bounds.connect.y >= offset + 12);
  assert.ok(
    12 + bounds.connect.y + bounds.connect.height <= offset + viewport - 12,
  );
  assert.equal(
    setupScrollOffset(offset, 'connect', 12, bounds, viewport),
    offset,
  );
  assert.equal(setupScrollOffset(offset, 'http', 12, bounds, viewport), offset);
  assert.equal(
    setupScrollOffset(offset, 'address', 12, bounds, viewport),
    offset,
  );
  assert.equal(setupScrollOffset(offset, 'requests', 12, bounds, viewport), 0);
  assert.equal(
    setupScrollOffset(offset, 'appearance', 12, bounds, viewport),
    0,
  );
});

test('setup remeasures after warning reflow and viewport changes without guessing positions', () => {
  assert.equal(setupScrollOffset(25, 'connect', 0, {}, 368), 25);
  const bounds = { connect: { y: 436, height: 54 } };
  assert.equal(setupScrollOffset(70, 'connect', 12, bounds, 368), 146);
  assert.equal(setupScrollOffset(146, 'connect', 12, bounds, 300), 214);
  assert.equal(
    setupScrollOffset(
      214,
      'address',
      12,
      { address: { y: 144, height: 56 } },
      300,
    ),
    144,
  );
});
