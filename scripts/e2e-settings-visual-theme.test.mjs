import assert from 'node:assert/strict';
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
  ]);
  assert.equal(getVisualTheme('not-a-theme').id, DEFAULT_VISUAL_THEME_ID);
  for (const theme of VISUAL_THEMES) {
    assert.ok(theme.label && theme.monacoTheme && theme.terminalTheme && theme.preview);
    assert.deepEqual(theme.terminalTheme.selectionForeground, theme.selection.foreground);
    assert.deepEqual(theme.terminalTheme.selectionBackground, theme.selection.background);
    assert.deepEqual(theme.terminalTheme.selectionInactiveBackground, theme.selection.inactiveBackground);
    assert.ok(contrastRatio(theme.selection.foreground, theme.selection.background) >= 4.5);
    assert.notEqual(theme.selection.background, theme.terminalTheme.background);
  }
  assert.deepEqual(VISUAL_THEMES.map(({ id }) => id), [
    'browser-cpp-dark', 'vs', 'vs-dark', 'hc-light', 'hc-black',
  ]);
  assert.deepEqual(VISUAL_THEMES.slice(1).map(({ monacoTheme }) => monacoTheme), [
    'browser-cpp-vs', 'browser-cpp-vs-dark', 'browser-cpp-hc-light', 'browser-cpp-hc-black',
  ]);
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
