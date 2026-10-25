import type { ReactElement } from 'react';
import { FlatList, View } from 'react-native';
import { Text } from './Text';
import { ring, space, useMetrics } from './theme';

/**
 * A titled row that scrolls sideways, as on the Marquee home screen. The
 * list keeps room around its cards so focus rings are never clipped.
 */
export function Rail<T>({
  title,
  aside,
  items,
  keyOf,
  gap,
  renderItem,
}: {
  title: string;
  /** Quiet text at the right of the heading. */
  aside?: string;
  items: readonly T[];
  keyOf: (item: T) => string;
  gap: number;
  renderItem: (item: T, index: number) => ReactElement;
}) {
  const { compact, gutter } = useMetrics();
  const pad = ring.gap + ring.width + 2;
  return (
    <View style={{ gap: space.sm }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          paddingHorizontal: gutter,
        }}
      >
        <Text
          variant="title"
          numberOfLines={1}
          style={{ fontSize: compact ? 18 : 20, lineHeight: 26 }}
        >
          {title}
        </Text>
        {aside ? (
          <Text variant="caption" muted>
            {aside}
          </Text>
        ) : null}
      </View>
      <FlatList
        horizontal
        data={items}
        keyExtractor={keyOf}
        showsHorizontalScrollIndicator={false}
        renderItem={({ item, index }) => renderItem(item, index)}
        initialNumToRender={8}
        windowSize={5}
        contentContainerStyle={{
          gap,
          paddingHorizontal: gutter,
          paddingVertical: pad,
        }}
      />
    </View>
  );
}
