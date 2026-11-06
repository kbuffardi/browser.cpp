import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { convertLeadingIndentation, isMakefilePath, spacingForPath } from '../src/ui/editor-spacing.mjs';
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
  assert.match(html, /data-apply-spacing/);
});
