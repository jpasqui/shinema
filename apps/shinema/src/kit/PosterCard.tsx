import { Image } from 'expo-image';
import { View } from 'react-native';
import { Focusable } from './Focusable';
import { Text } from './Text';
import { colors, poster, radius, space } from './theme';

/**
 * A 2:3 poster with two reserved title lines and one detail line, so cards
 * never change height when artwork or metadata arrives late.
 */
export function PosterCard({
  title,
  detail,
  imageUrl,
  width,
  progress,
  watched,
  onPress,
  preferred,
  focusKey,
}: {
  title: string;
  detail?: string;
  imageUrl?: string;
  width: number;
  /** 0..1 for titles in progress. */
  progress?: number;
  watched?: boolean;
  onPress: () => void;
  preferred?: boolean;
  focusKey?: string;
}) {
  const height = Math.round(width * poster.ratio);
  return (
    <Focusable
      accessibilityRole="button"
      accessibilityLabel={detail ? `${title}, ${detail}` : title}
      onPress={onPress}
      preferred={preferred}
      focusKey={focusKey}
      outline={false}
      style={{ width, borderWidth: 0 }}
    >
      {(focused) => (
        <View style={{ gap: space.sm }}>
          <View
            style={{
              width,
              height,
              borderRadius: radius.card,
              overflow: 'hidden',
              backgroundColor: colors.surface,
              borderWidth: 3,
              borderColor: focused ? colors.focus : 'transparent',
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
              <View
                style={{
                  flex: 1,
                  justifyContent: 'flex-end',
                  padding: space.sm,
                }}
              >
                <Text variant="label" numberOfLines={4} muted>
                  {title}
                </Text>
              </View>
            )}
            {watched ? (
              <View
                style={{
                  position: 'absolute',
                  top: 6,
                  right: 6,
                  backgroundColor: colors.scrim,
                  borderRadius: 4,
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                }}
              >
                <Text variant="caption">Watched</Text>
              </View>
            ) : null}
            {progress !== undefined ? (
              <View
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 4,
                  backgroundColor: colors.track,
                }}
              >
                <View
                  style={{
                    width: `${Math.round(progress * 100)}%`,
                    height: 4,
                    backgroundColor: colors.accent,
                  }}
                />
              </View>
            ) : null}
          </View>
          <View style={{ height: 52 }}>
            <Text variant="label" numberOfLines={2}>
              {title}
            </Text>
            {detail ? (
              <Text variant="caption" muted numberOfLines={1}>
                {detail}
              </Text>
            ) : null}
          </View>
        </View>
      )}
    </Focusable>
  );
}
