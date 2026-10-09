'use strict';

import { getExtensionAPI, getExtensionRuntimeError } from '../extension-api.mjs';

export const SETTINGS_STORAGE_KEY = 'browser_cpp_settings';
export const DEFAULT_SETTINGS = Object.freeze({ memoryDebugMode: false });

function getStorageArea() {
  return getExtensionAPI()?.storage?.local ?? null;
}

function sanitizeSettings(value) {
  return {
    memoryDebugMode: value?.memoryDebugMode === true,
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
  const unsubscribe = settings.subscribe(({ memoryDebugMode }) => {
    memoryDebugToggle.checked = memoryDebugMode;
  });

  memoryDebugToggle.checked = settings.get().memoryDebugMode;
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
