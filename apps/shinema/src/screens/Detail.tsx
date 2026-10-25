import { useEffect, useState } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import {
  watchState,
  type Media,
  type Progress,
} from '../../../../packages/core/src/index.ts';
import { useConnected } from '../connection';
import { Backdrop } from '../kit/Artwork';
import { Button } from '../kit/Button';
import { Focusable } from '../kit/Focusable';
import { Screen } from '../kit/Screen';
import { Text } from '../kit/Text';
import { colors, space, useMetrics } from '../kit/theme';
import { useNavigation } from '../navigation';

/** 24, 3:05 or 1:02:10, as a player shows it. */
export const clock = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

const size = (bytes: number) =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1e6))} MB`;

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 3 }}>
      <Text variant="heading" muted style={{ fontSize: 8, letterSpacing: 1.8 }}>
        {label}
      </Text>
      <Text variant="label" numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

export function DetailScreen({ media }: { media: Media }) {
  const { compact, gutter } = useMetrics();
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
  const episode =
    media.seriesTitle &&
    media.season !== undefined &&
    media.episode !== undefined
      ? `${media.seriesTitle} · Season ${media.season}, episode ${media.episode}`
      : null;
  const details = [
    media.year ? String(media.year) : null,
    ...(media.genres?.slice(0, 3) ?? []),
  ].filter(Boolean) as string[];
  const facts = [
    { label: 'Format', value: media.container.toUpperCase() },
    { label: 'Size', value: size(media.sizeBytes) },
    saved && saved.durationSeconds > 0
      ? {
          label: state.kind === 'watched' ? 'Watched' : 'Watched so far',
          value: `${clock(saved.positionSeconds)} of ${clock(saved.durationSeconds)}`,
        }
      : null,
  ].filter(Boolean) as { label: string; value: string }[];
  const titleSize = media.title.length > 28 ? 34 : compact ? 34 : 46;

  return (
    <Screen>
      <Backdrop
        uri={
          media.backdropPath
            ? api.mediaUrl(media.backdropPath, {
                width: Math.min(1920, width * 2),
              })
            : undefined
        }
        title={media.title}
      />
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'space-between',
          padding: gutter,
          gap: space.lg,
        }}
      >
        <Focusable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={navigation.back}
          style={{
            alignSelf: 'flex-start',
            paddingHorizontal: 6,
            paddingVertical: 4,
          }}
        >
          <Text variant="label" muted>
            ‹ Back
          </Text>
        </Focusable>
        <View style={{ gap: space.md, maxWidth: 600 }}>
          <Text variant="heading" muted>
            {episode ?? 'From your collection'}
          </Text>
          <Text
            variant="hero"
            numberOfLines={3}
            style={{ fontSize: titleSize, lineHeight: titleSize + 4 }}
          >
            {media.title}
          </Text>
          {details.length ? (
            <Text variant="label" muted>
              {details.join('   ·   ')}
            </Text>
          ) : null}
          {media.summary ? (
            <Text
              numberOfLines={4}
              style={{ color: colors.text, opacity: 0.86 }}
            >
              {media.summary}
            </Text>
          ) : null}
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: space.md,
              marginTop: space.sm,
            }}
          >
            {state.kind === 'inProgress' ? (
              <>
                <Button
                  label={`Resume from ${clock(state.resumeAt)}`}
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
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: space.xl,
              marginTop: space.sm,
              paddingTop: space.md,
              borderTopWidth: 1,
              borderTopColor: colors.line,
            }}
          >
            {facts.map((fact) => (
              <Fact key={fact.label} label={fact.label} value={fact.value} />
            ))}
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}
