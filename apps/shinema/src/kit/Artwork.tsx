import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { View } from 'react-native';
import { Text } from './Text';
import { colors, fonts } from './theme';

/** Muted film tones; a title always gets the same one. */
const TONES = [
  '#24413f',
  '#43231f',
  '#22304a',
  '#36401f',
  '#3b2643',
  '#4a3420',
  '#1f3b4a',
  '#3f2a2a',
] as const;

export function toneFor(title: string): string {
  let hash = 0;
  for (let index = 0; index < title.length; index += 1)
    hash = (hash * 31 + title.charCodeAt(index)) | 0;
  return TONES[Math.abs(hash) % TONES.length]!;
}

/**
 * Stands in for a missing poster: the title set like a film poster on a
 * tone of its own, so a library without artwork still looks designed.
 */
export function TitleArt({
  title,
  width,
  height,
  label = 'Shinema collection',
}: {
  title: string;
  width: number;
  height: number;
  label?: string;
}) {
  const size = Math.max(14, Math.min(30, Math.round(width * 0.15)));
  return (
    <LinearGradient
      colors={[toneFor(title), colors.background]}
      start={{ x: 0.2, y: 0 }}
      end={{ x: 0.8, y: 1 }}
      style={{
        width,
        height,
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: Math.round(height * 0.06),
        paddingHorizontal: Math.round(width * 0.08),
      }}
    >
      <Text
        variant="heading"
        numberOfLines={1}
        style={{ fontSize: 7, letterSpacing: 1.6, color: colors.muted }}
      >
        {width < 120 ? 'Shinema' : label}
      </Text>
      <Text
        numberOfLines={4}
        style={{
          fontFamily: fonts.display,
          fontSize: size,
          lineHeight: Math.round(size * 1.08),
          letterSpacing: -0.4,
          textAlign: 'center',
        }}
      >
        {title}
      </Text>
    </LinearGradient>
  );
}

/**
 * Full-bleed artwork behind a detail screen, faded into the background on
 * the left and bottom so text stays readable. Without artwork, the title's
 * tone glows from the right instead.
 */
export function Backdrop({ uri, title }: { uri?: string; title: string }) {
  return (
    <View style={{ position: 'absolute', inset: 0 }} pointerEvents="none">
      {uri ? (
        <Image
          source={{ uri }}
          style={{ position: 'absolute', inset: 0 }}
          contentFit="cover"
          transition={200}
        />
      ) : (
        <LinearGradient
          colors={[colors.background, toneFor(title)]}
          start={{ x: 0.35, y: 0.8 }}
          end={{ x: 1, y: 0 }}
          style={{ position: 'absolute', inset: 0 }}
        />
      )}
      <LinearGradient
        colors={[
          colors.background,
          'rgba(16, 19, 17, 0.82)',
          'rgba(16, 19, 17, 0)',
        ]}
        locations={[0, 0.4, 0.78]}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={{ position: 'absolute', inset: 0 }}
      />
      <LinearGradient
        colors={['rgba(16, 19, 17, 0)', colors.background]}
        locations={[0.55, 1]}
        style={{ position: 'absolute', inset: 0 }}
      />
    </View>
  );
}
