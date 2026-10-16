import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveTheme,
  defaultTheme,
  midnightTheme,
} from '../../../packages/design-tokens/theme.ts';
import type {
  Theme,
  ThemeDesign,
} from '../../../packages/design-tokens/theme.ts';
import {
  nativeArtworkTypography,
  nativeDetailScene,
  nativeFeatureScene,
  nativeGridFrame,
  nativeHeaderStripIndex,
  nativeHeaderScrollOffset,
  nativeReservedGeometry,
  nativeSkinLayout,
} from '../src/skin-layout.ts';
import { feedItemTop } from '../src/feed.ts';
import { focusScrollOffset } from '../src/preferences.ts';

function designed(design: Partial<ThemeDesign>, theme = defaultTheme): Theme {
  return { ...theme, design: { ...theme.design, ...design } };
}
function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} != ${expected}`);
}
const tvSizes = [
  [960, 540],
  [1280, 720],
  [1600, 900],
  [1920, 1080],
] as const;

test('Marquee uses six to eight natural posters on TV and keeps phone and landscape choices', () => {
  for (const [width, height, columns] of [
    [960, 540, 6],
    [1280, 720, 7],
    [1600, 900, 8],
    [1920, 1080, 8],
  ]) {
    assert.equal(
      nativeSkinLayout(defaultTheme, width, height).columns,
      columns,
    );
    assert.equal(
      nativeSkinLayout(designed({ density: 'compact' }), width, height).columns,
      columns + 1,
    );
    assert.equal(nativeSkinLayout(archiveTheme, width, height).columns, 4);
    assert.equal(
      nativeSkinLayout(designed({ cards: 'landscape' }), width, height).columns,
      width < 1200 ? 4 : 5,
    );
  }
  for (const width of [320, 390, 699]) {
    for (const cards of ['poster', 'landscape'] as const) {
      assert.equal(
        nativeSkinLayout(designed({ cards }), width, 844).columns,
        2,
      );
      assert.equal(
        nativeSkinLayout(designed({ cards, density: 'compact' }), width, 844)
          .columns,
        2,
      );
    }
  }
});

test('actual artwork keeps 2:3 or 16:9 proportions instead of squeezing posters to screen height', () => {
  for (const [width, height] of [[390, 844], ...tvSizes]) {
    for (const density of ['comfortable', 'compact'] as const) {
      for (const cards of ['poster', 'landscape'] as const) {
        const theme = designed({ density, cards });
        const layout = nativeSkinLayout(theme, width, height);
        near(
          layout.cardArtWidth / layout.cardArtHeight,
          cards === 'poster' ? 2 / 3 : 16 / 9,
        );
        near(layout.cardArtWidth, layout.cardWidth - 8);
        near(layout.cardImageHeight, layout.cardArtHeight);
        near(
          nativeSkinLayout(theme, width, height + 540).cardHeight,
          layout.cardHeight,
        );
        assert.ok(layout.cardTitleLine >= layout.cardTitleSize + 4);
        assert.equal(layout.cardTitleHeight, layout.cardTitleLine * 2);
        assert.ok(layout.cardTitleHeight >= 38);
        const occupied =
          layout.cardInset * 2 +
          layout.cardImageHeight +
          layout.cardCaptionGap +
          layout.cardTitleHeight +
          layout.cardMetadataGap +
          layout.cardMetadataHeight;
        near(occupied, layout.cardHeight);
        assert.equal(layout.cardInset, layout.cardBorder + layout.cardPadding);
      }
    }
  }
});

test('Archive retains a bounded programme card with undistorted centred artwork', () => {
  for (const [width, height] of tvSizes) {
    const layout = nativeSkinLayout(archiveTheme, width, height);
    assert.ok(layout.cardHeight <= Math.max(190, (height - 280) * 0.65));
    assert.ok(layout.cardArtWidth <= layout.cardImageWidth);
    assert.ok(layout.cardArtHeight <= layout.cardImageHeight + 0.000001);
    near(layout.cardArtWidth / layout.cardArtHeight, 2 / 3);
  }
});

test('all global row frames fit the same columns across data, error, focus and append states', () => {
  for (const [width, height] of tvSizes) {
    for (const density of ['comfortable', 'compact'] as const) {
      for (const cards of ['poster', 'landscape'] as const) {
        const theme = designed({ density, cards });
        const layout = nativeSkinLayout(theme, width, height);
        const right = nativeGridFrame(theme, width, height, layout.columns - 1);
        near(right.left + right.width, width - layout.inset * 2);
        near(
          nativeGridFrame(theme, width, height, layout.columns).top,
          layout.cardHeight + layout.gap,
        );
        for (const index of [
          0,
          layout.columns - 1,
          layout.columns,
          48,
          73,
          9999,
        ]) {
          const frame = nativeGridFrame(theme, width, height, index);
          near(
            frame.top,
            feedItemTop(index, layout.columns, layout.cardHeight + layout.gap),
          );
          near(frame.width, layout.cardWidth);
          near(frame.height, layout.cardHeight);
          assert.ok(frame.left >= 0);
          assert.ok(
            frame.left + frame.width <= width - layout.inset * 2 + 0.000001,
          );
        }
        const last = nativeGridFrame(theme, width, height, 9999);
        assert.ok(
          last.top + last.height <=
            Math.ceil(10000 / layout.columns) *
              (layout.cardHeight + layout.gap),
        );
      }
    }
  }
});

test('TV Marquee reserves a 64dp header budget and never remaps inline action cursors', () => {
  for (const [width, height] of tvSizes) {
    const geometry = nativeReservedGeometry(defaultTheme, width, height);
    assert.equal(geometry.header + geometry.headerMargin, 64);
    assert.equal(geometry.navigation, 44);
    assert.ok(geometry.navigation <= geometry.header);
  }
  for (const libraryCount of [0, 2, 7]) {
    for (let cursor = 0; cursor < libraryCount + 3; cursor++)
      assert.equal(nativeHeaderStripIndex(libraryCount, cursor, true), cursor);
    assert.equal(
      nativeHeaderStripIndex(libraryCount, libraryCount + 1, false),
      libraryCount,
    );
    assert.equal(
      nativeHeaderStripIndex(libraryCount, libraryCount + 2, false),
      libraryCount + 1,
    );
  }
});

test('feature title, metadata and summary fit before artwork loads at every TV budget', () => {
  for (const [width, height] of [[390, 844], [1280, 540], ...tvSizes]) {
    for (const theme of [defaultTheme, midnightTheme]) {
      for (const density of ['comfortable', 'compact'] as const) {
        const geometry = nativeReservedGeometry(
          designed({ density }, theme),
          width,
          height,
        );
        const copy =
          geometry.featurePadding * 2 +
          geometry.featureKicker +
          geometry.featureTitle +
          geometry.featureMetadata +
          geometry.featureSummary +
          geometry.featureGap * 3;
        assert.ok(
          copy <= geometry.feature,
          `${width}x${height} ${density}: ${copy} > ${geometry.feature}`,
        );
        assert.equal(geometry.featureTitle, geometry.featureTitleLine * 2);
        assert.equal(geometry.featureSummary, 19 * 2);
      }
    }
  }
  assert.equal(nativeReservedGeometry(defaultTheme, 960, 540).feature, 194);
  assert.equal(nativeReservedGeometry(defaultTheme, 1280, 720).feature, 259);
});

test('changing to a stacked header cannot reuse inline measurements and clip a focused action', () => {
  const measured = { 11: 11 * 116, 14: 14 * 116 };
  const inline = nativeHeaderScrollOffset(12, 11, true, measured);
  const phone = nativeHeaderScrollOffset(12, 11, false, measured);
  assert.equal(inline, 11 * 116 - 12);
  assert.equal(phone, 11 * 136 - 12);
  assert.ok(phone + 280 >= 11 * 136 + 128);
  const server = nativeHeaderScrollOffset(12, 14, false, measured);
  assert.equal(server, 13 * 136 - 12);
  assert.ok(server + 280 >= 13 * 136 + 128);
  assert.equal(nativeHeaderScrollOffset(12, 14, true, {}), 14 * 116 - 12);
});

test('a poster-only feature stays complete beside the copy on phone and TV', () => {
  for (const [width, height] of [[320, 640], [390, 844], ...tvSizes]) {
    const scene = nativeFeatureScene(defaultTheme, width, height, true);
    const geometry = nativeReservedGeometry(defaultTheme, width, height);
    near(scene.artWidth / scene.artHeight, 2 / 3);
    assert.ok(
      scene.width - scene.artRight - scene.artWidth >=
        scene.copyWidth + 12 - 0.000001,
    );
    assert.ok(scene.artTop >= 12);
    assert.ok(
      scene.artTop + scene.artHeight <= geometry.feature - 12 + 0.000001,
    );
  }
});

test('full-title artwork fallback stays inside both narrow posters and cinematic frames', () => {
  for (const theme of [
    defaultTheme,
    archiveTheme,
    designed({ cards: 'landscape' }),
  ]) {
    for (const [width, height] of [[390, 844], ...tvSizes]) {
      const layout = nativeSkinLayout(theme, width, height);
      const cover = nativeArtworkTypography(
        layout.cardArtWidth,
        layout.cardArtHeight,
      );
      const occupied =
        cover.padding * 2 +
        cover.kicker +
        cover.footer +
        (Number(cover.kicker > 0) + Number(cover.footer > 0)) * cover.gap +
        cover.titleLine * cover.titleLines +
        10;
      assert.ok(occupied <= layout.cardArtHeight + 0.000001);
      assert.ok(cover.titleLines >= 1 && cover.titleLines <= 4);
    }
  }
});

test('TV detail title and Play remain visible together without initial focus scrolling', () => {
  for (const [width, height] of [[1280, 540], ...tvSizes]) {
    for (const density of ['comfortable', 'compact'] as const) {
      const theme = designed({ density });
      const geometry = nativeReservedGeometry(theme, width, height);
      const viewport =
        height - 56 - geometry.header - geometry.headerMargin - 36;
      for (const posterOnly of [false, true]) {
        const scene = nativeDetailScene(theme, width, height, posterOnly);
        assert.ok(
          scene.playTop >= geometry.detailTitle + geometry.detailMetadata,
        );
        assert.ok(scene.playTop + geometry.play + 12 <= viewport);
        assert.equal(
          focusScrollOffset(0, scene.playTop, geometry.play, viewport),
          0,
        );
        assert.ok(scene.height <= viewport);
        near(scene.artWidth / scene.artHeight, posterOnly ? 2 / 3 : 16 / 9);
        assert.ok(scene.artTop + scene.artHeight <= scene.height + 0.000001);
      }
      const card = nativeSkinLayout(theme, width, height);
      assert.ok(
        card.cardHeight <= viewport - 24,
        'the complete focused card fits the TV scene',
      );
    }
  }
  assert.equal(
    nativeReservedGeometry(defaultTheme, 390, 844).detailSummary,
    100,
  );
  assert.equal(
    nativeReservedGeometry(archiveTheme, 1280, 720).detailSummary,
    100,
  );
});

test('authored typography presets distinguish display and body while honouring system and custom palettes', () => {
  const cinema = nativeSkinLayout(defaultTheme, 960, 540);
  assert.equal(cinema.displayFontFamily, 'serif');
  assert.equal(cinema.bodyFontFamily, 'sans-serif');
  const system = nativeSkinLayout(designed({ typography: 'system' }), 960, 540);
  assert.equal(system.displayFontFamily, 'sans-serif');
  assert.equal(system.bodyFontFamily, 'sans-serif');
  const editorial = nativeSkinLayout(
    designed({ typography: 'editorial' }),
    960,
    540,
  );
  assert.equal(editorial.displayFontFamily, 'serif');
  assert.equal(editorial.bodyFontFamily, 'serif');
  assert.deepEqual(nativeSkinLayout(midnightTheme, 960, 540), cinema);
});
