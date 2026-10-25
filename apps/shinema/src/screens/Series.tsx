import { useEffect, useState } from 'react';
import { FlatList, ScrollView, View, useWindowDimensions } from 'react-native';
import {
  watchState,
  type Media,
  type Series,
} from '../../../../packages/core/src/index.ts';
import { useConnected } from '../connection';
import { Backdrop } from '../kit/Artwork';
import { Focusable } from '../kit/Focusable';
import { Message, Screen } from '../kit/Screen';
import { Text } from '../kit/Text';
import { TabButton } from '../kit/TopBar';
import { colors, fonts, ring, space, useMetrics } from '../kit/theme';
import { useNavigation } from '../navigation';

type Season = { season: number | null; episodes: number };

const seasonName = (season: number | null) =>
  season === null
    ? 'Specials and extras'
    : season === 0
      ? 'Specials'
      : `Season ${season}`;

export function SeriesScreen({ series }: { series: Series }) {
  const { compact, gutter } = useMetrics();
  const { width } = useWindowDimensions();
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

  const pad = ring.gap + ring.width + 2;
  const header = (
    <View style={{ gap: space.md, paddingBottom: space.md }}>
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
      <View style={{ gap: space.sm, maxWidth: 640, marginTop: space.lg }}>
        <Text variant="heading" muted>
          {season === undefined || season === null
            ? 'Shinema series'
            : `Shinema series / ${seasonName(season)}`}
        </Text>
        <Text
          variant="hero"
          numberOfLines={2}
          style={compact ? { fontSize: 34, lineHeight: 38 } : undefined}
        >
          {series.title}
        </Text>
        <Text variant="label" muted>
          {[
            `${series.seasons} season${series.seasons === 1 ? '' : 's'}`,
            `${series.episodes} episode${series.episodes === 1 ? '' : 's'}`,
          ].join('   ·   ')}
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, marginHorizontal: -pad, marginTop: space.md }}
        contentContainerStyle={{ gap: space.md, padding: pad }}
      >
        {(seasons ?? []).map((item, index) => {
          const selected = item.season === season;
          return (
            <TabButton
              key={String(item.season)}
              label={seasonName(item.season)}
              selected={selected}
              onPress={() => setSeason(item.season)}
              onFocus={() => setSeason(item.season)}
              preferred={index === 0}
            />
          );
        })}
      </ScrollView>
      <Text variant="title" style={{ fontSize: 22, lineHeight: 28 }}>
        Episodes
      </Text>
    </View>
  );

  return (
    <Screen>
      <Backdrop
        uri={
          series.posterPath
            ? api.mediaUrl(series.posterPath, {
                width: Math.min(1920, width * 2),
              })
            : undefined
        }
        title={series.title}
      />
      <FlatList
        extraData={`${navigation.depth}:${season}`}
        data={episodes ?? []}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={header}
        contentContainerStyle={{
          gap: space.sm + 2,
          padding: gutter,
          paddingBottom: space.xl,
        }}
        renderItem={({ item }) => {
          const state = watchState(progress.local(item.id));
          return (
            <Focusable
              accessibilityRole="button"
              accessibilityLabel={item.title}
              onPress={() => navigation.push({ name: 'detail', media: item })}
              focusKey={item.id}
              style={{
                maxWidth: 760,
                backgroundColor: colors.glass,
                borderWidth: 1,
                borderColor: colors.line,
                paddingHorizontal: space.md,
                paddingVertical: 12,
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.md,
              }}
            >
              <Text
                muted
                style={{
                  width: 34,
                  fontFamily: fonts.display,
                  fontSize: 20,
                  lineHeight: 24,
                }}
              >
                {item.episode !== undefined
                  ? String(item.episode).padStart(2, '0')
                  : '—'}
              </Text>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="cardTitle" numberOfLines={1}>
                  {item.title}
                </Text>
                <Text variant="caption" muted numberOfLines={1}>
                  {state.kind === 'watched'
                    ? 'Watched'
                    : state.kind === 'inProgress'
                      ? `${Math.round(state.fraction * 100)}% watched`
                      : (item.summary ?? series.title)}
                </Text>
              </View>
              <Text variant="label" muted style={{ fontSize: 11 }}>
                ▶
              </Text>
            </Focusable>
          );
        }}
        ListEmptyComponent={
          episodes === null ? (
            <Message title="Loading episodes" loading />
          ) : (
            <View style={{ paddingVertical: space.xl }}>
              <Text muted>No episodes in this season.</Text>
            </View>
          )
        }
      />
    </Screen>
  );
}
