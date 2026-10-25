import { Platform, useWindowDimensions, type ViewStyle } from 'react-native';
import { defaultTheme } from '../../../../packages/design-tokens/theme.ts';

/**
 * The one look every screen uses. Colours come from the shared Marquee
 * palette; fonts are bundled so Shield, web and phones render the same faces.
 * Screens never define their own colours, fonts or spacing.
 */
export const colors = {
  ...defaultTheme.colors,
  scrim: 'rgba(16, 19, 17, 0.72)',
  track: 'rgba(242, 240, 232, 0.24)',
  /** Hairline dividers and secondary button edges. */
  line: 'rgba(255, 255, 255, 0.14)',
  /** Secondary buttons over artwork. */
  glass: 'rgba(16, 19, 17, 0.55)',
} as const;

export const fonts = {
  display: 'SourceSerif4_600SemiBold',
  displayItalic: 'SourceSerif4_400Regular_Italic',
  ui: 'Figtree_500Medium',
  uiBold: 'Figtree_700Bold',
  body: 'Figtree_400Regular',
} as const;

/**
 * Sizes in density-independent pixels, tuned for a 960x540 TV canvas: the
 * Marquee design at 1600x900 scaled to 0.6.
 */
export const type = {
  /** Detail and hero titles: large serif, tight leading. */
  hero: {
    fontFamily: fonts.display,
    fontSize: 46,
    lineHeight: 48,
    letterSpacing: -1,
  },
  /** Section headings such as a library name. */
  title: {
    fontFamily: fonts.uiBold,
    fontSize: 32,
    lineHeight: 38,
    letterSpacing: -1,
  },
  /** Small capitals above a title. */
  heading: {
    fontFamily: fonts.uiBold,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 2.6,
  },
  tagline: { fontFamily: fonts.displayItalic, fontSize: 18, lineHeight: 24 },
  wordmark: {
    fontFamily: fonts.uiBold,
    fontSize: 21,
    lineHeight: 26,
    letterSpacing: -0.6,
  },
  nav: { fontFamily: fonts.ui, fontSize: 14, lineHeight: 20 },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 22 },
  label: { fontFamily: fonts.ui, fontSize: 14, lineHeight: 18 },
  cardTitle: { fontFamily: fonts.uiBold, fontSize: 13, lineHeight: 17 },
  caption: { fontFamily: fonts.body, fontSize: 11, lineHeight: 15 },
  subtitle: { fontFamily: fonts.ui, fontSize: 22, lineHeight: 28 },
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 40,
  gutter: 48,
} as const;
export const radius = { card: 4, button: 4 } as const;

/**
 * Focus is a solid ring drawn a few points outside the control, so it stays
 * visible over any artwork.
 */
export const ring = { width: 3, gap: 4 } as const;

/**
 * Poster cards keep a 2:3 ratio with a fixed text block below; the column
 * count follows the screen width.
 */
export const poster = {
  minWidth: 118,
  gap: 18,
  ratio: 1.5,
  textHeight: 42,
} as const;

export const isTV = Platform.isTV;
export const isWeb = Platform.OS === 'web';

/**
 * Hides the browser's own focus ring; Focusable draws one that matches the
 * TV. React Native's types omit `none`, which react-native-web accepts.
 */
export const noBrowserOutline = (
  Platform.OS === 'web' ? { outlineStyle: 'none' } : {}
) as ViewStyle;

/**
 * Narrow screens (phones in portrait) get a 16-point margin and smaller
 * posters; TVs and desktops keep the 48-point TV-safe margin.
 */
export function useMetrics() {
  const { width } = useWindowDimensions();
  const compact = width < 600;
  return {
    compact,
    gutter: compact ? space.md : space.gutter,
    posterMinWidth: compact ? 96 : poster.minWidth,
  };
}
