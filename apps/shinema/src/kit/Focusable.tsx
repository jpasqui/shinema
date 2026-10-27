import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { focusIfIdle } from '../platform/focus-memory';
import { useScreenFocus } from './focus-memory';
import { colors, noBrowserOutline, ring } from './theme';

/** The focus ring sits outside the control, following its corner radius. */
function Ring({ radius }: { radius: number }) {
  const offset = -(ring.gap + ring.width);
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: offset,
        left: offset,
        right: offset,
        bottom: offset,
        borderWidth: ring.width,
        borderColor: colors.focus,
        borderRadius: radius + ring.gap + ring.width,
      }}
    />
  );
}

/**
 * Everything selectable is a Focusable: D-pad focus on TVs, arrow keys and
 * hover on the web, touch on phones. Focus is shown the same way everywhere,
 * with a ring around the control, so people always know where they are.
 */
export function Focusable({
  children,
  style,
  focusedStyle,
  outline = true,
  onFocusChange,
  preferred = false,
  focusKey,
  ...props
}: Omit<PressableProps, 'style' | 'children'> & {
  children: ReactNode | ((focused: boolean) => ReactNode);
  style?: StyleProp<ViewStyle>;
  focusedStyle?: StyleProp<ViewStyle>;
  /** False when the control draws its own focus state. */
  outline?: boolean;
  onFocusChange?: (focused: boolean) => void;
  /** Receives focus when the screen opens (TV). */
  preferred?: boolean;
  /** Identifies this control so focus returns to it after Back. */
  focusKey?: string;
}) {
  const [focused, setFocused] = useState(false);
  const ref = useRef<View>(null);
  const screen = useScreenFocus();
  const restoringThis =
    focusKey !== undefined && screen?.restoring === focusKey;
  const wanted = preferred || restoringThis;
  // Coming back to a screen: ask for focus directly as well, since Android TV
  // only applies hasTVPreferredFocus reliably when a view first appears.
  useEffect(() => {
    if (restoringThis)
      (
        ref.current as { requestTVFocus?: () => void } | null
      )?.requestTVFocus?.();
  }, [restoringThis]);
  // `hasTVPreferredFocus` covers TVs; the web needs an explicit focus call.
  useEffect(() => {
    if (wanted) focusIfIdle(ref.current);
  }, [wanted]);
  const change = (value: boolean) => {
    setFocused(value);
    if (value && focusKey !== undefined) screen?.remember(focusKey);
    onFocusChange?.(value);
  };
  return (
    <Pressable
      {...props}
      ref={ref}
      hasTVPreferredFocus={wanted}
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
        { borderRadius: 4 },
        noBrowserOutline,
        style,
        focused && focusedStyle,
      ]}
    >
      {typeof children === 'function' ? children(focused) : children}
      {focused && outline ? (
        <Ring radius={Number(StyleSheet.flatten(style)?.borderRadius ?? 4)} />
      ) : null}
    </Pressable>
  );
}
