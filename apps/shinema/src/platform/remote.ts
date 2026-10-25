import { useEffect, useRef } from 'react';
import { BackHandler, useTVEventHandler } from 'react-native';
import { KeyPresses } from './key-presses';
import type { RemoteHandler, RemoteKey } from './remote-types';

export type { RemoteHandler, RemoteKey } from './remote-types';

// CI's Android TV build sets this to log remote keys for its emulator check.
const LOG_KEYS = process.env.EXPO_PUBLIC_SHINEMA_LOG_KEYS === '1';

// Select is left out: it presses the focused element, whose onPress acts.
const TV_KEYS: Record<string, RemoteKey> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  playPause: 'playPause',
};

/**
 * Android TV and phones: D-pad and media keys arrive as TV events; Back
 * arrives as the hardware back press. Focus movement itself is native.
 */
export function useRemote(handler: RemoteHandler, active = true): void {
  const latest = useRef(handler);
  latest.current = handler;
  const presses = useRef(new KeyPresses());
  useTVEventHandler((event) => {
    if (LOG_KEYS)
      console.log(
        `[shinema] key ${event.eventType} action ${event.eventKeyAction} active ${active}`,
      );
    const action = Number(event.eventKeyAction ?? -1);
    if (!presses.current.accept(event.eventType, action) || !active) return;
    const key = TV_KEYS[event.eventType];
    if (key) latest.current(key);
  });
  useEffect(() => {
    if (!active) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () =>
      latest.current('back'),
    );
    return () => subscription.remove();
  }, [active]);
}

/** Native platforms move focus themselves. */
export function useArrowFocus(): void {}
