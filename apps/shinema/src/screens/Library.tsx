import { useEffect, useState } from 'react';
import { View } from 'react-native';
import {
  watchState,
  type LibraryDescriptor,
  type Media,
  type Series,
} from '../../../../packages/core/src/index.ts';
import { useConnected } from '../connection';
import { PosterCard } from '../kit/PosterCard';
import { PosterGrid, artworkWidth, useGridLayout } from '../kit/PosterGrid';
import { Message, Screen } from '../kit/Screen';
import { SectionHeading } from '../kit/SectionHeading';
import { TopBar } from '../kit/TopBar';
import { colors, poster, radius } from '../kit/theme';
import { usePagedList } from '../kit/usePagedList';
import { useNavigation } from '../navigation';

const showsSeries = (library: LibraryDescriptor) =>
  library.contentTypeId === 'tv' || library.mediaType === 'tv';

function Placeholder({ width }: { width: number }) {
  return (
    <View
      style={{
        width,
        height: Math.round(width * poster.ratio),
        borderRadius: radius.card,
        backgroundColor: colors.surface,
      }}
    />
  );
}

export function LibraryScreen() {
  const { api } = useConnected();
  const navigation = useNavigation();
  const [libraries, setLibraries] = useState<LibraryDescriptor[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    api
      .libraries(controller.signal)
      .then((value) => {
        const visible = value.libraries
          .filter((library) => library.visible)
          .sort((a, b) => a.order - b.order);
        setLibraries(visible);
        setSelected((current) => current ?? visible[0]?.id ?? null);
      })
      .catch((problem: Error & { kind?: string }) => {
        if (controller.signal.aborted) return;
        setError(
          problem.kind === 'unauthorized'
            ? 'This device is no longer paired. Open Settings to pair it again.'
            : problem.message,
        );
      });
    return () => controller.abort();
  }, [api, attempt]);

  const library = libraries?.find((item) => item.id === selected) ?? null;

  // The bar stays fixed above the grid, so switching libraries never rebuilds
  // it and focus stays on the tab you are using.
  const header = (
    <TopBar
      tabs={(libraries ?? []).map((item) => ({
        id: item.id,
        label: item.name,
      }))}
      selected={selected}
      onSelect={setSelected}
      onSettings={() => navigation.push({ name: 'settings' })}
    />
  );

  if (error)
    return (
      <Screen>
        <Message
          title="Your library could not be loaded"
          detail={error}
          action={{
            label: 'Try again',
            onPress: () => setAttempt((value) => value + 1),
          }}
        />
      </Screen>
    );
  if (!libraries)
    return (
      <Screen>
        <Message title="Loading your library" loading />
      </Screen>
    );
  if (!library)
    return (
      <Screen>
        <Message
          title="No libraries yet"
          detail="Add media folders on the server, then come back. New files appear within 15 minutes."
        />
      </Screen>
    );
  return (
    <Screen>
      {header}
      {showsSeries(library) ? (
        <SeriesGrid key={library.id} library={library} />
      ) : (
        <MediaGrid key={library.id} library={library} />
      )}
    </Screen>
  );
}

function MediaGrid({ library }: { library: LibraryDescriptor }) {
  const libraryId = library.id;
  const { api, progress } = useConnected();
  const navigation = useNavigation();
  const layout = useGridLayout();
  const [list, snapshot] = usePagedList<Media>(
    `media:${libraryId}`,
    (offset, limit, signal) =>
      api
        .catalog({ library: libraryId, offset, limit }, signal)
        .then((page) => ({
          items: page.items,
          total: page.total ?? page.items.length,
        })),
  );
  useEffect(() => list.show(0, layout.columns * 4), [list, layout.columns]);
  if (snapshot.total === 0)
    return (
      <Message title="Nothing here yet" detail="This library has no titles." />
    );
  return (
    <PosterGrid
      list={list}
      snapshot={snapshot}
      layout={layout}
      header={
        <SectionHeading
          eyebrow="Your personal picture house"
          title={library.name}
          count={snapshot.total}
        />
      }
      refreshKey={navigation.depth}
      renderCard={(media, index, width) => {
        if (!media) return <Placeholder width={width} />;
        const state = watchState(progress.local(media.id));
        return (
          <PosterCard
            title={media.title}
            detail={
              [media.year, media.genres?.[0]].filter(Boolean).join(' · ') ||
              undefined
            }
            imageUrl={
              media.posterPath
                ? api.mediaUrl(media.posterPath, { width: artworkWidth(width) })
                : undefined
            }
            width={width}
            progress={state.kind === 'inProgress' ? state.fraction : undefined}
            watched={state.kind === 'watched'}
            onPress={() => navigation.push({ name: 'detail', media })}
            preferred={index === 0}
            focusKey={media.id}
          />
        );
      }}
    />
  );
}

function SeriesGrid({ library }: { library: LibraryDescriptor }) {
  const libraryId = library.id;
  const { api } = useConnected();
  const navigation = useNavigation();
  const layout = useGridLayout();
  const [list, snapshot] = usePagedList<Series>(
    `series:${libraryId}`,
    (offset, limit, signal) =>
      api
        .series({ library: libraryId, offset, limit }, signal)
        .then((page) => ({
          items: page.items,
          total: page.total,
        })),
  );
  useEffect(() => list.show(0, layout.columns * 4), [list, layout.columns]);
  if (snapshot.total === 0)
    return (
      <Message title="Nothing here yet" detail="This library has no series." />
    );
  return (
    <PosterGrid
      list={list}
      snapshot={snapshot}
      layout={layout}
      header={
        <SectionHeading
          eyebrow="Your personal picture house"
          title={library.name}
          count={snapshot.total}
        />
      }
      renderCard={(series, index, width) =>
        series ? (
          <PosterCard
            title={series.title}
            detail={`${series.episodes} episode${series.episodes === 1 ? '' : 's'}`}
            imageUrl={
              series.posterPath
                ? api.mediaUrl(series.posterPath, {
                    width: artworkWidth(width),
                  })
                : undefined
            }
            width={width}
            onPress={() => navigation.push({ name: 'series', series })}
            preferred={index === 0}
            focusKey={series.id}
          />
        ) : (
          <Placeholder width={width} />
        )
      }
    />
  );
}
