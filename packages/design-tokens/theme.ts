/** Shared, declarative theme contract. Themes never contain CSS, URLs or code. */
export const THEME_COLOR_KEYS = Object.freeze([
  'background',
  'surface',
  'elevated',
  'text',
  'muted',
  'accent',
  'onAccent',
  'focus',
  'danger',
] as const);

/** Each choice selects application-authored presentation, never imported code. */
export const THEME_DESIGN_VALUES = Object.freeze({
  skin: Object.freeze(['marquee', 'archive'] as const),
  typography: Object.freeze(['cinema', 'editorial', 'system'] as const),
  density: Object.freeze(['comfortable', 'compact'] as const),
  cards: Object.freeze(['poster', 'landscape'] as const),
  motion: Object.freeze(['subtle', 'still'] as const),
});
export const THEME_DESIGN_KEYS = Object.freeze(
  Object.keys(THEME_DESIGN_VALUES) as (keyof typeof THEME_DESIGN_VALUES)[],
);

export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];
export type ThemeColors = Readonly<Record<ThemeColorKey, string>>;
export type ThemeDesign = {
  readonly [
    Key in keyof typeof THEME_DESIGN_VALUES
  ]: (typeof THEME_DESIGN_VALUES)[Key][number];
};
export type ThemeV1 = Readonly<{
  version: 1;
  name: string;
  colors: ThemeColors;
  design: ThemeDesign;
}>;
export type Theme = ThemeV1;

export const MAX_THEME_BYTES = 8192;
export const MAX_THEME_NAME_LENGTH = 48;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const BACKGROUNDS = ['background', 'surface', 'elevated'] as const;

export class ThemeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThemeValidationError';
  }
}

function fail(message: string): never {
  throw new ThemeValidationError(message);
}

/** Read own data properties only: getters and custom prototypes are rejected. */
function exactRecord(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${path} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(`${path} must be a plain data object.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    return fail(`${path} must contain exactly: ${keys.join(', ')}.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      return fail(`${path}.${key} must be an enumerable data property.`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function parseColor(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.length !== 7 ||
    !HEX_COLOR.test(value)
  ) {
    return fail(`${path} must use a six-digit hex color, such as #101311.`);
  }
  return value.toLowerCase();
}

function parseName(value: unknown): string {
  const message = `Theme name must be 1–${MAX_THEME_NAME_LENGTH} characters, without surrounding whitespace, control characters or angle brackets.`;
  // A Unicode code point uses at most two UTF-16 code units. Bound the string
  // before making an array, including when parseTheme is called directly.
  if (typeof value !== 'string' || value.length > MAX_THEME_NAME_LENGTH * 2) {
    return fail(message);
  }
  const characters = Array.from(value);
  if (
    value.trim() !== value ||
    characters.length === 0 ||
    characters.length > MAX_THEME_NAME_LENGTH ||
    characters.some((character) => {
      const point = character.codePointAt(0)!;
      return (
        point <= 0x1f ||
        (point >= 0x7f && point <= 0x9f) ||
        character === '<' ||
        character === '>'
      );
    })
  ) {
    return fail(message);
  }
  return value;
}

function parseChoice<Choices extends readonly string[]>(
  value: unknown,
  choices: Choices,
  path: string,
): Choices[number] {
  if (typeof value !== 'string' || !choices.includes(value)) {
    return fail(`${path} must be one of: ${choices.join(', ')}.`);
  }
  return value as Choices[number];
}

function parseDesign(value: unknown): ThemeDesign {
  const source = exactRecord(value, THEME_DESIGN_KEYS, 'Theme.design');
  return Object.freeze({
    skin: parseChoice(source.skin, THEME_DESIGN_VALUES.skin, 'design.skin'),
    typography: parseChoice(
      source.typography,
      THEME_DESIGN_VALUES.typography,
      'design.typography',
    ),
    density: parseChoice(
      source.density,
      THEME_DESIGN_VALUES.density,
      'design.density',
    ),
    cards: parseChoice(source.cards, THEME_DESIGN_VALUES.cards, 'design.cards'),
    motion: parseChoice(
      source.motion,
      THEME_DESIGN_VALUES.motion,
      'design.motion',
    ),
  });
}

/** WCAG sRGB relative luminance in [0, 1], for an opaque #RRGGBB color. */
export function relativeLuminance(color: string): number {
  const hex = parseColor(color, 'Color');
  const channels = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export function contrastRatio(first: string, second: string): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function requireContrast(
  colors: ThemeColors,
  foreground: ThemeColorKey,
  background: ThemeColorKey,
  minimum: number,
): void {
  if (contrastRatio(colors[foreground], colors[background]) < minimum) {
    fail(
      `${foreground} must have at least ${minimum}:1 contrast against ${background}.`,
    );
  }
}

/**
 * Validate and copy untrusted data. Body/muted/error text must meet 4.5:1 on all
 * solid surfaces. Focus rings need 3:1; render them with a solid surface offset
 * over artwork. Accent fills must use onAccent text. Do not assume accent is a
 * readable body-text color, or that these pairs cover arbitrary photo backdrops.
 *
 * The earlier, unreleased palette-only prototype is deliberately rejected:
 * design is required, with no implicit layout/motion migration. A future
 * released-version migration must be explicit rather than inferred here.
 */
export function parseTheme(value: unknown): Theme {
  const record = exactRecord(
    value,
    ['version', 'name', 'colors', 'design'],
    'Theme',
  );
  if (record.version !== 1) {
    return fail('Unsupported theme version. Expected version 1.');
  }
  const name = parseName(record.name);
  const design = parseDesign(record.design);
  const source = exactRecord(record.colors, THEME_COLOR_KEYS, 'Theme.colors');
  const colors = Object.fromEntries(
    THEME_COLOR_KEYS.map((key) => [
      key,
      parseColor(source[key], `colors.${key}`),
    ]),
  ) as Record<ThemeColorKey, string>;
  for (const background of BACKGROUNDS) {
    for (const foreground of ['text', 'muted', 'danger'] as const) {
      requireContrast(colors, foreground, background, 4.5);
    }
    requireContrast(colors, 'focus', background, 3);
  }
  requireContrast(colors, 'onAccent', 'accent', 4.5);
  return Object.freeze({
    version: 1,
    name,
    colors: Object.freeze(colors),
    design,
  });
}

/** Avoid a Buffer/TextEncoder dependency so imports work on web and native. */
function utf8ByteLength(value: string): number {
  let length = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    length += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (length > MAX_THEME_BYTES) return length;
  }
  return length;
}

export function importTheme(text: string): Theme {
  if (
    typeof text !== 'string' ||
    text.length > MAX_THEME_BYTES ||
    utf8ByteLength(text) > MAX_THEME_BYTES
  ) {
    return fail(`Theme JSON must be at most ${MAX_THEME_BYTES} UTF-8 bytes.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail('Theme file must contain valid JSON.');
  }
  return parseTheme(value);
}

export function exportTheme(theme: Theme): string {
  return `${JSON.stringify(parseTheme(theme), null, 2)}\n`;
}

const MARQUEE_DESIGN: ThemeDesign = {
  skin: 'marquee',
  typography: 'cinema',
  density: 'comfortable',
  cards: 'poster',
  motion: 'subtle',
};

export const defaultTheme: Theme = parseTheme({
  version: 1,
  name: 'Marquee',
  design: MARQUEE_DESIGN,
  colors: {
    background: '#101311',
    surface: '#1b211d',
    elevated: '#29312b',
    text: '#f2f0e8',
    muted: '#b9c0b8',
    accent: '#df573e',
    onAccent: '#101311',
    focus: '#f2f0e8',
    danger: '#ffb3a4',
  },
});

export const midnightTheme: Theme = parseTheme({
  version: 1,
  name: 'Midnight',
  design: MARQUEE_DESIGN,
  colors: {
    background: '#10131c',
    surface: '#1b2130',
    elevated: '#29334a',
    text: '#f1f2fa',
    muted: '#bbc3d9',
    accent: '#a6b5ff',
    onAccent: '#10131c',
    focus: '#f1f2fa',
    danger: '#ffb3ba',
  },
});

export const archiveTheme: Theme = parseTheme({
  version: 1,
  name: 'Archive',
  design: {
    skin: 'archive',
    typography: 'editorial',
    density: 'comfortable',
    cards: 'poster',
    motion: 'subtle',
  },
  colors: {
    background: '#d9d7cd',
    surface: '#ece9df',
    elevated: '#f5f2e9',
    text: '#222821',
    muted: '#454d40',
    accent: '#923e31',
    onAccent: '#f2f0e8',
    focus: '#802e24',
    danger: '#a23528',
  },
});

const UI_FONT =
  "'Segoe UI', ui-sans-serif, system-ui, -apple-system, sans-serif";
const DISPLAY_FONT = "Georgia, 'Times New Roman', serif";

/** Only this fixed set of CSS property names can be produced by an import. */
export function themeCssVariables(theme: Theme): Record<string, string> {
  const { colors, design } = parseTheme(theme);
  return {
    '--color-bg': colors.background,
    '--color-surface': colors.surface,
    '--color-elevated': colors.elevated,
    '--color-text': colors.text,
    '--color-muted': colors.muted,
    '--color-accent': colors.accent,
    '--color-on-accent': colors.onAccent,
    '--color-focus': colors.focus,
    '--color-danger': colors.danger,
    '--color-line': `${colors.text}26`,
    '--font-ui': UI_FONT,
    '--font-display': design.typography === 'system' ? UI_FONT : DISPLAY_FONT,
  };
}
