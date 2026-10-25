import { useEffect, useRef } from 'react';
import { BackHandler, useTVEventHandler } from 'react-native';
import type { RemoteHandler, RemoteKey } from './remote-types';

export type { RemoteHandler, RemoteKey } from './remote-types';

// CI's Android TV build sets this to log remote keys for its emulator check.
const LOG_KEYS = process.env.EXPO_PUBLIC_SHINEMA_LOG_KEYS === '1';

const TV_KEYS: Record<string, RemoteKey> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  select: 'select',
  playPause: 'playPause',
};

/**
 * Android TV and phones: D-pad and media keys arrive as TV events; Back
 * arrives as the hardware back press. Focus movement itself is native.
 */
export function useRemote(handler: RemoteHandler, active = true): void {
  const latest = useRef(handler);
  latest.current = handler;
  useTVEventHandler((event) => {
    if (LOG_KEYS)
      console.log(
        `[shinema] key ${event.eventType} action ${event.eventKeyAction} active ${active}`,
      );
    if (!active) return;
    // Key-up events repeat the key; act once, on key-down.
    if (event.eventKeyAction === 1) return;
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
