import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  MAX_THEME_BYTES,
  THEME_COLOR_KEYS,
  THEME_DESIGN_KEYS,
  THEME_DESIGN_VALUES,
  ThemeValidationError,
  archiveTheme,
  contrastRatio,
  defaultTheme,
  exportTheme,
  importTheme,
  midnightTheme,
  parseTheme,
  relativeLuminance,
  themeCssVariables,
} from '../theme.ts';

function fixture() {
  return JSON.parse(exportTheme(defaultTheme));
}

test('built-in themes satisfy every text, control and focus contrast pair', () => {
  for (const theme of [defaultTheme, midnightTheme, archiveTheme]) {
    assert.deepEqual(parseTheme(theme), theme);
    for (const background of ['background', 'surface', 'elevated'] as const) {
      for (const foreground of ['text', 'muted', 'danger'] as const) {
        assert.ok(
          contrastRatio(theme.colors[foreground], theme.colors[background]) >=
            4.5,
        );
      }
      assert.ok(
        contrastRatio(theme.colors.focus, theme.colors[background]) >= 3,
      );
    }
    assert.ok(contrastRatio(theme.colors.onAccent, theme.colors.accent) >= 4.5);
  }
});

test('WCAG luminance and contrast use sRGB linearization and are symmetric', () => {
  assert.equal(relativeLuminance('#000000'), 0);
  assert.equal(relativeLuminance('#ffffff'), 1);
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#ffffff', '#000000'), 21);
  assert.ok(Math.abs(relativeLuminance('#808080') - 0.2158605001) < 1e-9);
  assert.equal(contrastRatio('#101311', '#101311'), 1);
  assert.throws(() => relativeLuminance('red'), ThemeValidationError);
});

test('round trip normalizes colors, copies data and freezes every level', () => {
  const source = fixture();
  source.colors.text = '#F2F0E8';
  const parsed = parseTheme(source);
  assert.equal(parsed.colors.text, '#f2f0e8');
  assert.notEqual(parsed, source);
  assert.notEqual(parsed.colors, source.colors);
  assert.notEqual(parsed.design, source.design);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.colors));
  assert.ok(Object.isFrozen(parsed.design));
  source.colors.background = '#ffffff';
  source.design.motion = 'still';
  assert.equal(parsed.colors.background, '#101311');
  assert.equal(parsed.design.motion, 'subtle');
  assert.deepEqual(importTheme(exportTheme(parsed)), parsed);
  assert.equal(
    exportTheme(importTheme(exportTheme(parsed))),
    exportTheme(parsed),
  );
});

test('accepts null-prototype JSON-like data but rejects custom prototypes and getters', () => {
  const source = Object.assign(Object.create(null), fixture());
  source.colors = Object.assign(Object.create(null), source.colors);
  source.design = Object.assign(Object.create(null), source.design);
  assert.deepEqual(parseTheme(source), defaultTheme);
  assert.throws(
    () =>
      parseTheme(Object.assign(Object.create({ inherited: true }), fixture())),
    /plain data object/,
  );
  let getterRan = false;
  const accessor = fixture();
  Object.defineProperty(accessor.colors, 'accent', {
    enumerable: true,
    get() {
      getterRan = true;
      return '#df573e';
    },
  });
  assert.throws(() => parseTheme(accessor), /data property/);
  assert.equal(getterRan, false);
});

test('rejects unknown, missing, symbol and hidden keys at every level', () => {
  for (const key of ['url', 'css', 'script', '__proto__', 'constructor']) {
    for (const level of ['root', 'colors', 'design']) {
      const source = fixture();
      Object.defineProperty(level === 'root' ? source : source[level], key, {
        value: 'unsafe',
        enumerable: true,
      });
      assert.throws(() => parseTheme(source), ThemeValidationError);
    }
  }
  for (const level of ['root', 'colors', 'design']) {
    const source = fixture();
    const target = level === 'root' ? source : source[level];
    target[Symbol('hidden')] = 'unexpected';
    assert.throws(() => parseTheme(source), ThemeValidationError);
  }
  const missing = fixture();
  delete missing.colors.focus;
  assert.throws(() => parseTheme(missing), /exactly/);
  const hidden = fixture();
  Object.defineProperty(hidden, 'name', { value: 'Hidden', enumerable: false });
  assert.throws(() => parseTheme(hidden), /data property/);
});

test('built-in design choices distinguish Archive from Marquee and Midnight', () => {
  assert.deepEqual(defaultTheme.design, {
    skin: 'marquee',
    typography: 'cinema',
    density: 'comfortable',
    cards: 'poster',
    motion: 'subtle',
  });
  assert.deepEqual(midnightTheme.design, defaultTheme.design);
  assert.notEqual(midnightTheme.design, defaultTheme.design);
  assert.deepEqual(archiveTheme.design, {
    ...defaultTheme.design,
    skin: 'archive',
    typography: 'editorial',
  });
  assert.ok(relativeLuminance(archiveTheme.colors.background) > 0.5);
  assert.ok(relativeLuminance(defaultTheme.colors.background) < 0.05);
  assert.deepEqual(importTheme(exportTheme(archiveTheme)), archiveTheme);
});

test('each authored design choice survives validation and import/export', () => {
  for (const key of THEME_DESIGN_KEYS) {
    for (const value of THEME_DESIGN_VALUES[key]) {
      const source = fixture();
      source.design[key] = value;
      assert.equal(
        importTheme(exportTheme(parseTheme(source))).design[key],
        value,
      );
    }
  }
  assert.ok(Object.isFrozen(THEME_DESIGN_VALUES));
  assert.ok(Object.isFrozen(THEME_DESIGN_KEYS));
  for (const values of Object.values(THEME_DESIGN_VALUES)) {
    assert.ok(Object.isFrozen(values));
  }
});

test('design rejects unknown, unbounded and executable choices without coercion', () => {
  for (const key of THEME_DESIGN_KEYS) {
    for (const value of [
      undefined,
      null,
      true,
      1,
      {},
      [],
      'unknown',
      'ARCHIVE',
      'marquee ',
      'url(https://example.invalid/theme.css)',
      'javascript:alert(1)',
      '<script>alert(1)</script>',
      'a'.repeat(9000),
    ]) {
      const source = fixture();
      source.design[key] = value;
      assert.throws(
        () => parseTheme(source),
        new RegExp(`design.${key} must be one of`),
      );
    }
  }
});

test('design rejects getters, custom prototypes and incomplete objects', () => {
  let getterRan = false;
  const source = fixture();
  Object.defineProperty(source.design, 'skin', {
    enumerable: true,
    get() {
      getterRan = true;
      return 'marquee';
    },
  });
  assert.throws(() => parseTheme(source), /data property/);
  assert.equal(getterRan, false);
  const customPrototype = fixture();
  customPrototype.design = Object.assign(
    Object.create({ skin: 'archive' }),
    customPrototype.design,
  );
  assert.throws(() => parseTheme(customPrototype), /plain data object/);
  for (const key of THEME_DESIGN_KEYS) {
    const incomplete = fixture();
    delete incomplete.design[key];
    assert.throws(
      () => parseTheme(incomplete),
      /Theme.design must contain exactly/,
    );
  }
  for (const design of [undefined, null, [], 'marquee']) {
    assert.throws(
      () => parseTheme({ ...fixture(), design }),
      /Theme.design must be an object/,
    );
  }
});

test('unreleased palette-only prototypes fail visibly without inferred design migration', () => {
  const oldTheme = fixture();
  delete oldTheme.design;
  assert.throws(
    () => parseTheme(oldTheme),
    /Theme must contain exactly:.*design/,
  );
  assert.throws(
    () => importTheme(JSON.stringify(oldTheme)),
    /Theme must contain exactly:.*design/,
  );
});

test('rejects prototype pollution keys in imported JSON without changing globals', () => {
  const json = exportTheme(defaultTheme).replace(
    '"version": 1,',
    '"version": 1, "__proto__": {"shinemaPolluted": true},',
  );
  assert.throws(() => importTheme(json), ThemeValidationError);
  assert.equal('shinemaPolluted' in {}, false);
});

test('rejects unsupported versions and values outside the exact object contract', () => {
  for (const value of [null, true, 1, 'theme', [], new Date()]) {
    assert.throws(() => parseTheme(value), ThemeValidationError);
  }
  for (const version of [0, 2, '1', null, 1.1]) {
    assert.throws(
      () => parseTheme({ ...fixture(), version }),
      /Unsupported theme version/,
    );
  }
  assert.throws(() => parseTheme({ ...fixture(), colors: [] }), /object/);
});

test('accepts bounded Unicode names but rejects empty, long or control-containing names', () => {
  for (const name of ['A', 'Movie night', 'Cinéma', '🎬'.repeat(48)]) {
    assert.equal(parseTheme({ ...fixture(), name }).name, name);
  }
  for (const name of [
    '',
    ' ',
    ' leading',
    'trailing ',
    'a'.repeat(49),
    '🎬'.repeat(49),
    'Bad\nname',
    'Bad\u007fname',
    '<script>',
    23,
    null,
  ]) {
    assert.throws(() => parseTheme({ ...fixture(), name }), /Theme name/);
  }
});

test('each color is opaque six-digit hex; CSS, URLs and executable strings are rejected', () => {
  for (const key of THEME_COLOR_KEYS) {
    for (const color of [
      '#fff',
      '#ffffffff',
      '#ffffff\n',
      '#gg0000',
      'red',
      'transparent',
      'rgb(255,0,0)',
      'var(--color-text)',
      'url(https://example.invalid/art.png)',
      '#ffffff;display:none',
      'javascript:alert(1)',
      0,
      null,
    ]) {
      const source = fixture();
      source.colors[key] = color;
      assert.throws(() => parseTheme(source), /six-digit hex/);
    }
  }
});

test('contrast validation independently rejects every required foreground pair', () => {
  for (const background of ['background', 'surface', 'elevated'] as const) {
    for (const foreground of ['text', 'muted', 'danger', 'focus'] as const) {
      const source = fixture();
      Object.assign(source.colors, {
        background: '#000000',
        surface: '#000000',
        elevated: '#000000',
        text: '#ffffff',
        muted: '#ffffff',
        danger: '#ffffff',
        focus: '#ffffff',
      });
      // The selected pair fails while every earlier pair remains readable.
      source.colors[background] =
        foreground === 'focus' ? '#444444' : '#303030';
      source.colors[foreground] = '#808080';
      assert.throws(
        () => parseTheme(source),
        new RegExp(`${foreground} must have at least .+ against ${background}`),
      );
    }
  }
  const source = fixture();
  source.colors.onAccent = source.colors.accent;
  assert.throws(() => parseTheme(source), /onAccent.*accent/);
});

test('import enforces UTF-8 size before parsing and rejects invalid JSON', () => {
  const json = exportTheme(defaultTheme).trimEnd();
  const padding = MAX_THEME_BYTES - json.length;
  assert.deepEqual(importTheme(json + ' '.repeat(padding)), defaultTheme);
  assert.throws(() => importTheme(json + ' '.repeat(padding + 1)), /8192/);
  const unicodeJson = JSON.stringify({ ...fixture(), name: 'Cinéma 🎬' });
  const unicodePadding =
    MAX_THEME_BYTES - Buffer.byteLength(unicodeJson, 'utf8');
  assert.equal(
    importTheme(unicodeJson + ' '.repeat(unicodePadding)).name,
    'Cinéma 🎬',
  );
  assert.throws(
    () => importTheme(unicodeJson + ' '.repeat(unicodePadding + 1)),
    /8192/,
  );
  assert.throws(() => importTheme('{'), /valid JSON/);
  assert.throws(() => importTheme('null'), /object/);
});

test('export revalidates its input and CSS output has only known names and values', () => {
  const invalid = fixture();
  invalid.colors.accent = 'url(https://example.invalid/)';
  assert.throws(() => exportTheme(invalid), ThemeValidationError);
  assert.throws(() => themeCssVariables(invalid), ThemeValidationError);
  const variables = themeCssVariables(defaultTheme);
  assert.equal(variables['--color-bg'], '#101311');
  assert.equal(variables['--color-on-accent'], '#101311');
  assert.equal(variables['--color-line'], '#f2f0e826');
  assert.equal(Object.keys(variables).length, 12);
  assert.ok(
    Object.entries(variables)
      .filter(([key]) => key.startsWith('--color-'))
      .every(([, color]) => /^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(color)),
  );
  assert.equal(
    variables['--font-display'],
    "Georgia, 'Times New Roman', serif",
  );
  assert.equal(
    themeCssVariables(archiveTheme)['--font-display'],
    variables['--font-display'],
  );
  const system = fixture();
  system.design.typography = 'system';
  assert.equal(
    themeCssVariables(system)['--font-display'],
    variables['--font-ui'],
  );
});

test('JSON schema exposes the same version, exact keys and structural limits', () => {
  const schema = JSON.parse(
    readFileSync(new URL('../theme.schema.json', import.meta.url), 'utf8'),
  );
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['version', 'name', 'colors', 'design']);
  assert.equal(schema.properties.version.const, 1);
  assert.equal(schema.properties.name.maxLength, 48);
  assert.equal(schema.properties.colors.additionalProperties, false);
  assert.deepEqual(schema.properties.colors.required, [...THEME_COLOR_KEYS]);
  assert.deepEqual(Object.keys(schema.properties.colors.properties), [
    ...THEME_COLOR_KEYS,
  ]);
  assert.equal(schema.properties.design.additionalProperties, false);
  assert.deepEqual(schema.properties.design.required, [...THEME_DESIGN_KEYS]);
  assert.deepEqual(Object.keys(schema.properties.design.properties), [
    ...THEME_DESIGN_KEYS,
  ]);
  for (const key of THEME_DESIGN_KEYS) {
    assert.equal(schema.properties.design.properties[key].type, 'string');
    assert.deepEqual(schema.properties.design.properties[key].enum, [
      ...THEME_DESIGN_VALUES[key],
    ]);
  }
  const namePattern = new RegExp(schema.properties.name.pattern, 'u');
  for (const name of ['A', 'Movie night', 'Cinéma', '🎬']) {
    assert.ok(namePattern.test(name));
  }
  for (const name of [
    '',
    ' leading',
    'trailing ',
    'trailing\n',
    'Bad\nname',
    '<script>',
  ]) {
    assert.equal(namePattern.test(name), false);
  }
});
