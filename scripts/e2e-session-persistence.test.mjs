import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSessionPersistence,
  createPersistenceGate,
} from '../src/ui/session-persistence.mjs';

function createStorageArea() {
  const data = new Map();
  return {
    async get(key) {
      return { [key]: data.get(key) };
    },
    async set(value) {
      for (const [key, item] of Object.entries(value)) {
        data.set(key, item);
      }
    },
  };
}

function createCallbackStorageArea() {
  const data = new Map();
  return {
    get(key, callback) {
      queueMicrotask(() => callback?.({ [key]: data.get(key) }));
    },
    set(value, callback) {
      for (const [key, item] of Object.entries(value)) {
        data.set(key, item);
      }
      queueMicrotask(() => callback?.());
    },
  };
}

function createHandleStore() {
  let handle = null;
  return {
    async save(nextHandle) {
      handle = nextHandle;
    },
    async load() {
      return handle;
    },
    async clear() {
      handle = null;
    },
  };
}

test('e2e: restores workspace tabs when only read permission is granted', async () => {
  const storage = createStorageArea();
  const handleStore = createHandleStore();
  const permissionModes = [];
  const restored = [];

  const directoryHandle = {
    async queryPermission({ mode }) {
      permissionModes.push(`query:${mode}`);
      return mode === 'read' ? 'granted' : 'denied';
    },
    async requestPermission({ mode }) {
      permissionModes.push(`request:${mode}`);
      return 'denied';
    },
  };

  const sharedSessionState = {
    openTabPaths: ['src/main.cpp', 'include/main.hpp'],
    activeTabPath: 'include/main.hpp',
  };

  const firstSession = createSessionPersistence({
    fsAPI: {
      getDirectoryHandle: () => directoryHandle,
      openFolderFromHandle: async () => null,
    },
    editorAPI: {
      getValue: () => '',
      setValue: () => {},
    },
    markDirty: () => {},
    getOpenTabPaths: () => sharedSessionState.openTabPaths,
    getActiveTabPath: () => sharedSessionState.activeTabPath,
    restoreWorkspace: async () => {},
    storage,
    handleStore,
  });

  await firstSession.persistSession();

  const expectedWorkspace = { name: 'project', entries: [] };
  const secondSession = createSessionPersistence({
    fsAPI: {
      getDirectoryHandle: () => null,
      openFolderFromHandle: async (handle) => {
        assert.equal(handle, directoryHandle);
        return expectedWorkspace;
      },
    },
    editorAPI: {
      getValue: () => '',
      setValue: () => {},
    },
    markDirty: () => {},
    getOpenTabPaths: () => [],
    getActiveTabPath: () => null,
    restoreWorkspace: async (workspace, openTabPaths, activeTabPath) => {
      restored.push({ workspace, openTabPaths, activeTabPath });
    },
    storage,
    handleStore,
  });

  await secondSession.restoreSession();

  assert.deepEqual(permissionModes, ['query:read']);
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0], {
    workspace: expectedWorkspace,
    openTabPaths: ['src/main.cpp', 'include/main.hpp'],
    activeTabPath: 'include/main.hpp',
  });
});

test('e2e: restores source fallback when no workspace handle is available', async () => {
  const storage = createStorageArea();
  const handleStore = createHandleStore();
  let restoredSource = null;
  let dirtyState = true;

  const firstSession = createSessionPersistence({
    fsAPI: {
      getDirectoryHandle: () => null,
      openFolderFromHandle: async () => null,
    },
    editorAPI: {
      getValue: () => 'int main() { return 0; }\n',
      setValue: () => {},
    },
    markDirty: () => {},
    getOpenTabPaths: () => [],
    getActiveTabPath: () => null,
    restoreWorkspace: async () => {},
    storage,
    handleStore,
  });

  await firstSession.persistSession();

  const secondSession = createSessionPersistence({
    fsAPI: {
      getDirectoryHandle: () => null,
      openFolderFromHandle: async () => {
        throw new Error('workspace restore should not be attempted');
      },
    },
    editorAPI: {
      getValue: () => '',
      setValue: (source) => {
        restoredSource = source;
      },
    },
    markDirty: (nextDirtyState) => {
      dirtyState = nextDirtyState;
    },
    getOpenTabPaths: () => [],
    getActiveTabPath: () => null,
    restoreWorkspace: async () => {
      throw new Error('workspace restore should not be called');
    },
    storage,
    handleStore,
  });

  await secondSession.restoreSession();

  assert.equal(restoredSource, 'int main() { return 0; }\n');
  assert.equal(dirtyState, false);
});

test('e2e: startup gate prevents pre-restore persistence from wiping workspace session', async () => {
  const storage = createStorageArea();
  const handleStore = createHandleStore();
  const restored = [];

  const directoryHandle = {
    async queryPermission() {
      return 'granted';
    },
    async requestPermission() {
      return 'granted';
    },
  };

  const firstSession = createSessionPersistence({
    fsAPI: {
      getDirectoryHandle: () => directoryHandle,
      openFolderFromHandle: async () => null,
    },
    editorAPI: {
      getValue: () => '',
      setValue: () => {},
    },
    markDirty: () => {},
    getOpenTabPaths: () => ['bitmap.h', 'bitmap.cpp', 'test_runner.sh'],
    getActiveTabPath: () => 'test_runner.sh',
    restoreWorkspace: async () => {},
    storage,
    handleStore,
  });
  await firstSession.persistSession();

  const secondSession = createSessionPersistence({
    fsAPI: {
      getDirectoryHandle: () => null,
      openFolderFromHandle: async () => ({ name: 'project', entries: [] }),
    },
    editorAPI: {
      getValue: () => '',
      setValue: () => {},
    },
    markDirty: () => {},
    getOpenTabPaths: () => ['main.cpp'],
    getActiveTabPath: () => 'main.cpp',
    restoreWorkspace: async (workspace, openTabPaths, activeTabPath) => {
      restored.push({ workspace, openTabPaths, activeTabPath });
    },
    storage,
    handleStore,
  });

  const gate = createPersistenceGate(secondSession.persistSession);
  await gate.persist(); // startup timer fires before restore; must be ignored
  await secondSession.restoreSession();
  gate.enable();

  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].openTabPaths, ['bitmap.h', 'bitmap.cpp', 'test_runner.sh']);
  assert.equal(restored[0].activeTabPath, 'test_runner.sh');
});

test('e2e: restores workspace tabs across reopen with callback-style storage', async () => {
  const storage = createCallbackStorageArea();
  const handleStore = createHandleStore();
  const permissionModes = [];
  const restored = [];

  const directoryHandle = {
    async queryPermission({ mode }) {
      permissionModes.push(`query:${mode}`);
      return 'granted';
    },
    async requestPermission({ mode }) {
      permissionModes.push(`request:${mode}`);
      return 'denied';
    },
  };

  const firstSession = createSessionPersistence({
    fsAPI: {
      getDirectoryHandle: () => directoryHandle,
      openFolderFromHandle: async () => null,
    },
    editorAPI: {
      getValue: () => '',
      setValue: () => {},
    },
    markDirty: () => {},
    getOpenTabPaths: () => ['bitmap.h', 'bitmap.cpp', 'test_runner.sh'],
    getActiveTabPath: () => 'test_runner.sh',
    restoreWorkspace: async () => {},
    storage,
    handleStore,
  });
  await firstSession.persistSession();

  const secondSession = createSessionPersistence({
    fsAPI: {
      getDirectoryHandle: () => null,
      openFolderFromHandle: async () => ({ name: 'project', entries: [] }),
    },
    editorAPI: {
      getValue: () => '',
      setValue: () => {},
    },
    markDirty: () => {},
    getOpenTabPaths: () => [],
    getActiveTabPath: () => null,
    restoreWorkspace: async (workspace, openTabPaths, activeTabPath) => {
      restored.push({ workspace, openTabPaths, activeTabPath });
    },
    storage,
    handleStore,
  });
  await secondSession.restoreSession();

  assert.deepEqual(permissionModes, ['query:read']);
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].openTabPaths, ['bitmap.h', 'bitmap.cpp', 'test_runner.sh']);
  assert.equal(restored[0].activeTabPath, 'test_runner.sh');
});
