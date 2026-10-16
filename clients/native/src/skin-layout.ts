import type { Theme } from '../../../packages/design-tokens/theme.ts';

/** Authored layout metrics; imported themes choose bounded presets, never styles/code. */
export function nativeSkinLayout(theme: Theme, width: number, height: number) {
  const compact = width < 700;
  const dense = theme.design.density === 'compact';
  const inset = dense ? 16 : compact ? 20 : 28;
  const gap = dense ? 8 : 12;
  // Fixed columns define stable global feed coordinates across data batches.
  const columns = compact ? 2 : 4;
  const cardWidth = (width - inset * 2 - (columns - 1) * gap) / columns;
  const cardHeight =
    theme.design.cards === 'poster'
      ? Math.min(cardWidth * 1.5 + 56, Math.max(190, (height - 280) * 0.65))
      : compact
        ? Math.max(146, cardWidth * 0.8)
        : Math.max(140, Math.min(225, (height - 330) / 2));
  return {
    compact,
    dense,
    inset,
    gap,
    columns,
    cardWidth,
    cardHeight,
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
  const titleLine = layout.compact ? 34 : 42;
  return {
    header: theme.design.skin === 'archive' ? 72 : 48,
    navigation: 44,
    feature:
      theme.design.skin === 'archive'
        ? layout.dense
          ? 232
          : 256
        : layout.compact
          ? 210
          : layout.dense
            ? 188
            : 200,
    featureTitleLine: layout.compact ? 31 : 40,
    featureTitle: (layout.compact ? 31 : 40) * 2,
    featureSummary: 38,
    featureMetadata: 16,
    cardTitle: 20,
    cardMetadata: 16,
    detailKicker: 26,
    detailTitleLine: titleLine,
    detailTitle: titleLine * 2,
    detailMetadata: 42,
    detailSummary: 100,
    resume: 21,
    play: 54,
    instructions: 36,
    notice: 40,
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
