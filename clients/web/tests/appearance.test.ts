import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultAppearance,
  parseAppearance,
  recoverAppearance,
} from '../src/appearance.ts';
import { midnightTheme } from '../../../packages/design-tokens/theme.ts';

test('appearance recovers a validated custom theme and motion without sharing mutable state', () => {
  const value = { version: 1, theme: midnightTheme, motion: 'reduced' };
  const recovered = recoverAppearance(JSON.stringify(value));
  assert.equal(recovered.error, '');
  assert.deepEqual(recovered.value, value);
  assert.notEqual(recovered.value.theme, midnightTheme);
});
test('invalid preferences restore defaults and disclose recovery instead of applying untrusted data', () => {
  for (const raw of [
    'null',
    '[]',
    '{',
    'x'.repeat(12001),
    JSON.stringify({ ...defaultAppearance(), version: 2 }),
    JSON.stringify({ ...defaultAppearance(), motion: 'always' }),
    JSON.stringify({
      ...defaultAppearance(),
      css: 'url(https://invalid.example)',
    }),
    JSON.stringify({
      ...defaultAppearance(),
      theme: { version: 1, name: 'Bad', colors: { background: 'red' } },
    }),
  ]) {
    const recovered = recoverAppearance(raw);
    assert.deepEqual(recovered.value, defaultAppearance());
    assert.ok(recovered.error);
  }
});
test('missing preferences use defaults and parsing rejects unexpected keys', () => {
  assert.equal(recoverAppearance(null).error, '');
  assert.throws(() =>
    parseAppearance({ ...defaultAppearance(), script: 'bad' }),
  );
});
