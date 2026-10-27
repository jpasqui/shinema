import { Image } from 'expo-image';
import { View } from 'react-native';
import { TitleArt } from './Artwork';
import { Focusable } from './Focusable';
import { Text } from './Text';
import { colors, poster, radius, space } from './theme';

/**
 * A 2:3 poster with one title line and one detail line below, so cards never
 * change height when artwork or metadata arrives late.
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
          <TitleArt
            title={title}
            width={width}
            height={height}
            watched={watched}
          />
        )}
        {watched && imageUrl ? (
          <View
            style={{
              position: 'absolute',
              top: space.sm,
              right: space.sm,
              backgroundColor: colors.scrim,
              borderRadius: 2,
              paddingHorizontal: 5,
              paddingVertical: 2,
            }}
          >
            <Text variant="heading" style={{ fontSize: 7, letterSpacing: 1.4 }}>
              Watched
            </Text>
          </View>
        ) : null}
        {progress !== undefined ? (
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
        ) : null}
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
