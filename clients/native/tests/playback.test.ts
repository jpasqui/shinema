import assert from 'node:assert/strict';
import test from 'node:test';
import { initialPlayback, loadedPlayback } from '../src/playback.ts';
import { SubtitleClock } from '../src/subtitles.ts';

const uri = 'https://video.example/api/media/' + 'a'.repeat(64) + '/stream';

test('initial native source captures resume milliseconds before the player mounts', () => {
  assert.equal(initialPlayback(uri, null).source.startPosition, 0);
  assert.equal(
    initialPlayback(uri, { positionSeconds: 0, durationSeconds: 220 }).source
      .startPosition,
    0,
  );
  const initial = initialPlayback(uri, {
    positionSeconds: 69.125,
    durationSeconds: 220,
  });
  assert.equal(initial.source.uri, uri);
  assert.equal(initial.source.startPosition, 69125);
  assert.equal(initial.positionSeconds, 69.125);
  assert.equal(
    initialPlayback(uri, { positionSeconds: 217, durationSeconds: 220 }).source
      .startPosition,
    0,
  );
  assert.equal(
    initialPlayback(uri, { positionSeconds: 220, durationSeconds: 220 }).source
      .startPosition,
    0,
  );
});

test('a play session owns a stable source and copied progress until a new play is accepted', () => {
  const saved = { positionSeconds: 69, durationSeconds: 220 };
  const initial = initialPlayback(uri, saved);
  const source = initial.source;
  saved.positionSeconds = 75;
  saved.durationSeconds = 221;
  loadedPlayback(initial, 220, 69.2);
  loadedPlayback(initial, 220, 75);
  assert.equal(initial.source, source);
  assert.deepEqual(source, { uri, startPosition: 69000 });
  assert.deepEqual(initial.progress, {
    positionSeconds: 69,
    durationSeconds: 220,
  });
  assert.equal(Object.isFrozen(initial), true);
  assert.equal(Object.isFrozen(source), true);
  const next = initialPlayback(uri, saved);
  assert.notEqual(next.source, source);
  assert.equal(next.source.startPosition, 75000);
});

test('native initial positioning is ready on load without an onSeek callback', () => {
  const initial = initialPlayback(uri, {
    positionSeconds: 69,
    durationSeconds: 220,
  });
  const loaded = loadedPlayback(initial, 220, 69.125);
  assert.deepEqual(loaded, { positionSeconds: 69.125, seekTo: null });
  const clock = new SubtitleClock();
  clock.reset(initial.positionSeconds);
  clock.update(loaded.positionSeconds);
  assert.equal(clock.update(70), 70);
  assert.equal(loadedPlayback(initial, 220, 70).seekTo, null);
});

test('changed actual duration corrects restart decisions without replacing the source', () => {
  const initial = initialPlayback(uri, {
    positionSeconds: 69,
    durationSeconds: 220,
  });
  assert.deepEqual(loadedPlayback(initial, 70, 69), {
    positionSeconds: 0,
    seekTo: 0,
  });
  const completed = initialPlayback(uri, {
    positionSeconds: 218,
    durationSeconds: 220,
  });
  assert.deepEqual(loadedPlayback(completed, 300, 0), {
    positionSeconds: 218,
    seekTo: 218,
  });
  assert.equal(initial.source.startPosition, 69000);
  assert.equal(completed.source.startPosition, 0);
  const clock = new SubtitleClock();
  clock.reset(69);
  clock.seek(0);
  assert.equal(Number.isNaN(clock.update(69)), true);
  assert.equal(clock.update(0.1), 0.1);
});
