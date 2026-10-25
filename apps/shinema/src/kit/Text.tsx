import { Text as NativeText, type TextProps } from 'react-native';
import { colors, type } from './theme';

type Variant = keyof typeof type;

export function Text({
  variant = 'body',
  muted = false,
  style,
  ...props
}: TextProps & { variant?: Variant; muted?: boolean }) {
  return (
    <NativeText
      {...props}
      style={[
        type[variant],
        { color: muted ? colors.muted : colors.text },
        variant === 'heading' && { textTransform: 'uppercase' },
        style,
      ]}
    />
  );
}
