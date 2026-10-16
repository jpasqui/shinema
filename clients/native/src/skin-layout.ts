import type { Theme } from '../../../packages/design-tokens/theme.ts';

/** Authored layout metrics; imported themes choose bounded presets, never styles/code. */
export function nativeSkinLayout(theme: Theme, width: number, height: number) {
  const compact = width < 700;
  const dense = theme.design.density === 'compact';
  const inset = dense ? 16 : compact ? 20 : 28;
  const gap = dense ? 8 : 12;
  const marquee = theme.design.skin === 'marquee';
  const poster = theme.design.cards === 'poster';
  // Columns depend on the viewport and authored preferences, never loaded data.
  const columns = compact
    ? 2
    : marquee
      ? (poster
          ? width >= 1600
            ? 8
            : width >= 1200
              ? 7
              : 6
          : width >= 1200
            ? 5
            : 4) + (dense ? 1 : 0)
      : 4;
  const cardWidth = (width - inset * 2 - (columns - 1) * gap) / columns;
  const cardBorder = 2;
  const cardPadding = 2;
  const cardInset = cardBorder + cardPadding;
  const cardImageWidth = cardWidth - cardInset * 2;
  const cardTitleLine = compact || width < 1200 ? 19 : 20;
  const cardTitleHeight = cardTitleLine * 2;
  const cardCaptionGap = 8;
  const cardMetadataGap = 2;
  const cardMetadataHeight = 16;
  const captionHeight =
    cardInset * 2 +
    cardCaptionGap +
    cardTitleHeight +
    cardMetadataGap +
    cardMetadataHeight;
  const naturalArtworkHeight = cardImageWidth * (poster ? 1.5 : 9 / 16);
  // Archive keeps its compact programme grid; its artwork is centred at the
  // correct ratio inside the image frame rather than stretching a poster.
  const cardHeight = marquee
    ? naturalArtworkHeight + captionHeight
    : poster
      ? Math.min(cardWidth * 1.5 + 56, Math.max(190, (height - 280) * 0.65))
      : compact
        ? Math.max(146, cardWidth * 0.8)
        : Math.max(140, Math.min(225, (height - 330) / 2));
  const cardImageHeight = cardHeight - captionHeight;
  const cardArtWidth = Math.min(
    cardImageWidth,
    cardImageHeight * (poster ? 2 / 3 : 16 / 9),
  );
  const cardArtHeight = cardArtWidth * (poster ? 1.5 : 9 / 16);
  return {
    compact,
    dense,
    inset,
    gap,
    columns,
    cardWidth,
    cardHeight,
    cardInset,
    cardBorder,
    cardPadding,
    cardImageWidth,
    cardImageHeight,
    cardArtWidth,
    cardArtHeight,
    cardCaptionGap,
    cardTitleLine,
    cardTitleHeight,
    cardMetadataGap,
    cardMetadataHeight,
    cardTitleSize: compact || width < 1200 ? 14 : 15,
    displayFontFamily:
      theme.design.typography === 'system' ? 'sans-serif' : 'serif',
    bodyFontFamily:
      theme.design.typography === 'editorial' ? 'serif' : 'sans-serif',
    fontFamily:
      theme.design.typography === 'editorial'
        ? 'serif'
        : theme.design.typography === 'cinema'
          ? 'sans-serif-light'
          : 'sans-serif',
  };
}

/** These boxes are reserved before metadata/artwork arrives and through failures. */
export function nativeReservedGeometry(
  theme: Theme,
  width: number,
  height: number,
) {
  const layout = nativeSkinLayout(theme, width, height);
  const tvMarquee = !layout.compact && theme.design.skin === 'marquee';
  const titleLine = tvMarquee
    ? height < 620 || width < 1200
      ? 32
      : 40
    : layout.compact
      ? 34
      : 42;
  const featureTitleLine =
    theme.design.skin === 'archive'
      ? layout.compact
        ? 31
        : 40
      : layout.compact
        ? 31
        : width < 1200 || height < 620
          ? 32
          : 40;
  return {
    header: theme.design.skin === 'archive' ? 72 : layout.compact ? 48 : 52,
    headerMargin: !layout.compact && theme.design.skin === 'marquee' ? 12 : 16,
    navigation: 44,
    feature:
      theme.design.skin === 'archive'
        ? layout.dense
          ? 232
          : 256
        : layout.compact
          ? 210
          : Math.round(
              layout.dense
                ? Math.min(246, Math.max(180, height * 0.33))
                : Math.min(280, Math.max(192, height * 0.36)),
            ),
    featureTitleLine,
    featureTitle: featureTitleLine * 2,
    featurePadding: layout.compact ? 16 : layout.dense ? 12 : 16,
    featureGap: 6,
    featureKicker: 12,
    featureSummary: 38,
    featureMetadata: 16,
    cardTitle: layout.cardTitleHeight,
    cardMetadata: layout.cardMetadataHeight,
    detailKicker: tvMarquee ? 14 : 26,
    detailTitleLine: titleLine,
    detailTitle: titleLine * 2,
    detailMetadata: tvMarquee ? 18 : 42,
    detailMetadataLine: tvMarquee ? 18 : 21,
    detailSummary: tvMarquee ? 54 : 100,
    detailSummaryLine: tvMarquee ? 18 : 25,
    detailSummaryLines: tvMarquee ? 3 : 4,
    detailGap: tvMarquee ? 6 : layout.dense ? 12 : 16,
    detailPaddingTop: 12,
    resume: tvMarquee ? 18 : 21,
    play: tvMarquee ? 48 : 54,
    instructions: tvMarquee ? 28 : 36,
    notice: 40,
  };
}

/** Appearance stays at the same logical cursor in inline and stacked headers. */
export function nativeHeaderStripIndex(
  libraryCount: number,
  cursor: number,
  inline: boolean,
) {
  const index = inline || cursor <= libraryCount ? cursor : cursor - 1;
  return Math.max(0, index);
}

export function nativeHeaderScrollOffset(
  libraryCount: number,
  cursor: number,
  inline: boolean,
  measuredInlinePositions: Readonly<Record<number, number>>,
) {
  // Measurements belong only to the inline row. A skin/viewport change must
  // not borrow its 116dp stride for the stacked row's 136dp targets.
  const measured = inline ? measuredInlinePositions[cursor] : undefined;
  return Math.max(
    0,
    (measured ??
      nativeHeaderStripIndex(libraryCount, cursor, inline) *
        (inline ? 116 : 136)) - 12,
  );
}

/** A typographic cover remains legible in a poster, a short landscape, or a hero. */
export function nativeArtworkTypography(width: number, height: number) {
  const padding = width < 120 ? 8 : 14;
  const titleSize = width < 100 ? 13 : width < 180 ? 18 : 26;
  const titleLine = Math.ceil(titleSize * 1.2);
  const kicker = width >= 100 && height >= 130 ? 10 : 0;
  const footer = height >= 100 ? 12 : 0;
  const gap = 6;
  const available =
    height -
    padding * 2 -
    kicker -
    footer -
    (Number(kicker > 0) + Number(footer > 0)) * gap -
    10;
  return {
    padding,
    titleSize,
    titleLine,
    titleLines: Math.max(1, Math.min(4, Math.floor(available / titleLine))),
    kicker,
    footer,
    gap,
  };
}

/** Poster-only artwork is fitted, never cropped by the solid feature copy. */
export function nativeFeatureScene(
  theme: Theme,
  width: number,
  height: number,
  posterOnly: boolean,
) {
  const layout = nativeSkinLayout(theme, width, height);
  const geometry = nativeReservedGeometry(theme, width, height);
  const sceneWidth = width - layout.inset * 2;
  const copyWidth = sceneWidth * (layout.compact ? 0.67 : 0.55);
  const artRight = posterOnly ? (layout.compact ? 12 : 24) : 0;
  const artWidth = posterOnly
    ? Math.min(
        ((geometry.feature - 24) * 2) / 3,
        sceneWidth - copyWidth - artRight - 12,
      )
    : sceneWidth - copyWidth;
  const artHeight = posterOnly ? artWidth * 1.5 : geometry.feature;
  return {
    width: sceneWidth,
    copyWidth,
    artWidth,
    artHeight,
    artRight,
    artTop: (geometry.feature - artHeight) / 2,
  };
}

/** TV detail artwork is beside the copy; revealing Play cannot hide its title. */
export function nativeDetailScene(
  theme: Theme,
  width: number,
  height: number,
  posterOnly: boolean,
) {
  const layout = nativeSkinLayout(theme, width, height);
  const geometry = nativeReservedGeometry(theme, width, height);
  const sceneWidth = width - layout.inset * 2;
  const copyWidth = sceneWidth * 0.6;
  const playTop =
    geometry.detailPaddingTop +
    geometry.detailKicker +
    geometry.detailTitle +
    geometry.detailMetadata +
    geometry.detailSummary +
    geometry.resume +
    geometry.detailGap * 5;
  const sceneHeight =
    playTop + geometry.play + geometry.detailGap + geometry.instructions;
  const artSpace = sceneHeight - geometry.detailPaddingTop;
  const ratio = posterOnly ? 2 / 3 : 16 / 9;
  const artWidth = Math.min(sceneWidth - copyWidth, artSpace * ratio);
  const artHeight = artWidth / ratio;
  return {
    width: sceneWidth,
    height: sceneHeight,
    copyWidth,
    playTop,
    artWidth,
    artHeight,
    artTop: geometry.detailPaddingTop + (artSpace - artHeight) / 2,
  };
}

/** One shared frame for skeleton, error/retry and loaded cards. No media fields enter it. */
export function nativeGridFrame(
  theme: Theme,
  width: number,
  height: number,
  index: number,
) {
  const layout = nativeSkinLayout(theme, width, height);
  return {
    left: (index % layout.columns) * (layout.cardWidth + layout.gap),
    top: Math.floor(index / layout.columns) * (layout.cardHeight + layout.gap),
    width: layout.cardWidth,
    height: layout.cardHeight,
  };
}
