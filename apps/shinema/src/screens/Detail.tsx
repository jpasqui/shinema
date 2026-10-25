import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import {
  watchState,
  type Media,
  type Progress,
} from '../../../../packages/core/src/index.ts';
import { useConnected } from '../connection';
import { Button } from '../kit/Button';
import { Screen } from '../kit/Screen';
import { Text } from '../kit/Text';
import { colors, space, useMetrics } from '../kit/theme';
import { useNavigation } from '../navigation';

const formatTime = (seconds: number) => {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
};

export function DetailScreen({ media }: { media: Media }) {
  const { gutter } = useMetrics();
  const { api, progress } = useConnected();
  const navigation = useNavigation();
  const { width } = useWindowDimensions();
  const [saved, setSaved] = useState<Progress | null>(progress.local(media.id));
  // Returning from the player uncovers this screen; show the new position.
  useEffect(() => {
    setSaved(progress.local(media.id));
  }, [navigation.depth, progress, media.id]);

  // Merge server progress (another device may have watched more).
  useEffect(() => {
    const controller = new AbortController();
    api
      .progress(media.id, controller.signal)
      .then((server) => setSaved(progress.observe(media.id, server)))
      .catch(() => {});
    return () => controller.abort();
  }, [api, media.id, progress]);

  const state = watchState(saved);
  const details = [
    media.year ? String(media.year) : null,
    media.seriesTitle &&
    media.season !== undefined &&
    media.episode !== undefined
      ? `${media.seriesTitle} · S${media.season} E${media.episode}`
      : null,
    media.genres?.slice(0, 3).join(', ') || null,
  ].filter(Boolean);

  return (
    <Screen>
      {media.backdropPath ? (
        <Image
          source={{
            uri: api.mediaUrl(media.backdropPath, {
              width: Math.min(1920, width * 2),
            }),
          }}
          style={{ position: 'absolute', inset: 0 }}
          contentFit="cover"
          transition={200}
        />
      ) : null}
      <View
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: media.backdropPath
            ? colors.scrim
            : colors.background,
        }}
      />
      <View
        style={{
          flex: 1,
          justifyContent: 'flex-end',
          padding: gutter,
          gap: space.md,
          maxWidth: 760,
        }}
      >
        <Text variant="hero" numberOfLines={3}>
          {media.title}
        </Text>
        {details.length ? <Text muted>{details.join('   ·   ')}</Text> : null}
        {media.summary ? (
          <Text numberOfLines={5} style={{ maxWidth: 640 }}>
            {media.summary}
          </Text>
        ) : null}
        <View
          style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}
        >
          {state.kind === 'inProgress' ? (
            <>
              <Button
                label={`Resume from ${formatTime(state.resumeAt)}`}
                icon="▶"
                preferred
                onPress={() =>
                  navigation.push({
                    name: 'player',
                    media,
                    start: state.resumeAt,
                  })
                }
              />
              <Button
                label="Play from start"
                kind="secondary"
                onPress={() =>
                  navigation.push({ name: 'player', media, start: 0 })
                }
              />
            </>
          ) : (
            <Button
              label={state.kind === 'watched' ? 'Play again' : 'Play'}
              icon="▶"
              preferred
              onPress={() =>
                navigation.push({ name: 'player', media, start: 0 })
              }
            />
          )}
        </View>
        {state.kind === 'watched' ? (
          <Text variant="caption" muted>
            Watched
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}
