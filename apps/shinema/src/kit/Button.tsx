import { View } from 'react-native';
import { Focusable } from './Focusable';
import { Text } from './Text';
import { colors, fonts, radius, space } from './theme';

export function Button({
  label,
  onPress,
  kind = 'primary',
  icon,
  preferred,
  disabled,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary';
  icon?: string;
  preferred?: boolean;
  disabled?: boolean;
}) {
  const primary = kind === 'primary';
  return (
    <Focusable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      preferred={preferred}
      style={{
        borderRadius: radius.button,
        backgroundColor: primary ? colors.accent : colors.elevated,
        opacity: disabled ? 0.5 : 1,
        alignSelf: 'flex-start',
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingHorizontal: space.lg,
          paddingVertical: 10,
        }}
      >
        {icon ? (
          <Text
            variant="label"
            style={{ color: primary ? colors.onAccent : colors.text }}
          >
            {icon}
          </Text>
        ) : null}
        <Text
          variant="label"
          style={{
            color: primary ? colors.onAccent : colors.text,
            fontFamily: fonts.uiBold,
          }}
        >
          {label}
        </Text>
      </View>
    </Focusable>
  );
}
