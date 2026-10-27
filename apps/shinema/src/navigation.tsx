import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Media, Series } from '../../../packages/core/src/index.ts';
import {
  captureFocus,
  restoreFocus,
  type FocusToken,
} from './platform/focus-memory';
import { useRemote } from './platform/remote';

/** Every screen and what it needs to open. */
export type Route =
  | { name: 'connect' }
  | { name: 'pair'; origin: string }
  | { name: 'library' }
  | { name: 'series'; series: Series }
  | { name: 'detail'; media: Media }
  | { name: 'player'; media: Media; start: number }
  | { name: 'settings' };

type Navigation = {
  route: Route;
  /** Every open screen, oldest first; the last one is visible. */
  stack: readonly Route[];
  depth: number;
  push(route: Route): void;
  replace(route: Route): void;
  reset(route: Route): void;
  back(): boolean;
};

const NavigationContext = createContext<Navigation | null>(null);

/**
 * A plain stack. Back (remote, Escape, Android back) pops one screen; at the
 * root it is left to the platform, which exits the app on Android TV.
 */
export function NavigationProvider({
  initial,
  children,
}: {
  initial: Route;
  children: ReactNode;
}) {
  const [stack, setStack] = useState<Route[]>([initial]);
  // Focus held by each covered screen, restored when it is uncovered.
  const focus = useRef<FocusToken[]>([]);
  const back = useCallback(() => {
    if (stack.length <= 1) return false;
    setStack((current) => current.slice(0, -1));
    restoreFocus(focus.current.pop() ?? null);
    return true;
  }, [stack.length]);
  const value = useMemo<Navigation>(
    () => ({
      route: stack[stack.length - 1]!,
      stack,
      depth: stack.length,
      push: (route) => {
        focus.current.push(captureFocus());
        setStack((current) => [...current, route]);
      },
      replace: (route) =>
        setStack((current) => [...current.slice(0, -1), route]),
      reset: (route) => {
        focus.current = [];
        setStack([route]);
      },
      back,
    }),
    [stack, back],
  );
  useRemote((key) => key === 'back' && back());
  return (
    <NavigationContext.Provider value={value}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigation(): Navigation {
  const navigation = useContext(NavigationContext);
  if (!navigation) throw new Error('useNavigation outside NavigationProvider');
  return navigation;
}
