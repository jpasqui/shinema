import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  contrastRatio,
  defaultTheme,
  parseTheme,
} from '../../../packages/design-tokens/theme.ts';

function styleValue(node: ts.JsxElement, name: string, source: ts.SourceFile) {
  const style = node.openingElement.attributes.properties.find(
    (attribute) =>
      ts.isJsxAttribute(attribute) &&
      attribute.name.getText(source) === 'style',
  );
  if (
    !style ||
    !ts.isJsxAttribute(style) ||
    !style.initializer ||
    !ts.isJsxExpression(style.initializer)
  )
    return;
  const expression = style.initializer.expression;
  if (!expression || !ts.isObjectLiteralExpression(expression)) return;
  const property = expression.properties.find(
    (value) =>
      ts.isPropertyAssignment(value) && value.name.getText(source) === name,
  );
  return property && ts.isPropertyAssignment(property)
    ? property.initializer.getText(source)
    : undefined;
}

function elementAncestors(node: ts.Node, boundary: ts.Node) {
  const ancestors: ts.JsxElement[] = [];
  for (
    let parent = node.parent;
    parent && parent !== boundary;
    parent = parent.parent
  )
    if (ts.isJsxElement(parent)) ancestors.push(parent);
  return ancestors;
}

test('all artwork fallback copy has an opaque validated backing even for a near-threshold custom theme', () => {
  const theme = parseTheme({
    ...defaultTheme,
    name: 'Near-threshold contrast fixture',
    colors: {
      background: '#000000',
      surface: '#000000',
      elevated: '#000000',
      text: '#767676',
      muted: '#767676',
      danger: '#767676',
      focus: '#ffffff',
      accent: '#000000',
      onAccent: '#ffffff',
    },
  });
  assert.ok(contrastRatio(theme.colors.text, theme.colors.elevated) >= 4.5);
  // A 12%-opaque #767676 line over black composites to #0e0e0e. The old
  // decorative line behind the glyph failed even though the theme validated.
  const composite = `#${Math.round(0x76 * 0.12)
    .toString(16)
    .padStart(2, '0')
    .repeat(3)}`;
  assert.equal(composite, '#0e0e0e');
  assert.ok(contrastRatio(theme.colors.text, composite) < 4.5);

  // Check the production TSX boundary, rather than a disconnected palette
  // helper: removing the copy's backing must fail while its root still has one.
  const source = ts.createSourceFile(
    'skins.tsx',
    readFileSync(new URL('../src/skins.tsx', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const artwork = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'Artwork',
  );
  assert.ok(artwork);
  const textNodes: ts.JsxElement[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(source) === 'Text'
    )
      textNodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(artwork);
  assert.equal(
    textNodes.length,
    3,
    'the kicker, full title and status all need backing',
  );
  const ancestors = textNodes.map((node) => elementAncestors(node, artwork));
  const copy = ancestors[0].find((node) =>
    ancestors.every((chain) => chain.includes(node)),
  );
  assert.ok(copy);
  assert.equal(copy.openingElement.tagName.getText(source), 'View');
  assert.equal(styleValue(copy, 'backgroundColor', source), 'colors.elevated');
  assert.ok(
    [undefined, '1'].includes(styleValue(copy, 'opacity', source)),
    'the backing cannot be translucent',
  );
  for (const node of textNodes) {
    const color = styleValue(node, 'color', source);
    assert.ok(color === 'colors.text' || color === 'colors.muted');
    const foreground =
      color === 'colors.text' ? theme.colors.text : theme.colors.muted;
    assert.ok(contrastRatio(foreground, theme.colors.elevated) >= 4.5);
  }
});
