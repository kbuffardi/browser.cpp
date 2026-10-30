import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DEFAULT_VISUAL_THEME_ID,
  VISUAL_THEMES,
  getVisualTheme,
} from '../src/ui/themes.mjs';
import { createExtensionSettings } from '../src/ui/settings.mjs';

function createStorage(initial) {
  let value = initial;
  return {
    async get(key) { return { [key]: value }; },
    async set(entries) { value = entries.browser_cpp_settings; },
    get value() { return value; },
  };
}

test('theme registry exposes the requested Monaco themes and safe fallback', () => {
  assert.equal(DEFAULT_VISUAL_THEME_ID, 'browser-cpp-dark');
  assert.deepEqual(VISUAL_THEMES.map(({ id }) => id), [
    'browser-cpp-dark', 'vs', 'vs-dark', 'hc-light', 'hc-black',
    'monochrome-light', 'monochrome-dark',
  ]);
  assert.equal(getVisualTheme('not-a-theme').id, DEFAULT_VISUAL_THEME_ID);
  for (const theme of VISUAL_THEMES) {
    assert.ok(theme.label && theme.monacoTheme && theme.terminalTheme && theme.preview);
    assert.deepEqual(theme.terminalTheme.selectionForeground, theme.selection.foreground);
    assert.deepEqual(theme.terminalTheme.selectionBackground, theme.selection.background);
    assert.deepEqual(theme.terminalTheme.selectionInactiveBackground, theme.selection.inactiveBackground);
    assert.ok(contrastRatio(theme.selection.foreground, theme.selection.background) >= 4.5);
    if (theme.id.startsWith('monochrome-')) {
      assert.ok(contrastRatio(theme.selection.foreground, theme.selection.inactiveBackground) >= 4.5);
    }
    assert.notEqual(theme.selection.background, theme.terminalTheme.background);
  }
  assert.deepEqual(VISUAL_THEMES.map(({ id }) => id), [
    'browser-cpp-dark', 'vs', 'vs-dark', 'hc-light', 'hc-black',
    'monochrome-light', 'monochrome-dark',
  ]);
  assert.deepEqual(VISUAL_THEMES.slice(1).map(({ monacoTheme }) => monacoTheme), [
    'browser-cpp-vs', 'browser-cpp-vs-dark', 'browser-cpp-hc-light', 'browser-cpp-hc-black',
    'browser-cpp-monochrome-light', 'browser-cpp-monochrome-dark',
  ]);

  for (const theme of VISUAL_THEMES.slice(-2)) {
    const colors = [
      ...Object.values(theme.cssTokens),
      ...Object.values(theme.terminalTheme),
      ...Object.values(theme.preview),
      theme.selection.foreground,
      theme.selection.background,
      theme.selection.inactiveBackground,
    ].filter((value) => typeof value === 'string' && value.startsWith('#'));
    assert.ok(colors.length > 0);
    assert.ok(colors.every(isGrayscale), `${theme.id} contains a chromatic color`);
  }
});

test('terminal viewport inherits the active visual theme background', async () => {
  const css = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  assert.match(css, /\.xterm\s+\.xterm-viewport\s*\{[^}]*background-color:\s*var\(--terminal-background\);/s);
  assert.ok(
    app.indexOf("import '@xterm/xterm/css/xterm.css';") < app.indexOf("import './styles.css';"),
    'load application styles after xterm so terminal overrides win'
  );
  assert.deepEqual(
    [...css.matchAll(/--terminal-background:\s*(#[\da-f]{3,6});/gi)].map(([, color]) => color.toLowerCase()),
    ['#11111b', '#fff', '#181818', '#fff', '#000', '#ddd', '#222']
  );
});

test('monochrome themes separate panels and outline buttons', async () => {
  const css = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
  assert.match(css, /--panel-explorer:#ddd/);
  assert.match(css, /--panel-editor:#fff/);
  assert.match(css, /--panel-terminal:#ddd/);
  assert.match(css, /--panel-explorer:#222/);
  assert.match(css, /--panel-editor:#000/);
  assert.match(css, /--panel-terminal:#222/);
  assert.match(css, /--button-border:#666/);
  assert.match(css, /--button-border:#999/);
  assert.match(css, /:root\[data-visual-theme="monochrome-light"\][\s\S]*button[\s\S]*border-color: var\(--button-border\);/);
  assert.match(css, /:root\[data-visual-theme="monochrome-dark"\][\s\S]*button[\s\S]*border-color: var\(--button-border\);/);
  assert.match(css, /\.panel-header-btn[\s\S]*border: none;/);
  assert.match(css, /\.tab-close[\s\S]*border: none;/);
  assert.match(css, /\.panel-controls button[\s\S]*border: none;/);
  assert.match(css, /monochrome-light[^}]*\.panel-header-btn[\s\S]*border: 1px solid var\(--button-border\);/);
  assert.match(css, /monochrome-light[^}]*\.tab[\s\S]*border: 1px solid var\(--panel-border\);/);
  assert.match(css, /monochrome-dark[^}]*\.tab\.active[\s\S]*border: 1px solid var\(--panel-border\);/);
  assert.match(css, /monochrome-dark[^}]*border-color: var\(--blue\);/);
});

test('monochrome Monaco selection backgrounds contrast with normal code text', async () => {
  const css = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
  for (const theme of VISUAL_THEMES.filter(({ id }) => id.startsWith('monochrome-'))) {
    assert.equal(theme.selection.foreground, theme.cssTokens.text);
    assert.ok(contrastRatio(theme.cssTokens.text, theme.selection.background) >= 4.5);
    assert.ok(contrastRatio(theme.cssTokens.text, theme.selection.inactiveBackground) >= 4.5);
  }
  assert.doesNotMatch(css, /\.monaco-editor\s+\.selected-text\s*\{[^}]*color:/s);
});

test('Monaco selection smoke hook reads a real editor selection', async () => {
  const editor = await readFile(new URL('../src/ui/editor.js', import.meta.url), 'utf8');
  assert.match(editor, /_editor\.setSelection\(new monaco\.Range\(/);
  assert.match(editor, /editorNode\.querySelector\('\.view-overlays \.selected-text'\)/);
  assert.match(editor, /editorNode\.querySelector\('\.view-lines \.view-line span'\)/);
  assert.doesNotMatch(editor, /document\.createElement\('div'\)/);
});

function contrastRatio(foreground, background) {
  const luminance = (color) => {
    const channels = color.match(/[0-9a-f]{2}/gi).map((channel) => parseInt(channel, 16) / 255);
    const linear = channels.map((channel) => (
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    ));
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('visual theme defaults, sanitizes legacy storage, and persists immediately', async () => {
  const storage = createStorage({ memoryDebugMode: true, visualTheme: 'unknown' });
  const settings = createExtensionSettings({ storage });
  assert.deepEqual(await settings.load(), {
    memoryDebugMode: true,
    visualTheme: DEFAULT_VISUAL_THEME_ID,
  });
  await settings.setVisualTheme('vs');
  assert.deepEqual(settings.get(), { memoryDebugMode: true, visualTheme: 'vs' });
  assert.deepEqual(storage.value, { memoryDebugMode: true, visualTheme: 'vs' });
});

test('monochrome themes persist and unknown values still use the existing default', async () => {
  const storage = createStorage({ memoryDebugMode: false, visualTheme: 'monochrome-light' });
  const settings = createExtensionSettings({ storage });
  assert.equal((await settings.load()).visualTheme, 'monochrome-light');
  await settings.setVisualTheme('monochrome-dark');
  assert.equal(storage.value.visualTheme, 'monochrome-dark');

  const invalidStorage = createStorage({ visualTheme: 'not-a-theme' });
  const invalidSettings = createExtensionSettings({ storage: invalidStorage });
  assert.equal((await invalidSettings.load()).visualTheme, DEFAULT_VISUAL_THEME_ID);
});

function isGrayscale(color) {
  const channels = color.slice(1).match(/.{2}/g)?.map((channel) => parseInt(channel, 16));
  return channels?.length === 3 && channels[0] === channels[1] && channels[1] === channels[2];
}
