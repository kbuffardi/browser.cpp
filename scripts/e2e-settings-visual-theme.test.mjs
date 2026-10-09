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
  }
});

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
