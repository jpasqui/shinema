import {
  defaultTheme,
  parseTheme,
} from '../../../packages/design-tokens/theme.ts';
import type {
  Theme,
  ThemeDesign,
} from '../../../packages/design-tokens/theme.ts';
import { serverOrigin } from '../../../packages/contracts/index.ts';
import type { Media } from '../../../packages/contracts/index.ts';

export type MotionPreference = 'system' | 'reduced';
export type AppearancePreferences = {
  version: 1;
  theme: Theme;
  motion: MotionPreference;
};
export const MAX_PREFERENCES_LENGTH = 16384;
export const defaultPreferences = (): AppearancePreferences => ({
  version: 1,
  theme: defaultTheme,
  motion: 'system',
});

export function parsePreferences(value: unknown): AppearancePreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid appearance preferences');
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).sort().join(',') !== 'motion,theme,version' ||
    data.version !== 1 ||
    (data.motion !== 'system' && data.motion !== 'reduced')
  )
    throw new Error('Unsupported appearance preferences');
  return {
    version: 1,
    theme: parseTheme(data.theme),
    motion: data.motion as MotionPreference,
  };
}

export function recoverPreferences(raw: string): {
  preferences: AppearancePreferences;
  warning: string;
} {
  if (!raw) return { preferences: defaultPreferences(), warning: '' };
  try {
    if (raw.length > MAX_PREFERENCES_LENGTH)
      throw new Error('Preferences too large');
    return { preferences: parsePreferences(JSON.parse(raw)), warning: '' };
  } catch {
    return {
      preferences: defaultPreferences(),
      warning: 'Saved appearance was invalid. Marquee defaults are active.',
    };
  }
}

/** Appearance has its own queue and revision; it never writes playback/cache state. */
export class AppearancePersistence {
  private revision = 0;
  private tail: Promise<void> = Promise.resolve();

  async load(
    read: () => Promise<string>,
  ): Promise<ReturnType<typeof recoverPreferences> | null> {
    const started = this.revision;
    let result: ReturnType<typeof recoverPreferences>;
    try {
      result = recoverPreferences(await read());
    } catch {
      result = {
        preferences: defaultPreferences(),
        warning: 'Appearance could not be read. Marquee defaults are active.',
      };
    }
    return this.revision === started ? result : null;
  }

  save(
    value: AppearancePreferences,
    write: (raw: string) => Promise<void>,
  ): Promise<void> {
    const raw = JSON.stringify(parsePreferences(value));
    ++this.revision;
    // A failed save must not poison a later explicit retry or reset.
    this.tail = this.tail.catch(() => {}).then(() => write(raw));
    return this.tail;
  }
}

export const prefersReducedMotion = (
  preference: MotionPreference,
  system: boolean,
  themeMotion: ThemeDesign['motion'] = 'subtle',
): boolean => preference === 'reduced' || system || themeMotion === 'still';

/** D-pad keys are handled by App, so native ScrollView cannot reveal logical focus. */
export function focusScrollOffset(
  current: number,
  top: number,
  height: number,
  viewport: number,
): number {
  if (![current, top, height, viewport].every(Number.isFinite) || viewport <= 0)
    return 0;
  const offset = Math.max(0, current);
  if (top < offset + 12) return Math.max(0, top - 12);
  if (top + height > offset + viewport - 12)
    return Math.max(0, top + height - viewport + 12);
  return offset;
}

/** Recheck cached paths at the image boundary; artwork only uses this trusted server. */
export function artworkUri(
  origin: string,
  item: Media | undefined,
  kind: 'poster' | 'backdrop',
): string | undefined {
  if (!item || !/^[a-f0-9]{64}$/.test(item.id)) return undefined;
  const path = kind === 'poster' ? item.posterPath : item.backdropPath;
  if (path !== `/api/media/${item.id}/${kind}`) return undefined;
  try {
    return serverOrigin(origin) + path;
  } catch {
    return undefined;
  }
}
