import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultSubtitle,
  parseSubtitles,
} from '../../../packages/contracts/index.ts';
import { subtitleContent, SubtitlePreferences } from '../src/subtitles.ts';

const media = 'a'.repeat(64);
const track = (id: string, language?: string) => ({
  id,
  label: id,
  language,
  default: false,
  source: 'external' as const,
  contentPath: `/api/media/${media}/subtitles/${id}.vtt`,
});
test('defaults, preferred language aliases, no match and unsupported defaults', () => {
  const en = track('english', 'eng');
  const fr = track('french', 'fr');
  assert.equal(defaultSubtitle([en, fr], ['fr-CA']), fr.id);
  assert.equal(defaultSubtitle([{ ...en, default: true }, fr], ['fr']), en.id);
  assert.equal(defaultSubtitle([en], ['ja']), '');
  assert.equal(
    defaultSubtitle(
      [
        en,
        {
          ...fr,
          default: true,
          contentPath: undefined,
          unsupportedReason: 'Image subtitles',
        },
      ],
      ['en-US'],
    ),
    en.id,
  );
  assert.equal(defaultSubtitle([], ['en']), '');
});
test('subtitle contracts reject duplicate IDs, cross-media paths and unsafe input', () => {
  const valid = {
    tracks: [track('one', 'en')],
    warnings: ['Remote sidecars unavailable.'],
  };
  assert.deepEqual(parseSubtitles(valid, media), valid);
  for (const tracks of [
    [track('one'), track('one')],
    [{ ...track('one'), contentPath: 'https://example.com/sub.vtt' }],
    [
      {
        ...track('one'),
        contentPath: `/api/media/${'b'.repeat(64)}/subtitles/one.vtt`,
      },
    ],
    [{ ...track('one'), unsupportedReason: 'Unsupported' }],
    [{ ...track('one'), language: '../../en' }],
    [{ ...track('one'), label: 'unsafe\nlabel' }],
    [{ ...track('one'), source: ['embedded'] }],
    [{ ...track('one'), source: null }],
    [track('../escape')],
    Array.from({ length: 65 }, (_, n) => track(`track-${n}`)),
  ])
    assert.throws(() => parseSubtitles({ tracks }, media));
  assert.throws(() =>
    parseSubtitles({ tracks: [], warnings: ['bad\u0000'] }, media),
  );
});
test('session choices distinguish Auto and Off, retain selected tracks and remain bounded', () => {
  const preferences = new SubtitlePreferences();
  assert.equal(preferences.get(media), undefined);
  preferences.set(media, '');
  assert.equal(preferences.get(media), '');
  preferences.set(media, 'english');
  assert.equal(preferences.get(media), 'english');
  preferences.set(media, undefined);
  assert.equal(preferences.get(media), undefined);
  for (let n = 0; n < 129; n++) preferences.set(String(n), '');
  assert.equal(preferences.get('0'), undefined);
  assert.equal(preferences.get('128'), '');
});
test('bounded subtitle reads validate UTF-8, WebVTT header, failure and cancellation', async () => {
  const original = globalThis.fetch;
  try {
    for (const content of [
      'WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nResume cue\n',
      'WEBVTT\n',
    ]) {
      globalThis.fetch = async () => new Response(content);
      assert.equal(
        await subtitleContent('/track', new AbortController().signal),
        content,
      );
    }
    for (const response of [
      new Response('not VTT'),
      new Response(new Uint8Array([0xff, 0xfe])),
      new Response('WEBVTT\n' + 'x'.repeat(4 * 1024 * 1024)),
      new Response('error', { status: 503 }),
    ]) {
      globalThis.fetch = async () => response;
      await assert.rejects(
        subtitleContent('/track', new AbortController().signal),
      );
    }
    const controller = new AbortController();
    globalThis.fetch = async (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    const pending = subtitleContent('/track', controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  } finally {
    globalThis.fetch = original;
  }
});
