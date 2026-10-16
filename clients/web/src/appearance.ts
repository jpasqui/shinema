import {
  defaultTheme,
  parseTheme,
} from '../../../packages/design-tokens/theme.ts';
import type { Theme } from '../../../packages/design-tokens/theme.ts';

export const appearanceKey = 'shinema.appearance.v1';
export type Appearance = {
  version: 1;
  theme: Theme;
  motion: 'system' | 'reduced';
};
export const defaultAppearance = (): Appearance => ({
  version: 1,
  theme: defaultTheme,
  motion: 'system',
});

export function parseAppearance(value: unknown): Appearance {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid appearance preferences.');
  const source = value as Record<string, unknown>;
  if (
    Object.keys(source).sort().join(',') !== 'motion,theme,version' ||
    source.version !== 1 ||
    !['system', 'reduced'].includes(source.motion as string)
  )
    throw new Error('Unsupported appearance preferences.');
  return {
    version: 1,
    theme: parseTheme(source.theme),
    motion: source.motion as Appearance['motion'],
  };
}

export function recoverAppearance(raw: string | null): {
  value: Appearance;
  error: string;
} {
  if (raw === null) return { value: defaultAppearance(), error: '' };
  try {
    if (raw.length > 12000)
      throw new Error('Appearance preferences exceed the limit.');
    return { value: parseAppearance(JSON.parse(raw)), error: '' };
  } catch {
    return {
      value: defaultAppearance(),
      error:
        'Saved appearance was invalid. Marquee defaults are active; choose Reset appearance to replace it.',
    };
  }
}
