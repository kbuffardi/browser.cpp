'use strict';

import { getExtensionAPI, getExtensionRuntimeError } from '../extension-api.mjs';
import { DEFAULT_VISUAL_THEME_ID, VISUAL_THEMES, getVisualTheme } from './themes.mjs';

export const SETTINGS_STORAGE_KEY = 'browser_cpp_settings';
export const DEFAULT_SETTINGS = Object.freeze({ memoryDebugMode: false, visualTheme: DEFAULT_VISUAL_THEME_ID });

function getStorageArea() {
  return getExtensionAPI()?.storage?.local ?? null;
}

function sanitizeSettings(value) {
  return {
    memoryDebugMode: value?.memoryDebugMode === true,
    visualTheme: getVisualTheme(value?.visualTheme).id,
  };
}

function storageGet(storage, key) {
  if (!storage?.get) return Promise.resolve({});
  if (storage.get.length >= 2) {
    return new Promise((resolve, reject) => {
      storage.get(key, (value) => {
        const error = getExtensionRuntimeError();
        if (error) reject(new Error(error.message || String(error)));
        else resolve(value ?? {});
      });
    });
  }
  return Promise.resolve(storage.get(key));
}

function storageSet(storage, value) {
  if (!storage?.set) return Promise.resolve();
  if (storage.set.length >= 2) {
    return new Promise((resolve, reject) => {
      storage.set(value, () => {
        const error = getExtensionRuntimeError();
        if (error) reject(new Error(error.message || String(error)));
        else resolve();
      });
    });
  }
  return Promise.resolve(storage.set(value));
}

/** Create extension-wide, project-independent settings backed by storage.local. */
export function createExtensionSettings({
  storage = getStorageArea(),
  onError = (error) => console.warn('[browser.cpp] Could not persist settings:', error),
} = {}) {
  let current = { ...DEFAULT_SETTINGS };
  const subscribers = new Set();

  function notify() {
    const snapshot = { ...current };
    for (const subscriber of subscribers) subscriber(snapshot);
  }

  return {
    async load() {
      try {
        const stored = await storageGet(storage, SETTINGS_STORAGE_KEY);
        current = sanitizeSettings(stored?.[SETTINGS_STORAGE_KEY]);
      } catch (error) {
        current = { ...DEFAULT_SETTINGS };
        onError(error);
      }
      notify();
      return { ...current };
    },

    get() {
      return { ...current };
    },

    async setMemoryDebugMode(enabled) {
      current = { ...current, memoryDebugMode: enabled === true };
      notify();
      try {
        await storageSet(storage, { [SETTINGS_STORAGE_KEY]: { ...current } });
      } catch (error) {
        onError(error);
      }
      return { ...current };
    },
    async setVisualTheme(themeId) {
      current = { ...current, visualTheme: getVisualTheme(themeId).id };
      notify();
      try {
        await storageSet(storage, { [SETTINGS_STORAGE_KEY]: { ...current } });
      } catch (error) {
        onError(error);
      }
      return { ...current };
    },

    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  };
}

/** Bind the static Settings drawer markup to extension settings. */
export function initSettingsPanel({ document, settings }) {
  const button = document.getElementById('btn-settings');
  const backdrop = document.getElementById('settings-backdrop');
  const panel = document.getElementById('settings-panel');
  const closeButton = document.getElementById('btn-close-settings');
  const memoryDebugToggle = document.getElementById('setting-memory-debug');
  const themeCards = document.getElementById('setting-visual-theme-options');

  if (!button || !backdrop || !panel || !closeButton || !memoryDebugToggle) {
    return { destroy() {} };
  }

  const setOpen = (open, restoreFocus = false) => {
    panel.hidden = !open;
    backdrop.hidden = !open;
    panel.setAttribute('aria-hidden', String(!open));
    button.setAttribute('aria-expanded', String(open));
    if (open) closeButton.focus();
    else if (restoreFocus) button.focus();
  };
  const onButtonClick = () => setOpen(panel.hidden, panel.hidden === false);
  const onCloseClick = () => setOpen(false, true);
  const onBackdropClick = () => setOpen(false, true);
  const onKeyDown = (event) => {
    if (event.key === 'Escape' && !panel.hidden) setOpen(false, true);
  };
  const onToggleChange = () => settings.setMemoryDebugMode(memoryDebugToggle.checked);
  if (themeCards && document.createElement) {
    for (const theme of VISUAL_THEMES) {
      const label = document.createElement('label');
      label.className = 'theme-card';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'visual-theme';
      input.value = theme.id;
      input.addEventListener('change', () => settings.setVisualTheme(input.value));
      const preview = document.createElement('span');
      preview.className = 'theme-preview';
      preview.setAttribute('aria-hidden', 'true');
      preview.style.setProperty('--preview-background', theme.preview.background);
      preview.style.setProperty('--preview-foreground', theme.preview.foreground);
      preview.style.setProperty('--preview-accent', theme.preview.accent);
      const name = document.createElement('span');
      name.textContent = theme.label;
      label.append(input, preview, name);
      themeCards.append(label);
    }
  }
  const unsubscribe = settings.subscribe(({ memoryDebugMode, visualTheme }) => {
    memoryDebugToggle.checked = memoryDebugMode;
    if (document.documentElement) document.documentElement.dataset.visualTheme = visualTheme;
    if (themeCards) {
      for (const input of themeCards.querySelectorAll('input[name="visual-theme"]')) {
        input.checked = input.value === visualTheme;
      }
    }
  });

  memoryDebugToggle.checked = settings.get().memoryDebugMode;
  if (document.documentElement) document.documentElement.dataset.visualTheme = settings.get().visualTheme;
  setOpen(false);
  button.addEventListener('click', onButtonClick);
  closeButton.addEventListener('click', onCloseClick);
  backdrop.addEventListener('click', onBackdropClick);
  memoryDebugToggle.addEventListener('change', onToggleChange);
  document.addEventListener('keydown', onKeyDown);

  return {
    destroy() {
      unsubscribe();
      button.removeEventListener('click', onButtonClick);
      closeButton.removeEventListener('click', onCloseClick);
      backdrop.removeEventListener('click', onBackdropClick);
      memoryDebugToggle.removeEventListener('change', onToggleChange);
      document.removeEventListener('keydown', onKeyDown);
    },
  };
}
