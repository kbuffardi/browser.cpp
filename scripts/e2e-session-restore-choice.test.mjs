import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionPersistence } from '../src/ui/session-persistence.mjs';

// Dedicated coverage for the relaunch reload-vs-start-new user choice. The
// persistence mechanics (handle reload, snapshot fallback, gate timing) live in
// e2e-session-persistence.test.mjs; this suite focuses on the prompt contract:
// what happens once the user picks "Reload previous project" or "Start new
// project" (and that source-only sessions never prompt).

function createStorageArea() {
  const data = new Map();
  return {
    data,
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

function createHandleStore(initialHandle = null) {
  let handle = initialHandle;
  return {
    get current() {
      return handle;
    },
    async save(next) {
      handle = next;
    },
    async load() {
      return handle;
    },
    async clear() {
      handle = null;
    },
  };
}

// Persist a workspace session (with a stored handle + snapshot) so a relaunch
// instance can exercise the reload/start-new branches against real storage.
async function seedWorkspaceSession({ storage, handleStore, handle, snapshot, openTabPaths, activeTabPath, tabContents }) {
  const first = createSessionPersistence({
    fsAPI: {
      getDirectoryHandle: () => handle,
      getWorkspaceSnapshot: () => snapshot,
      openFolderFromHandle: async () => null,
    },
    editorAPI: { getValue: () => '', setValue: () => {} },
    markDirty: () => {},
    getOpenTabPaths: () => openTabPaths,
    getActiveTabPath: () => activeTabPath,
    getOpenTabsSnapshot: () => tabContents ?? null,
    restoreWorkspace: async () => {},
    storage,
    handleStore,
  });
  await first.persistSession();
}

test('e2e: reload choice re-requests readwrite and restores the live workspace', async () => {
  const storage = createStorageArea();
  const handleStore = createHandleStore();
  const events = [];
  const handle = {
    name: 'project',
    async queryPermission() {
      events.push('query');
      return 'prompt';
    },
    async requestPermission() {
      events.push('request');
      return 'granted';
    },
  };
  const workspace = { name: 'project', entries: [{ path: 'bitmap.cpp', kind: 'file' }] };
  await seedWorkspaceSession({
    storage,
    handleStore,
    handle,
    snapshot: workspace,
    openTabPaths: ['bitmap.h', 'bitmap.cpp'],
    activeTabPath: 'bitmap.cpp',
  });

  const restored = [];
  let startNewCalled = false;
  let confirmCalls = 0;
  const second = createSessionPersistence({
    fsAPI: {
      getDirectoryHandle: () => null,
      openFolderFromHandle: async (h) => {
        assert.equal(h, handle);
        return workspace;
      },
    },
    editorAPI: { getValue: () => '', setValue: () => {} },
    markDirty: () => {},
    getOpenTabPaths: () => [],
    getActiveTabPath: () => null,
    restoreWorkspace: async (ws, openTabPaths, activeTabPath, tabContentByPath) => {
      restored.push({ ws, openTabPaths, activeTabPath, tabContentByPath });
    },
    storage,
    handleStore,
    confirmReload: async () => {
      confirmCalls += 1;
      return true;
    },
    startNewProject: () => {
      startNewCalled = true;
    },
  });

  await second.restoreSession();

  assert.equal(confirmCalls, 1, 'user is prompted exactly once');
  assert.deepEqual(events, ['query', 'request']);
  assert.equal(startNewCalled, false);
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].openTabPaths, ['bitmap.h', 'bitmap.cpp']);
  assert.equal(restored[0].activeTabPath, 'bitmap.cpp');
});

test('e2e: start-new clears session + handle + live fs state and loads default', async () => {
  const storage = createStorageArea();
  const handleStore = createHandleStore();
  const handle = {
    name: 'project',
    async queryPermission() {
      return 'prompt';
    },
    async requestPermission() {
      throw new Error('should not request permission when starting new');
    },
  };
  await seedWorkspaceSession({
    storage,
    handleStore,
    handle,
    snapshot: { name: 'project', entries: [{ path: 'bitmap.cpp', kind: 'file' }] },
    openTabPaths: ['bitmap.cpp'],
    activeTabPath: 'bitmap.cpp',
    tabContents: { 'bitmap.cpp': '#include <iostream>\n' },
  });
  assert.ok(handleStore.current, 'handle stored after first persist');

  const restored = [];
  let fsReset = false;
  let defaultLoaded = false;
  const second = createSessionPersistence({
    fsAPI: {
      getDirectoryHandle: () => null,
      openFolderFromHandle: async () => {
        throw new Error('workspace restore must not run on start-new');
      },
      resetWorkspace: () => {
        fsReset = true;
      },
    },
    editorAPI: { getValue: () => '', setValue: () => {} },
    markDirty: () => {},
    getOpenTabPaths: () => [],
    getActiveTabPath: () => null,
    restoreWorkspace: async () => {
      restored.push('workspace');
    },
    storage,
    handleStore,
    confirmReload: async () => false,
    startNewProject: () => {
      defaultLoaded = true;
    },
  });

  await second.restoreSession();

  assert.equal(restored.length, 0, 'nothing restored');
  assert.equal(fsReset, true, 'in-memory workspace state cleared');
  assert.equal(defaultLoaded, true, 'default new-project state loaded');
  assert.equal(handleStore.current, null, 'stored handle cleared');
  const remaining = await storage.get('browser_cpp_session');
  assert.equal(remaining.browser_cpp_session, null, 'persisted session cleared');
});

test('e2e: after start-new, the next persist saves fresh state not the abandoned workspace', async () => {
  const storage = createStorageArea();
  const handleStore = createHandleStore();
  const handle = {
    name: 'project',
    async queryPermission() {
      return 'prompt';
    },
    async requestPermission() {
      return 'denied';
    },
  };
  await seedWorkspaceSession({
    storage,
    handleStore,
    handle,
    snapshot: { name: 'project', entries: [] },
    openTabPaths: ['old.cpp'],
    activeTabPath: 'old.cpp',
  });

  // Shared live state: clearPersistedSession() must null the directory handle so
  // a follow-up persist records the default source-only session.
  const live = { directoryHandle: handle, source: 'int main() { /* fresh */ }\n' };
  const persistence = createSessionPersistence({
    fsAPI: {
      getDirectoryHandle: () => live.directoryHandle,
      openFolderFromHandle: async () => null,
      resetWorkspace: () => {
        live.directoryHandle = null;
      },
    },
    editorAPI: { getValue: () => live.source, setValue: () => {} },
    markDirty: () => {},
    getOpenTabPaths: () => [],
    getActiveTabPath: () => null,
    restoreWorkspace: async () => {},
    storage,
    handleStore,
    confirmReload: async () => false,
    startNewProject: () => {},
  });

  await persistence.restoreSession();
  await persistence.persistSession();

  const saved = (await storage.get('browser_cpp_session')).browser_cpp_session;
  assert.ok(saved, 'a session is persisted');
  assert.equal(saved.source, 'int main() { /* fresh */ }\n');
  assert.equal(saved.openTabPaths, undefined, 'no workspace tabs persisted');
  assert.equal(handleStore.current, null, 'no directory handle persisted');
});

test('e2e: snapshot-only session prompts before restoring (reload chosen)', async () => {
  const storage = createStorageArea();
  // No reloadable handle, but a workspace snapshot exists.
  const handleStore = {
    async save() {},
    async load() {
      return null;
    },
    async clear() {},
  };
  const workspace = { name: 'project', entries: [{ path: 'main.cpp', kind: 'file' }] };
  await seedWorkspaceSession({
    storage,
    handleStore,
    handle: { name: 'project' },
    snapshot: workspace,
    openTabPaths: ['main.cpp'],
    activeTabPath: 'main.cpp',
    tabContents: { 'main.cpp': 'int main(){}\n' },
  });

  const restored = [];
  let confirmCalls = 0;
  const second = createSessionPersistence({
    fsAPI: {
      getDirectoryHandle: () => null,
      openFolderFromHandle: async () => {
        throw new Error('no handle reload expected');
      },
    },
    editorAPI: { getValue: () => '', setValue: () => {} },
    markDirty: () => {},
    getOpenTabPaths: () => [],
    getActiveTabPath: () => null,
    restoreWorkspace: async (ws, openTabPaths, activeTabPath, tabContentByPath) => {
      restored.push({ ws, openTabPaths, activeTabPath, tabContentByPath });
    },
    storage,
    handleStore,
    confirmReload: async () => {
      confirmCalls += 1;
      return true;
    },
  });

  await second.restoreSession();

  assert.equal(confirmCalls, 1, 'snapshot-only restore still confirms first');
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].ws, workspace);
  assert.deepEqual(restored[0].tabContentByPath, { 'main.cpp': 'int main(){}\n' });
});

test('e2e: source-only session auto-restores without prompting', async () => {
  const storage = createStorageArea();
  const handleStore = createHandleStore();

  const first = createSessionPersistence({
    fsAPI: { getDirectoryHandle: () => null, openFolderFromHandle: async () => null },
    editorAPI: { getValue: () => 'int main() { return 0; }\n', setValue: () => {} },
    markDirty: () => {},
    getOpenTabPaths: () => [],
    getActiveTabPath: () => null,
    restoreWorkspace: async () => {},
    storage,
    handleStore,
  });
  await first.persistSession();

  let restoredSource = null;
  let dirty = true;
  let confirmCalls = 0;
  const second = createSessionPersistence({
    fsAPI: { getDirectoryHandle: () => null, openFolderFromHandle: async () => null },
    editorAPI: {
      getValue: () => '',
      setValue: (source) => {
        restoredSource = source;
      },
    },
    markDirty: (value) => {
      dirty = value;
    },
    getOpenTabPaths: () => [],
    getActiveTabPath: () => null,
    restoreWorkspace: async () => {},
    storage,
    handleStore,
    confirmReload: async () => {
      confirmCalls += 1;
      return true;
    },
  });

  await second.restoreSession();

  assert.equal(confirmCalls, 0, 'source-only sessions never prompt');
  assert.equal(restoredSource, 'int main() { return 0; }\n');
  assert.equal(dirty, false);
});

test('e2e: granted permission up front restores without prompting', async () => {
  const storage = createStorageArea();
  const handleStore = createHandleStore();
  const handle = {
    name: 'project',
    async queryPermission() {
      return 'granted';
    },
    async requestPermission() {
      throw new Error('should not request when already granted');
    },
  };
  const workspace = { name: 'project', entries: [] };
  await seedWorkspaceSession({
    storage,
    handleStore,
    handle,
    snapshot: workspace,
    openTabPaths: ['a.cpp', 'b.cpp'],
    activeTabPath: 'b.cpp',
  });

  const restored = [];
  let confirmCalls = 0;
  const second = createSessionPersistence({
    fsAPI: {
      getDirectoryHandle: () => null,
      openFolderFromHandle: async () => workspace,
    },
    editorAPI: { getValue: () => '', setValue: () => {} },
    markDirty: () => {},
    getOpenTabPaths: () => [],
    getActiveTabPath: () => null,
    restoreWorkspace: async (ws, openTabPaths, activeTabPath) => {
      restored.push({ openTabPaths, activeTabPath });
    },
    storage,
    handleStore,
    confirmReload: async () => {
      confirmCalls += 1;
      return true;
    },
  });

  await second.restoreSession();

  assert.equal(confirmCalls, 0, 'no prompt when write permission already granted');
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].openTabPaths, ['a.cpp', 'b.cpp']);
  assert.equal(restored[0].activeTabPath, 'b.cpp');
});
