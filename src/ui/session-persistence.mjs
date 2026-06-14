'use strict';

const STORAGE_KEY = 'browser_cpp_session';
const IDB_NAME = 'browser-cpp-handles';
const IDB_VERSION = 1;
const IDB_STORE = 'handles';
const IDB_KEY = 'workspace-dir';

function getStorageArea() {
  return typeof chrome !== 'undefined' && chrome.storage?.local
    ? chrome.storage.local
    : null;
}

function getRuntimeError() {
  return typeof chrome !== 'undefined' && chrome.runtime?.lastError
    ? chrome.runtime.lastError
    : null;
}

function getPromiseOrNull(value) {
  return value && typeof value.then === 'function' ? value : null;
}

async function storageGet(storage, key) {
  if (!storage?.get) return {};

  try {
    const result = storage.get(key);
    const pending = getPromiseOrNull(result);
    if (pending) return await pending;
    if (result !== undefined) return result;
  } catch (err) {
    // Fall through to callback-style API.
  }

  return new Promise((resolve, reject) => {
    try {
      storage.get(key, (value) => {
        const err = getRuntimeError();
        if (err) {
          reject(new Error(err.message || String(err)));
          return;
        }
        resolve(value ?? {});
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function storageSet(storage, value) {
  if (!storage?.set) return;

  try {
    const result = storage.set(value);
    const pending = getPromiseOrNull(result);
    if (pending) {
      await pending;
      return;
    }
    if (result !== undefined) return;
  } catch (err) {
    // Fall through to callback-style API.
  }

  await new Promise((resolve, reject) => {
    try {
      storage.set(value, () => {
        const err = getRuntimeError();
        if (err) {
          reject(new Error(err.message || String(err)));
          return;
        }
        resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}

function createIndexedDBHandleStore() {
  function openHandleDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (e) => {
        e.target.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = () => reject(req.error);
    });
  }

  return {
    async save(handle) {
      try {
        const db = await openHandleDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      } catch (_) {
        // IDB not available – skip persistence
      }
    },

    async load() {
      try {
        const db = await openHandleDB();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, 'readonly');
          const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => reject(req.error);
        });
      } catch (_) {
        return null;
      }
    },

    async clear() {
      try {
        const db = await openHandleDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).delete(IDB_KEY);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      } catch (_) {
        // IDB not available – skip deletion
      }
    },
  };
}

export function createSessionPersistence({
  fsAPI,
  editorAPI,
  markDirty,
  getOpenTabPaths,
  getActiveTabPath,
  getOpenTabsSnapshot = () => null,
  restoreWorkspace,
  storage = getStorageArea(),
  handleStore = createIndexedDBHandleStore(),
}) {
  function filterTabContentSnapshot(session) {
    const entries = session?.openTabContentsByPath;
    if (!entries || typeof entries !== 'object') return null;
    const snapshot = {};
    for (const [path, content] of Object.entries(entries)) {
      if (typeof content === 'string') snapshot[path] = content;
    }
    return snapshot;
  }

  async function restoreSession() {
    try {
      if (!storage) return;

      const data = await storageGet(storage, STORAGE_KEY);
      const session = data[STORAGE_KEY];
      if (!session) return;

      const handle = await handleStore.load();
      if (handle && Array.isArray(session.openTabPaths)) {
        let permission = await handle.queryPermission({ mode: 'readwrite' });
        if (permission !== 'granted') {
          try {
            permission = await handle.requestPermission({ mode: 'readwrite' });
          } catch (_) {
            // requestPermission may require user gesture
          }
        }
        if (permission !== 'granted') {
          permission = await handle.queryPermission({ mode: 'read' });
          if (permission !== 'granted') {
            try {
              permission = await handle.requestPermission({ mode: 'read' });
            } catch (_) {
              // requestPermission may require user gesture
            }
          }
        }
        if (permission === 'granted') {
          const workspace = await fsAPI.openFolderFromHandle(handle);
          if (workspace) {
            await restoreWorkspace(
              workspace,
              session.openTabPaths,
              session.activeTabPath ?? null,
              filterTabContentSnapshot(session)
            );
            return;
          }
        }
      }

      if (session.workspace && Array.isArray(session.openTabPaths)) {
        await restoreWorkspace(
          session.workspace,
          session.openTabPaths,
          session.activeTabPath ?? null,
          filterTabContentSnapshot(session)
        );
        return;
      }

      if (session.source) {
        editorAPI.setValue(session.source);
        markDirty(false);
      }
    } catch (_) {
      // Storage not available – first run or non-extension context
    }
  }

  async function persistSession() {
    try {
      if (!storage) return;

      const dirHandle = fsAPI.getDirectoryHandle();
      if (dirHandle) {
        try {
          await handleStore.save(dirHandle);
        } catch (err) {
          // Keep persisting serializable workspace/tab state even if handle storage fails.
          console.warn(
            'Failed to persist workspace directory handle (workspace state will still be saved):',
            err
          );
        }
        await storageSet(storage, {
          [STORAGE_KEY]: {
            openTabPaths: getOpenTabPaths(),
            activeTabPath: getActiveTabPath(),
            openTabContentsByPath: getOpenTabsSnapshot(),
            workspace: typeof fsAPI.getWorkspaceSnapshot === 'function'
              ? fsAPI.getWorkspaceSnapshot()
              : null,
            savedAt: Date.now(),
          },
        });
      } else {
        await handleStore.clear();
        await storageSet(storage, {
          [STORAGE_KEY]: {
            source: editorAPI.getValue(),
            savedAt: Date.now(),
          },
        });
      }
    } catch (err) {
      console.warn('Failed to persist browser.cpp session:', err);
    }
  }

  return { restoreSession, persistSession };
}

export function createPersistenceGate(persistSession) {
  let enabled = false;
  let pending = false;
  return {
    persist() {
      if (!enabled) {
        pending = true;
        return;
      }
      return persistSession();
    },
    enable() {
      enabled = true;
      if (!pending) return;
      pending = false;
      return persistSession();
    },
  };
}
