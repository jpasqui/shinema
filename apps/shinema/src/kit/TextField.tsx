import { useState } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';
import { Text } from './Text';
import { colors, fonts, noBrowserOutline, space } from './theme';

export function TextField({
  label,
  hint,
  error,
  ...props
}: TextInputProps & { label: string; hint?: string; error?: string | null }) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: space.xs, width: '100%', maxWidth: 520 }}>
      <Text variant="heading" muted>
        {label}
      </Text>
      <TextInput
        {...props}
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        onFocus={(event) => {
          setFocused(true);
          props.onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          props.onBlur?.(event);
        }}
        style={{
          ...noBrowserOutline,
          fontFamily: fonts.ui,
          fontSize: 18,
          color: colors.text,
          backgroundColor: colors.surface,
          borderRadius: 6,
          borderWidth: 2,
          borderColor: error
            ? colors.danger
            : focused
              ? colors.focus
              : colors.elevated,
          paddingHorizontal: space.md,
          paddingVertical: 12,
        }}
      />
      {error ? (
        <Text variant="caption" style={{ color: colors.danger }}>
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" muted>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
