import { ScrollView, View } from 'react-native';
import { Focusable } from './Focusable';
import { Text } from './Text';
import { colors, fonts, ring, space, useMetrics } from './theme';

export type Tab = { id: string; label: string };

function Wordmark() {
  return (
    <Text variant="wordmark" accessibilityRole="header">
      shinema
      <Text variant="wordmark" style={{ color: colors.accent }}>
        .
      </Text>
    </Text>
  );
}

/**
 * A tab with the Marquee underline. The underline sits inside the bottom
 * padding, so tabs line up with plain text beside them.
 */
export function TabButton({
  label,
  selected,
  onPress,
  onFocus,
  focusKey,
  preferred,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  onFocus?: () => void;
  focusKey?: string;
  preferred?: boolean;
}) {
  return (
    <Focusable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      onPress={onPress}
      onFocus={onFocus}
      focusKey={focusKey}
      preferred={preferred}
      style={{ paddingHorizontal: space.sm + 2, paddingVertical: 8 }}
    >
      <Text
        variant="nav"
        style={{
          color: selected ? colors.text : colors.muted,
          fontFamily: selected ? fonts.uiBold : undefined,
        }}
      >
        {label}
      </Text>
      {selected ? (
        <View
          style={{
            position: 'absolute',
            bottom: 1,
            alignSelf: 'center',
            width: 20,
            height: 2,
            backgroundColor: colors.accent,
          }}
        />
      ) : null}
    </Focusable>
  );
}

/**
 * The bar above every library screen: wordmark, one tab per library and
 * Settings. Phones put the tabs on their own scrolling row.
 */
export function TopBar({
  tabs,
  selected,
  onSelect,
  onSettings,
}: {
  tabs: Tab[];
  selected: string | null;
  onSelect: (id: string) => void;
  onSettings: () => void;
}) {
  const { compact, gutter } = useMetrics();
  // Vertical room keeps a focused tab's ring from being clipped.
  const pad = ring.gap + ring.width + 2;
  const row = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, flexShrink: 1 }}
      contentContainerStyle={{
        gap: compact ? space.xs : space.md,
        paddingVertical: pad,
        paddingHorizontal: pad,
      }}
    >
      {tabs.map((tab) => (
        <TabButton
          key={tab.id}
          label={tab.label}
          selected={tab.id === selected}
          onPress={() => onSelect(tab.id)}
          focusKey={`tab:${tab.id}`}
        />
      ))}
    </ScrollView>
  );
  return (
    <View
      style={{
        paddingTop: compact ? space.sm : space.md,
        paddingHorizontal: gutter,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ marginRight: compact ? 0 : space.xl }}>
          <Wordmark />
        </View>
        {compact ? null : row}
        <View style={{ flex: 1 }} />
        <Focusable
          accessibilityRole="button"
          onPress={onSettings}
          focusKey="settings"
          style={{ paddingHorizontal: space.sm + 2, paddingVertical: 8 }}
        >
          <Text variant="nav" muted>
            Settings
          </Text>
        </Focusable>
      </View>
      {compact ? <View style={{ marginHorizontal: -pad }}>{row}</View> : null}
    </View>
  );
}
