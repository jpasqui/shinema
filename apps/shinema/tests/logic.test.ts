import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickNeighbour, type Rect } from '../src/focus/spatial.ts';
import { SeekTarget } from '../src/player/seek.ts';
import { KeyPresses } from '../src/platform/key-presses.ts';

const cell = (column: number, row: number): Rect => ({
  left: column * 110,
  top: row * 170,
  width: 100,
  height: 160,
});

test('arrow keys move within a poster grid like a remote', () => {
  const grid = [cell(0, 0), cell(1, 0), cell(2, 0), cell(0, 1), cell(1, 1)];
  assert.equal(pickNeighbour(grid[0]!, grid, 'right'), 1);
  assert.equal(pickNeighbour(grid[1]!, grid, 'down'), 4);
  assert.equal(pickNeighbour(grid[4]!, grid, 'up'), 1);
  assert.equal(pickNeighbour(grid[3]!, grid, 'left'), -1);
  // From the last column, Down picks the nearest item in the next row.
  assert.equal(pickNeighbour(grid[2]!, grid, 'down'), 4);
});

test('the header row is reachable with Up from the grid', () => {
  const header: Rect = { left: 0, top: -80, width: 400, height: 40 };
  const items = [header, cell(0, 0), cell(1, 0)];
  assert.equal(pickNeighbour(items[2]!, items, 'up'), 0);
});

test('repeated seeks accumulate before the player catches up', () => {
  const seek = new SeekTarget();
  assert.equal(seek.step(100, 600, 10, 0), 110);
  // The player still reports 100, but the next press builds on 110.
  assert.equal(seek.step(100, 600, 10, 200), 120);
  assert.equal(seek.step(100, 600, 10, 400), 130);
  assert.equal(seek.current(100, 500), 130);
  // After the seek has landed, the reported time is trusted again.
  assert.equal(seek.current(131, 3000), 131);
});

test('seeks stay inside the title', () => {
  const seek = new SeekTarget();
  assert.equal(seek.step(5, 600, -10, 0), 0);
  assert.equal(seek.step(595, 600, 10, 5000), 599);
});

test('a remote press acts once whether Android sends key-up alone or both', () => {
  const presses = new KeyPresses();
  // Default Android TV: key-up only, one per press.
  assert.equal(presses.accept('right', 1), true);
  assert.equal(presses.accept('right', 1), true);
  // Key-down events enabled: act on the down, not the matching up.
  assert.equal(presses.accept('left', 0), true);
  assert.equal(presses.accept('left', 1), false);
  // A held key repeats its key-down; the release does not add a step.
  assert.equal(presses.accept('right', 0), true);
  assert.equal(presses.accept('right', 0), true);
  assert.equal(presses.accept('right', 1), false);
  // Events without a key action, such as Apple TV gestures, always act.
  assert.equal(presses.accept('up', -1), true);
});
