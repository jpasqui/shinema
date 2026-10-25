import { View } from 'react-native';
import { Focusable } from './Focusable';
import { Text } from './Text';
import { colors, fonts, radius, space } from './theme';

/**
 * Primary actions are cream with dark text; secondary ones are dark glass
 * with a hairline edge, so they read over artwork and plain backgrounds.
 */
export function Button({
  label,
  onPress,
  kind = 'primary',
  icon,
  preferred,
  disabled,
  focusKey,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary';
  icon?: string;
  preferred?: boolean;
  disabled?: boolean;
  focusKey?: string;
}) {
  const primary = kind === 'primary';
  const color = primary ? colors.background : colors.text;
  return (
    <Focusable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      preferred={preferred}
      focusKey={focusKey}
      style={{
        borderRadius: radius.button,
        backgroundColor: primary ? colors.focus : colors.glass,
        borderWidth: primary ? 0 : 1,
        borderColor: colors.line,
        opacity: disabled ? 0.5 : 1,
        alignSelf: 'flex-start',
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm + 2,
          minHeight: 40,
          paddingHorizontal: space.lg - 2,
        }}
      >
        {icon ? (
          <Text variant="label" style={{ color, fontSize: 12 }}>
            {icon}
          </Text>
        ) : null}
        <Text
          variant="label"
          style={{ color, fontFamily: fonts.uiBold, fontSize: 15 }}
        >
          {label}
        </Text>
      </View>
    </Focusable>
  );
}
