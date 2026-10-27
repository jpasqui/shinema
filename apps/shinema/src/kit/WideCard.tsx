import { Image } from 'expo-image';
import { View } from 'react-native';
import { TitleArt } from './Artwork';
import { Focusable } from './Focusable';
import { Text } from './Text';
import { colors, poster, radius, space } from './theme';

/**
 * A 16:9 card for titles in progress: backdrop (or the designed stand-in),
 * a progress line, and the title with time left below.
 */
export function WideCard({
  title,
  detail,
  imageUrl,
  width,
  progress,
  onPress,
  focusKey,
}: {
  title: string;
  detail?: string;
  imageUrl?: string;
  width: number;
  /** 0..1 */
  progress: number;
  onPress: () => void;
  focusKey?: string;
}) {
  const height = Math.round((width * 9) / 16);
  return (
    <Focusable
      accessibilityRole="button"
      accessibilityLabel={detail ? `${title}, ${detail}` : title}
      onPress={onPress}
      focusKey={focusKey}
      style={{ width, borderRadius: radius.card }}
    >
      <View
        style={{
          width,
          height,
          borderRadius: radius.card,
          overflow: 'hidden',
          backgroundColor: colors.surface,
        }}
      >
        {imageUrl ? (
          <Image
            source={{ uri: imageUrl }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            transition={120}
            recyclingKey={imageUrl}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <TitleArt title={title} width={width} height={height} />
        )}
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: 3,
            backgroundColor: colors.track,
          }}
        >
          <View
            style={{
              width: `${Math.round(progress * 100)}%`,
              height: 3,
              backgroundColor: colors.accent,
            }}
          />
        </View>
      </View>
      <View
        style={{
          height: poster.textHeight,
          paddingTop: space.sm,
          paddingHorizontal: 1,
        }}
      >
        <Text variant="cardTitle" numberOfLines={1}>
          {title}
        </Text>
        {detail ? (
          <Text variant="caption" muted numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
    </Focusable>
  );
}
