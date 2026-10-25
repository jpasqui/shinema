import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * Each open screen remembers which control last had focus. When a screen is
 * uncovered (Back from the player or detail), that control asks for focus
 * again, so the remote lands on the same poster on TVs as well as the web.
 */
type ScreenFocus = {
  remember(key: string): void;
  /** The key that should take focus now, or null. */
  restoring: string | null;
};

const ScreenFocusContext = createContext<ScreenFocus | null>(null);

export function ScreenFocusProvider({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  const last = useRef<string | null>(null);
  const wasVisible = useRef(visible);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    if (visible && !wasVisible.current && last.current)
      setRestoring(last.current);
    wasVisible.current = visible;
  }, [visible]);

  // Clear after one frame so the next restore flips preferred focus again.
  useEffect(() => {
    if (restoring === null) return;
    const timer = setTimeout(() => setRestoring(null), 250);
    return () => clearTimeout(timer);
  }, [restoring]);

  const remember = useCallback((key: string) => {
    last.current = key;
  }, []);
  const value = useMemo(() => ({ remember, restoring }), [remember, restoring]);
  return (
    <ScreenFocusContext.Provider value={value}>
      {children}
    </ScreenFocusContext.Provider>
  );
}

export function useScreenFocus(): ScreenFocus | null {
  return useContext(ScreenFocusContext);
}
