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
  restoreWorkspace,
  storage = getStorageArea(),
  handleStore = createIndexedDBHandleStore(),
}) {
  async function restoreSession() {
    try {
      if (!storage) return;

      const data = await storage.get(STORAGE_KEY);
      const session = data[STORAGE_KEY];
      if (!session) return;

      const handle = await handleStore.load();
      if (handle && Array.isArray(session.openTabPaths)) {
        let permission = await handle.queryPermission({ mode: 'read' });
        if (permission !== 'granted') {
          try {
            permission = await handle.requestPermission({ mode: 'read' });
          } catch (_) {
            // requestPermission may require user gesture
          }
        }
        if (permission === 'granted') {
          const workspace = await fsAPI.openFolderFromHandle(handle);
          if (workspace) {
            await restoreWorkspace(
              workspace,
              session.openTabPaths,
              session.activeTabPath ?? null
            );
            return;
          }
        }
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
        await handleStore.save(dirHandle);
        await storage.set({
          [STORAGE_KEY]: {
            openTabPaths: getOpenTabPaths(),
            activeTabPath: getActiveTabPath(),
            savedAt: Date.now(),
          },
        });
      } else {
        await handleStore.clear();
        await storage.set({
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
