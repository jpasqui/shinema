import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreBrowserResume } from '../src/playback.ts';

test('native HLS and direct playback restore saved resume after metadata', () => {
  for (const driver of ['native-hls', 'direct'] as const) {
    const node = { currentTime: 0, duration: 600 };
    restoreBrowserResume(node, driver, {
      positionSeconds: 180,
      durationSeconds: 600,
    });
    assert.equal(node.currentTime, 180);
  }
});

test('hls.js leaves timeline positioning to startPosition without an early seek', () => {
  const node = { currentTime: 0, duration: 600 };
  restoreBrowserResume(node, 'hls-js', {
    positionSeconds: 180,
    durationSeconds: 600,
  });
  assert.equal(node.currentTime, 0);
});

test('browser resume waits for a finite VOD duration and restarts completed playback', () => {
  const node = { currentTime: 0, duration: Infinity };
  restoreBrowserResume(node, 'native-hls', {
    positionSeconds: 180,
    durationSeconds: 600,
  });
  assert.equal(node.currentTime, 0);
  node.duration = 600;
  restoreBrowserResume(node, 'native-hls', {
    positionSeconds: 599,
    durationSeconds: 600,
  });
  assert.equal(node.currentTime, 0);
});
