import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  SETTINGS_STORAGE_KEY,
  createExtensionSettings,
  initSettingsPanel,
} from '../src/ui/settings.mjs';

function createPromiseStorage() {
  const values = new Map();
  return {
    async get(key) {
      return { [key]: values.get(key) };
    },
    async set(entries) {
      for (const [key, value] of Object.entries(entries)) values.set(key, value);
    },
  };
}

function createCallbackStorage() {
  const values = new Map();
  return {
    get(key, callback) {
      queueMicrotask(() => callback({ [key]: values.get(key) }));
    },
    set(entries, callback) {
      for (const [key, value] of Object.entries(entries)) values.set(key, value);
      queueMicrotask(() => callback());
    },
  };
}

class FakeElement {
  constructor() {
    this.listeners = new Map();
    this.attributes = new Map();
    this.hidden = true;
    this.checked = false;
    this.focused = false;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type) {
    this.listeners.delete(type);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name);
  }

  focus() {
    this.focused = true;
  }

  async dispatch(type, event = {}) {
    return this.listeners.get(type)?.({ target: this, key: event.key });
  }
}

function createFakeDocument() {
  const ids = [
    'btn-settings',
    'settings-backdrop',
    'settings-panel',
    'btn-close-settings',
    'setting-memory-debug',
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  const listeners = new Map();
  return {
    getElementById(id) {
      return elements.get(id) ?? null;
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    async dispatch(type, event = {}) {
      return listeners.get(type)?.(event);
    },
  };
}

for (const [name, createStorage] of [
  ['Promise-style', createPromiseStorage],
  ['callback-style', createCallbackStorage],
]) {
  test(`${name} settings default off and persist Memory Debug Mode globally`, async () => {
    const storage = createStorage();
    const settings = createExtensionSettings({ storage });

    assert.deepEqual(await settings.load(), { memoryDebugMode: false, visualTheme: 'browser-cpp-dark' });
    await settings.setMemoryDebugMode(true);

    assert.deepEqual(settings.get(), { memoryDebugMode: true, visualTheme: 'browser-cpp-dark' });
    assert.deepEqual((await new Promise((resolve) => {
      const result = storage.get(SETTINGS_STORAGE_KEY, resolve);
      if (result?.then) result.then(resolve);
    }))[SETTINGS_STORAGE_KEY], { memoryDebugMode: true, visualTheme: 'browser-cpp-dark' });
  });
}

test('Settings button controls an accessible right-side panel and restores focus', async () => {
  const document = createFakeDocument();
  const settings = createExtensionSettings({ storage: createPromiseStorage() });
  await settings.load();
  const controller = initSettingsPanel({ document, settings });
  const button = document.getElementById('btn-settings');
  const panel = document.getElementById('settings-panel');
  const backdrop = document.getElementById('settings-backdrop');
  const closeButton = document.getElementById('btn-close-settings');

  await button.dispatch('click');
  assert.equal(panel.hidden, false);
  assert.equal(backdrop.hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(closeButton.focused, true);

  await document.dispatch('keydown', { key: 'Escape' });
  assert.equal(panel.hidden, true);
  assert.equal(backdrop.hidden, true);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(button.focused, true);

  controller.destroy();
});

test('Memory Debug Mode toggle saves immediately without a Save button', async () => {
  const document = createFakeDocument();
  const settings = createExtensionSettings({ storage: createPromiseStorage() });
  await settings.load();
  initSettingsPanel({ document, settings });
  const toggle = document.getElementById('setting-memory-debug');

  toggle.checked = true;
  await toggle.dispatch('change');

  assert.equal(settings.get().memoryDebugMode, true);
});

test('Settings markup exposes the official UBSan help link in a protected new tab', async () => {
  const html = await readFile(new URL('../src/ui/index.html', import.meta.url), 'utf8');

  assert.match(html, /id="btn-settings"[\s\S]*settings-gear-icon[\s\S]*Settings/);
  assert.match(html, /id="settings-panel"/);
  assert.match(html, /id="setting-memory-debug"/);
  assert.match(html, /href="https:\/\/clang\.llvm\.org\/docs\/UndefinedBehaviorSanitizer\.html"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /settings-save|Save settings|Apply settings/i);
});

test('Settings backdrop preserves accurate workspace theme previews', async () => {
  const css = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
  const backdrop = css.match(/\.settings-backdrop\s*\{([^}]*)\}/)?.[1];
  const panel = css.match(/\.settings-panel\s*\{([^}]*)\}/)?.[1];

  assert.ok(backdrop, 'Settings backdrop styles should exist for click-outside close');
  assert.match(backdrop, /background:\s*transparent\s*;/);
  assert.doesNotMatch(backdrop, /(?:opacity|filter|backdrop-filter)\s*:/);
  assert.ok(panel, 'Settings drawer styles should exist');
  assert.doesNotMatch(panel, /box-shadow\s*:/);
});
