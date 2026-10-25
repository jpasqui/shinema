import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cueTextAt, parseVtt } from '../src/captions.ts';

const SAMPLE = `WEBVTT

1
00:00:01.000 --> 00:00:03.500
<i>Hello</i> &amp; welcome

00:00:03.000 --> 00:00:05.000
Second line
continues here

broken cue without timing

00:00:06.000 --> 00:00:06.000
zero length is skipped

01:00:00,5 --> 01:00:02,25
Long film, comma decimals
`;

test('parses cues, strips tags and skips malformed ones', () => {
  const cues = parseVtt(SAMPLE);
  assert.deepEqual(cues, [
    { start: 1, end: 3.5, text: 'Hello & welcome' },
    { start: 3, end: 5, text: 'Second line\ncontinues here' },
    { start: 3600.5, end: 3602.25, text: 'Long film, comma decimals' },
  ]);
});

test('finds the text on screen, including overlapping cues', () => {
  const cues = parseVtt(SAMPLE);
  assert.equal(cueTextAt(cues, 0.5), '');
  assert.equal(cueTextAt(cues, 2), 'Hello & welcome');
  assert.equal(
    cueTextAt(cues, 3.2),
    'Hello & welcome\nSecond line\ncontinues here',
  );
  assert.equal(cueTextAt(cues, 5), '');
  assert.equal(cueTextAt(cues, 3601), 'Long film, comma decimals');
});

test('Windows line endings and empty input are fine', () => {
  assert.equal(
    parseVtt('WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nHi\r\n').length,
    1,
  );
  assert.deepEqual(parseVtt(''), []);
});
