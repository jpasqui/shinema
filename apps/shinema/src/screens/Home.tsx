import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import {
  watchState,
  type ContinueItem,
  type LibraryDescriptor,
  type Media,
  type Series,
} from '../../../../packages/core/src/index.ts';
import { useConnected } from '../connection';
import { Backdrop } from '../kit/Artwork';
import { Button } from '../kit/Button';
import { Focusable } from '../kit/Focusable';
import { PosterCard } from '../kit/PosterCard';
import { artworkWidth, useGridLayout } from '../kit/PosterGrid';
import { Rail } from '../kit/Rail';
import { Text } from '../kit/Text';
import { clock, timeLeft } from '../kit/time';
import { colors, poster, radius, space, useMetrics } from '../kit/theme';
import { WideCard } from '../kit/WideCard';
import { useNavigation } from '../navigation';

export const showsSeries = (library: LibraryDescriptor) =>
  library.contentTypeId === 'tv' || library.mediaType === 'tv';

const RAIL_LENGTH = 15;

const episodeLabel = (media: Media) =>
  media.season !== undefined && media.episode !== undefined
    ? `S${media.season} E${media.episode}`
    : null;

/**
 * The Marquee home: a featured title over its artwork, what you are
 * watching, and a row from each library.
 */
export function HomeView({
  libraries,
  onOpenLibrary,
  onScrolled,
}: {
  libraries: LibraryDescriptor[];
  onOpenLibrary: (id: string) => void;
  /** Whether Home has scrolled, so the bar above it can turn solid. */
  onScrolled: (scrolled: boolean) => void;
}) {
  const { api, progress } = useConnected();
  const navigation = useNavigation();
  const { compact, gutter } = useMetrics();
  const { width, height } = useWindowDimensions();
  const [watching, setWatching] = useState<ContinueItem[] | null>(null);
  const [fallback, setFallback] = useState<Media | null>(null);

  // Refresh whenever Home is uncovered; the player's last save may still be
  // on its way, so ask once more shortly after.
  const visible = navigation.depth === 1;
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const load = () =>
      api
        .continueWatching(12, controller.signal)
        .then(setWatching)
        .catch(() => {
          if (!controller.signal.aborted)
            setWatching((current) => current ?? []);
        });
    load();
    const again = setTimeout(load, 2000);
    return () => {
      clearTimeout(again);
      controller.abort();
    };
  }, [api, visible]);

  // Without anything in progress, feature a title that has artwork.
  const films = libraries.find((library) => !showsSeries(library));
  useEffect(() => {
    if (!films) return;
    const controller = new AbortController();
    api
      .catalog({ library: films.id, limit: 30 }, controller.signal)
      .then((page) =>
        setFallback(
          page.items.find((item) => item.backdropPath) ?? page.items[0] ?? null,
        ),
      )
      .catch(() => {});
    return () => controller.abort();
  }, [api, films]);

  // This device may know a newer position than the server has yet.
  const items = (watching ?? []).map((item) => {
    const local = progress.local(item.media.id);
    return local && (local.updatedAt ?? 0) > (item.progress.updatedAt ?? 0)
      ? { ...item, progress: local }
      : item;
  });
  const lead = items[0];
  const featured = lead?.media ?? fallback;
  // The hero takes focus the first time it appears, not every time it
  // changes, so returning to Home keeps focus where it was.
  const heroSeen = useRef(false);
  const heroFocus = featured !== null && !heroSeen.current;
  useEffect(() => {
    if (featured) heroSeen.current = true;
  }, [featured]);
  const wide = compact
    ? Math.round(width * 0.68)
    : Math.floor((width - gutter * 2 - poster.gap * 3) / 4);

  return (
    <ScrollView
      contentContainerStyle={{ paddingBottom: space.xl }}
      scrollEventThrottle={32}
      onScroll={(event) => onScrolled(event.nativeEvent.contentOffset.y > 8)}
    >
      {featured ? (
        <Hero
          media={featured}
          resumeAt={lead ? lead.progress.positionSeconds : null}
          height={Math.round(height * (compact ? 0.66 : 0.74))}
          preferred={heroFocus}
        />
      ) : (
        <View style={{ height: 96 }} />
      )}
      <View style={{ gap: space.lg, marginTop: space.md }}>
        {items.length ? (
          <Rail
            title="Continue watching"
            aside={compact ? undefined : 'Most recent first'}
            items={items}
            keyOf={(item) => item.media.id}
            gap={compact ? space.sm : poster.gap}
            renderItem={({ media, progress: saved }) => {
              const episode = episodeLabel(media);
              const left = timeLeft(
                saved.durationSeconds - saved.positionSeconds,
              );
              const art = media.backdropPath ?? media.posterPath;
              return (
                <WideCard
                  title={media.seriesTitle ?? media.title}
                  detail={episode ? `${episode} · ${left}` : left}
                  imageUrl={
                    art
                      ? api.mediaUrl(art, { width: artworkWidth(wide) })
                      : undefined
                  }
                  width={wide}
                  progress={saved.positionSeconds / saved.durationSeconds}
                  onPress={() => navigation.push({ name: 'detail', media })}
                  focusKey={`continue:${media.id}`}
                />
              );
            }}
          />
        ) : null}
        {libraries.map((library) => (
          <LibraryRail
            key={library.id}
            library={library}
            onSeeAll={() => onOpenLibrary(library.id)}
          />
        ))}
      </View>
    </ScrollView>
  );
}

function Hero({
  media,
  resumeAt,
  height,
  preferred,
}: {
  media: Media;
  resumeAt: number | null;
  height: number;
  preferred: boolean;
}) {
  const { api } = useConnected();
  const navigation = useNavigation();
  const { compact, gutter } = useMetrics();
  const { width } = useWindowDimensions();
  const episode = episodeLabel(media);
  const title = media.seriesTitle ?? media.title;
  const details = [
    episode ? `${episode} · ${media.title}` : null,
    media.year ? String(media.year) : null,
    ...(media.genres?.slice(0, 2) ?? []),
  ].filter(Boolean) as string[];
  const size = compact ? 36 : title.length > 24 ? 38 : 50;
  return (
    <View style={{ height, justifyContent: 'flex-end' }}>
      <Backdrop
        uri={
          media.backdropPath
            ? api.mediaUrl(media.backdropPath, {
                width: Math.min(1920, width * 2),
              })
            : undefined
        }
        title={title}
      />
      {/* Keeps the bar above readable over bright artwork. */}
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(16, 19, 17, 0.75)', 'rgba(16, 19, 17, 0)']}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 140 }}
      />
      <View style={{ paddingHorizontal: gutter, gap: space.sm, maxWidth: 640 }}>
        <Text variant="heading" muted>
          {resumeAt !== null
            ? 'Pick up where you left off'
            : 'Tonight, from your collection'}
        </Text>
        <Text
          variant="hero"
          numberOfLines={2}
          style={{ fontSize: size, lineHeight: size + 4 }}
        >
          {title}
        </Text>
        {details.length ? (
          <Text variant="label" muted numberOfLines={1}>
            {details.join('   ·   ')}
          </Text>
        ) : null}
        {media.summary && !compact ? (
          <Text numberOfLines={2} style={{ opacity: 0.86, maxWidth: 560 }}>
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
          <Button
            label={
              resumeAt !== null ? `Resume from ${clock(resumeAt)}` : 'Play'
            }
            icon="▶"
            preferred={preferred}
            focusKey="hero:play"
            onPress={() =>
              navigation.push({ name: 'player', media, start: resumeAt ?? 0 })
            }
          />
          <Button
            label="Details"
            kind="secondary"
            focusKey="hero:details"
            onPress={() => navigation.push({ name: 'detail', media })}
          />
        </View>
      </View>
    </View>
  );
}

/** The first titles of one library, ending with a way into all of it. */
function LibraryRail({
  library,
  onSeeAll,
}: {
  library: LibraryDescriptor;
  onSeeAll: () => void;
}) {
  const { api, progress } = useConnected();
  const navigation = useNavigation();
  const { compact } = useMetrics();
  const { cardWidth } = useGridLayout();
  const series = showsSeries(library);
  const [items, setItems] = useState<(Media | Series)[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const query = { library: library.id, limit: RAIL_LENGTH };
    (series
      ? api.series(query, controller.signal)
      : api.catalog(query, controller.signal)
    )
      .then((page) => {
        setItems(page.items);
        setTotal(page.total ?? page.items.length);
      })
      .catch(() => setItems([]));
    return () => controller.abort();
  }, [api, library.id, series]);

  if (!items || items.length === 0) return null;
  const end = { id: ':all' } as const;
  return (
    <Rail
      title={library.name}
      aside={total !== null ? `${total} titles` : undefined}
      items={[...items, end]}
      keyOf={(item) => item.id}
      gap={compact ? space.sm : poster.gap}
      renderItem={(item) => {
        if (!('title' in item))
          return (
            <SeeAll
              label={library.name}
              width={cardWidth}
              onPress={onSeeAll}
              focusKey={`${library.id}::all`}
            />
          );
        if ('episodes' in item)
          return (
            <PosterCard
              title={item.title}
              detail={`${item.episodes} episode${item.episodes === 1 ? '' : 's'}`}
              imageUrl={
                item.posterPath
                  ? api.mediaUrl(item.posterPath, {
                      width: artworkWidth(cardWidth),
                    })
                  : undefined
              }
              width={cardWidth}
              onPress={() => navigation.push({ name: 'series', series: item })}
              focusKey={`${library.id}:${item.id}`}
            />
          );
        const state = watchState(progress.local(item.id));
        return (
          <PosterCard
            title={item.title}
            detail={
              [item.year, item.genres?.[0]].filter(Boolean).join(' · ') ||
              undefined
            }
            imageUrl={
              item.posterPath
                ? api.mediaUrl(item.posterPath, {
                    width: artworkWidth(cardWidth),
                  })
                : undefined
            }
            width={cardWidth}
            progress={state.kind === 'inProgress' ? state.fraction : undefined}
            watched={state.kind === 'watched'}
            onPress={() => navigation.push({ name: 'detail', media: item })}
            focusKey={`${library.id}:${item.id}`}
          />
        );
      }}
    />
  );
}

function SeeAll({
  label,
  width,
  onPress,
  focusKey,
}: {
  label: string;
  width: number;
  onPress: () => void;
  focusKey: string;
}) {
  return (
    <Focusable
      accessibilityRole="button"
      accessibilityLabel={`See all ${label}`}
      onPress={onPress}
      focusKey={focusKey}
      style={{ width, borderRadius: radius.card }}
    >
      <View
        style={{
          width,
          height: Math.round(width * poster.ratio),
          borderRadius: radius.card,
          borderWidth: 1,
          borderColor: colors.line,
          backgroundColor: colors.glass,
          alignItems: 'center',
          justifyContent: 'center',
          gap: space.xs,
        }}
      >
        <Text variant="heading" muted>
          See all
        </Text>
        <Text variant="cardTitle">{label} ›</Text>
      </View>
    </Focusable>
  );
}
