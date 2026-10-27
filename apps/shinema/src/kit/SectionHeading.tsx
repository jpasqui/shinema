import { View } from 'react-native';
import { Text } from './Text';
import { colors, space, useMetrics } from './theme';

/** Eyebrow, large heading with an optional count, and a hairline below. */
export function SectionHeading({
  eyebrow,
  title,
  count,
}: {
  eyebrow: string;
  title: string;
  count?: number | null;
}) {
  const { compact } = useMetrics();
  return (
    <View
      style={{
        paddingTop: space.sm,
        paddingBottom: space.md,
        marginBottom: space.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.line,
        gap: space.sm,
      }}
    >
      <Text variant="heading" muted>
        {eyebrow}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
        <Text
          variant="title"
          numberOfLines={1}
          style={compact ? { fontSize: 26, lineHeight: 32 } : undefined}
        >
          {title}
        </Text>
        {count !== undefined && count !== null ? (
          <Text variant="caption" muted style={{ marginTop: 4 }}>
            {String(count).padStart(2, '0')}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
