import { Platform, type ViewStyle } from 'react-native';
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
} as const;

export const fonts = {
  display: 'SourceSerif4_600SemiBold',
  displayItalic: 'SourceSerif4_400Regular_Italic',
  ui: 'Figtree_500Medium',
  uiBold: 'Figtree_700Bold',
  body: 'Figtree_400Regular',
} as const;

/** Sizes in density-independent pixels, tuned for a 960x540 TV canvas. */
export const type = {
  hero: { fontFamily: fonts.display, fontSize: 40, lineHeight: 44 },
  title: { fontFamily: fonts.display, fontSize: 28, lineHeight: 32 },
  heading: {
    fontFamily: fonts.uiBold,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: 1.2,
  },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 22 },
  label: { fontFamily: fonts.ui, fontSize: 14, lineHeight: 18 },
  caption: { fontFamily: fonts.body, fontSize: 12, lineHeight: 16 },
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
export const radius = { card: 6, button: 999 } as const;

/** Poster cards keep a 2:3 ratio; the column count follows the screen width. */
export const poster = { minWidth: 118, gap: 18, ratio: 1.5 } as const;

export const isTV = Platform.isTV;
export const isWeb = Platform.OS === 'web';

/**
 * Hides the browser's own focus ring; Focusable draws one that matches the
 * TV. React Native's types omit `none`, which react-native-web accepts.
 */
export const noBrowserOutline = (
  Platform.OS === 'web' ? { outlineStyle: 'none' } : {}
) as ViewStyle;
