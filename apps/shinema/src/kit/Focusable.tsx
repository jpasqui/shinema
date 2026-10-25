import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Pressable,
  type View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { focusIfIdle } from '../platform/focus-memory';
import { colors, noBrowserOutline } from './theme';

/**
 * Everything selectable is a Focusable: D-pad focus on TVs, arrow keys and
 * hover on the web, touch on phones. Focus is shown the same way everywhere,
 * with an outline and a slight lift, so people always know where they are.
 */
export function Focusable({
  children,
  style,
  focusedStyle,
  outline = true,
  onFocusChange,
  preferred = false,
  ...props
}: Omit<PressableProps, 'style' | 'children'> & {
  children: ReactNode | ((focused: boolean) => ReactNode);
  style?: StyleProp<ViewStyle>;
  focusedStyle?: StyleProp<ViewStyle>;
  outline?: boolean;
  onFocusChange?: (focused: boolean) => void;
  /** Receives focus when the screen opens (TV). */
  preferred?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const ref = useRef<View>(null);
  // `hasTVPreferredFocus` covers TVs; the web needs an explicit focus call.
  useEffect(() => {
    if (preferred) focusIfIdle(ref.current);
  }, [preferred]);
  const change = (value: boolean) => {
    setFocused(value);
    onFocusChange?.(value);
  };
  return (
    <Pressable
      {...props}
      ref={ref}
      hasTVPreferredFocus={preferred}
      onFocus={(event) => {
        change(true);
        props.onFocus?.(event);
      }}
      onBlur={(event) => {
        change(false);
        props.onBlur?.(event);
      }}
      // On the web the pointer moves focus, so hover and arrow keys never
      // highlight two different items.
      onHoverIn={(event) =>
        (event.currentTarget as unknown as { focus?: () => void }).focus?.()
      }
      style={[
        { borderRadius: 6, borderWidth: 2, borderColor: 'transparent' },
        noBrowserOutline,
        style,
        focused && outline && { borderColor: colors.focus },
        focused && { transform: [{ scale: 1.04 }] },
        focused && focusedStyle,
      ]}
    >
      {typeof children === 'function' ? children(focused) : children}
    </Pressable>
  );
}
