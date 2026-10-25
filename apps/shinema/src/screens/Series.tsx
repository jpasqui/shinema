import { useEffect, useState } from 'react';
import { FlatList, ScrollView, View } from 'react-native';
import {
  watchState,
  type Media,
  type Series,
} from '../../../../packages/core/src/index.ts';
import { useConnected } from '../connection';
import { Focusable } from '../kit/Focusable';
import { Message, Screen } from '../kit/Screen';
import { Text } from '../kit/Text';
import { colors, space } from '../kit/theme';
import { useNavigation } from '../navigation';

type Season = { season: number | null; episodes: number };

const seasonName = (season: number | null) =>
  season === null
    ? 'Specials and extras'
    : season === 0
      ? 'Specials'
      : `Season ${season}`;

export function SeriesScreen({ series }: { series: Series }) {
  const { api, progress } = useConnected();
  const navigation = useNavigation();
  const [seasons, setSeasons] = useState<Season[] | null>(null);
  const [season, setSeason] = useState<number | null | undefined>(undefined);
  const [episodes, setEpisodes] = useState<Media[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .seasons(series.id, controller.signal)
      .then((value) => {
        setSeasons(value.items);
        setSeason(value.items[0]?.season ?? null);
      })
      .catch((problem: Error) => {
        if (!controller.signal.aborted) setError(problem.message);
      });
    return () => controller.abort();
  }, [api, series.id]);

  useEffect(() => {
    if (season === undefined) return;
    const controller = new AbortController();
    setEpisodes(null);
    api
      .catalog(
        {
          series: series.id,
          ...(season === null ? {} : { season }),
          limit: 500,
        },
        controller.signal,
      )
      .then((page) => setEpisodes(page.items))
      .catch((problem: Error) => {
        if (!controller.signal.aborted) setError(problem.message);
      });
    return () => controller.abort();
  }, [api, series.id, season]);

  if (error)
    return (
      <Screen>
        <Message title="This series could not be loaded" detail={error} />
      </Screen>
    );

  return (
    <Screen style={{ paddingHorizontal: space.gutter, paddingTop: space.lg }}>
      <Text variant="hero" numberOfLines={2}>
        {series.title}
      </Text>
      <ScrollView
        horizontal
        style={{ flexGrow: 0, marginVertical: space.lg }}
        contentContainerStyle={{ gap: space.sm }}
      >
        {(seasons ?? []).map((item, index) => (
          <Focusable
            key={String(item.season)}
            accessibilityRole="tab"
            accessibilityState={{ selected: item.season === season }}
            onPress={() => setSeason(item.season)}
            onFocus={() => setSeason(item.season)}
            preferred={index === 0}
            style={{
              borderRadius: 999,
              paddingHorizontal: space.md,
              paddingVertical: 6,
              backgroundColor:
                item.season === season ? colors.elevated : 'transparent',
            }}
          >
            <Text variant="label">{seasonName(item.season)}</Text>
          </Focusable>
        ))}
      </ScrollView>
      {episodes === null ? (
        <Message title="Loading episodes" loading />
      ) : (
        <FlatList
          data={episodes}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ gap: space.sm, paddingBottom: space.xl }}
          renderItem={({ item }) => {
            const state = watchState(progress.local(item.id));
            return (
              <Focusable
                accessibilityRole="button"
                onPress={() => navigation.push({ name: 'detail', media: item })}
                style={{
                  backgroundColor: colors.surface,
                  paddingHorizontal: space.md,
                  paddingVertical: 12,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.md,
                }}
              >
                <Text variant="label" muted style={{ width: 48 }}>
                  {item.episode !== undefined ? `E${item.episode}` : '—'}
                </Text>
                <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>
                  {item.title}
                </Text>
                <Text variant="caption" muted>
                  {state.kind === 'watched'
                    ? 'Watched'
                    : state.kind === 'inProgress'
                      ? `${Math.round(state.fraction * 100)}% watched`
                      : ''}
                </Text>
              </Focusable>
            );
          }}
          ListEmptyComponent={
            <View style={{ paddingVertical: space.xl }}>
              <Text muted>No episodes in this season.</Text>
            </View>
          }
        />
      )}
    </Screen>
  );
}
