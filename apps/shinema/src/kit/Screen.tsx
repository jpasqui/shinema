import type { ReactNode } from 'react';
import { ActivityIndicator, View, type ViewStyle } from 'react-native';
import { Button } from './Button';
import { Text } from './Text';
import { colors, space } from './theme';

export function Screen({
  children,
  style,
}: {
  children: ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View style={[{ flex: 1, backgroundColor: colors.background }, style]}>
      {children}
    </View>
  );
}

/** A centred state: loading, empty or failed, with an optional action. */
export function Message({
  title,
  detail,
  loading,
  action,
}: {
  title: string;
  detail?: string;
  loading?: boolean;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: space.gutter,
        gap: space.md,
      }}
    >
      {loading ? (
        <ActivityIndicator color={colors.accent} size="large" />
      ) : null}
      <Text variant="title" style={{ textAlign: 'center' }}>
        {title}
      </Text>
      {detail ? (
        <Text muted style={{ textAlign: 'center', maxWidth: 520 }}>
          {detail}
        </Text>
      ) : null}
      {action ? (
        <Button label={action.label} onPress={action.onPress} preferred />
      ) : null}
    </View>
  );
}
