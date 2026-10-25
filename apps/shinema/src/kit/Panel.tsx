import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { Backdrop } from './Artwork';
import { Screen } from './Screen';
import { Text } from './Text';
import { colors, space, useMetrics } from './theme';

/**
 * The layout for setup and settings screens: wordmark, eyebrow and a serif
 * title over a soft glow, with the form below.
 */
export function Panel({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  const { compact, gutter } = useMetrics();
  return (
    <Screen>
      <Backdrop title="Shinema" />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          padding: gutter,
          paddingTop: compact ? space.lg : space.xl,
          gap: compact ? space.xl : space.xl + space.md,
        }}
      >
        <Text variant="wordmark" accessibilityRole="header">
          shinema
          <Text variant="wordmark" style={{ color: colors.accent }}>
            .
          </Text>
        </Text>
        <View style={{ gap: space.lg, maxWidth: 560 }}>
          <View style={{ gap: space.sm }}>
            <Text variant="heading" muted>
              {eyebrow}
            </Text>
            <Text
              variant="hero"
              accessibilityRole="header"
              style={compact ? { fontSize: 34, lineHeight: 38 } : undefined}
            >
              {title}
            </Text>
          </View>
          {children}
        </View>
      </ScrollView>
    </Screen>
  );
}
