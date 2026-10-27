import { useCallback, useMemo, type ReactElement } from 'react';
import {
  FlatList,
  PixelRatio,
  View,
  useWindowDimensions,
  type ViewToken,
} from 'react-native';
import type {
  ListSnapshot,
  PagedList,
} from '../../../../packages/core/src/index.ts';
import { poster, space, useMetrics } from './theme';

export type GridLayout = {
  columns: number;
  cardWidth: number;
  rowHeight: number;
  gap: number;
  gutter: number;
};

/** Columns follow the width: about 6 on a TV, more on a wide browser window. */
export function useGridLayout(): GridLayout {
  const { width } = useWindowDimensions();
  const { gutter, posterMinWidth } = useMetrics();
  return useMemo(() => {
    const usable = width - gutter * 2;
    const gap = gutter < space.gutter ? space.sm : poster.gap;
    const columns = Math.max(
      2,
      Math.floor((usable + gap) / (posterMinWidth + gap)),
    );
    const cardWidth = Math.floor((usable - gap * (columns - 1)) / columns);
    const rowHeight =
      Math.round(cardWidth * poster.ratio) + poster.textHeight + gap;
    return { columns, cardWidth, rowHeight, gap, gutter };
  }, [width, gutter, posterMinWidth]);
}

/** Pixel width to request artwork at, so sized variants match the screen. */
export const artworkWidth = (cardWidth: number) =>
  Math.round(cardWidth * PixelRatio.get());

/**
 * A virtualised grid of rows. Only rows near the screen are mounted and only
 * pages near them are loaded, so a 50,000-title library scrolls like a short one.
 */
export function PosterGrid<T>({
  list,
  snapshot,
  layout,
  header,
  refreshKey = 0,
  renderCard,
}: {
  list: PagedList<T>;
  snapshot: ListSnapshot<T>;
  layout: GridLayout;
  header?: ReactElement;
  /** Changes when cards should redraw, for example after watching something. */
  refreshKey?: number;
  renderCard: (
    item: T | undefined,
    index: number,
    width: number,
  ) => ReactElement;
}) {
  const { columns, cardWidth, rowHeight, gap, gutter } = layout;
  const rows =
    snapshot.total === null ? 1 : Math.ceil(snapshot.total / columns);
  const data = useMemo(
    () => Array.from({ length: rows }, (_, row) => row),
    [rows],
  );
  const onViewable = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<number>[] }) => {
      const visible = viewableItems.map((token) => token.index ?? 0);
      if (visible.length === 0) return;
      const first = Math.min(...visible);
      const last = Math.max(...visible);
      list.show(Math.max(0, (first - 2) * columns), (last + 3) * columns);
    },
    [list, columns],
  );
  return (
    <FlatList
      data={data}
      keyExtractor={(row) => String(row)}
      ListHeaderComponent={header}
      extraData={`${snapshot.version}:${refreshKey}`}
      onViewableItemsChanged={onViewable}
      viewabilityConfig={{ itemVisiblePercentThreshold: 1 }}
      getItemLayout={(_, index) => ({
        length: rowHeight,
        offset: rowHeight * index,
        index,
      })}
      initialNumToRender={3}
      windowSize={5}
      maxToRenderPerBatch={4}
      // Room for a focused poster to grow without being clipped.
      contentContainerStyle={{
        paddingHorizontal: gutter,
        paddingTop: space.sm,
        paddingBottom: space.xl,
      }}
      renderItem={({ item: row }) => (
        <View style={{ flexDirection: 'row', gap, height: rowHeight }}>
          {Array.from({ length: columns }, (_, column) => {
            const index = row * columns + column;
            if (snapshot.total !== null && index >= snapshot.total)
              return <View key={column} style={{ width: cardWidth }} />;
            return (
              <View key={column} style={{ width: cardWidth }}>
                {renderCard(snapshot.itemAt(index), index, cardWidth)}
              </View>
            );
          })}
        </View>
      )}
    />
  );
}
