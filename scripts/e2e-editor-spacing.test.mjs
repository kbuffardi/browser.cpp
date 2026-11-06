import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { convertLeadingIndentation, detectSpacing, isMakefilePath, spacingForPath } from '../src/ui/editor-spacing.mjs';
import { createExtensionSettings } from '../src/ui/settings.mjs';

test('classifies only Makefile and .makefile paths as Makefiles', () => {
  assert.equal(isMakefilePath('Makefile'), true);
  assert.equal(isMakefilePath('build/rules.MAKEFILE'), true);
  assert.equal(isMakefilePath('GNUmakefile'), false);
  assert.equal(isMakefilePath('main.cpp'), false);
});

test('uses independent safe defaults for Makefiles and general files', () => {
  assert.equal(spacingForPath('Makefile', {}), 'tabs');
  assert.equal(spacingForPath('main.cpp', {}), 'spaces-2');
});

test('converts only leading indentation and preserves interior whitespace', () => {
  assert.equal(convertLeadingIndentation('    if (a) {\n        x  = 1;\n}', 'spaces-4', 'spaces-2'), '  if (a) {\n    x  = 1;\n}');
});

test('detects existing leading indentation before applying the selected style', () => {
  assert.equal(detectSpacing('\tfirst\n\t\tsecond'), 'tabs');
  assert.equal(detectSpacing('    first\n        second'), 'spaces-4');
  assert.equal(detectSpacing('  first\n    second'), 'spaces-2');
});

test('persists the two category defaults', async () => {
  let stored;
  const settings = createExtensionSettings({ storage: { get: async () => ({}), set: async (value) => { stored = value; } } });
  await settings.load();
  await settings.setSpacing('makefileSpacing', 'spaces-4');
  assert.equal(settings.get().makefileSpacing, 'spaces-4');
  assert.equal(stored.browser_cpp_settings.defaultSpacing, 'spaces-2');
});

test('status bar exposes the spacing dropup after cursor status', async () => {
  const html = await readFile(new URL('../src/ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /status-cursor[\s\S]*spacing-button[\s\S]*spacing-menu/);
  assert.match(html, /Spacing: 2 spaces ⌃/);
  assert.doesNotMatch(html, /Spacing: 2 spaces \^/);
  assert.match(html, /data-apply-spacing/);
});

test('only the selected spacing choice is styled boldly', async () => {
  const css = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\[role="menuitemradio"\]\[aria-checked="true"\]\s*[{]\s*font-weight:\s*700/);
  assert.doesNotMatch(css, /aria-checked="true"\]::before/);
});

test('Monaco spacing selection disables content inference and updates indent size', async () => {
  const editor = await readFile(new URL('../src/ui/editor.js', import.meta.url), 'utf8');
  assert.match(editor, /detectIndentation:\s*false/);
  assert.match(editor, /indentSize:\s*tabSize/);
  assert.match(editor, /updateOptions\(\{\s*detectIndentation:\s*false,[\s\S]*indentSize:\s*tabSize/);
});
