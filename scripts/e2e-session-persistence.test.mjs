import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSessionPersistence,
  createPersistenceGate,
} from '../src/ui/session-persistence.mjs';
import {
  initToolbar,
  restoreWorkspace as restoreToolbarWorkspace,
  getOpenTabPaths as getToolbarOpenTabPaths,
} from '../src/ui/toolbar.js';

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.classList = {
      add() {},
      remove() {},
    };
    this.textContent = '';
    this.title = '';
    this.parentNode = null;
  }

  set innerHTML(value) {
    if (value === '') {
      this.children = [];
    }
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  setAttribute(name, value) {
    if (name.startsWith('data-')) {
      this.dataset[name.slice(5)] = value;
    }
  }

  querySelectorAll(selector) {
    if (selector !== 'li') return [];
    const results = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.tagName === 'LI') results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }

  click() {
    this.listeners.get('click')?.({
      stopPropagation() {},
      target: this,
    });
  }
}

function createFakeDocument() {
  const ids = [
    'btn-new',
    'btn-open',
    'btn-save',
    'btn-save-as',
    'btn-compile',
    'btn-run',
    'btn-compile-run',
    'btn-clear-terminal',
    'btn-toggle-terminal',
    'tab-bar',
    'file-tree',
    'status-file',
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement('div')]));
  return {
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    getElementById(id) {
      return elements.get(id) ?? null;
    },
    addEventListener() {},
  };
}

async function waitFor(condition, description, retries = 10) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Condition not met within ${retries} retries: ${description}`);
}

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

function createDelayedStorageArea() {
  const data = new Map();
  let resumeGet = null;
  let delayNextGet = true;
  return {
    storage: {
      async get(key) {
        if (delayNextGet) {
          delayNextGet = false;
          await new Promise((resolve) => {
            resumeGet = resolve;
          });
        }
        return { [key]: data.get(key) };
      },
      async set(value) {
        for (const [key, item] of Object.entries(value)) {
          data.set(key, item);
        }
      },
    },
    resolveGet() {
      if (resumeGet) {
        const resolve = resumeGet;
        resumeGet = null;
        resolve();
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

function createFailingHandleStore() {
  return {
    async save() {
      throw new Error('handle save failed');
    },
    async load() {
      return null;
    },
    async clear() {},
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

  assert.deepEqual(permissionModes, ['query:readwrite', 'request:readwrite', 'query:read']);
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
  await gate.enable();

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

  assert.deepEqual(permissionModes, ['query:readwrite']);
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].openTabPaths, ['bitmap.h', 'bitmap.cpp', 'test_runner.sh']);
  assert.equal(restored[0].activeTabPath, 'test_runner.sh');
});

test('e2e: relaunch requests readwrite permission before restoring workspace', async () => {
  const storage = createStorageArea();
  const handleStore = createHandleStore();
  const permissionModes = [];
  const restored = [];
  const queryResults = { readwrite: 'prompt', read: 'denied' };

  const directoryHandle = {
    async queryPermission({ mode }) {
      permissionModes.push(`query:${mode}`);
      return queryResults[mode] ?? 'denied';
    },
    async requestPermission({ mode }) {
      permissionModes.push(`request:${mode}`);
      return mode === 'readwrite' ? 'granted' : 'denied';
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
    getOpenTabPaths: () => ['bitmap.h', 'bitmap.cpp'],
    getActiveTabPath: () => 'bitmap.cpp',
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

  assert.deepEqual(permissionModes, ['query:readwrite', 'request:readwrite']);
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].openTabPaths, ['bitmap.h', 'bitmap.cpp']);
  assert.equal(restored[0].activeTabPath, 'bitmap.cpp');
});

test('e2e: launch/open-files/close/relaunch restores explorer folder and tabs', async () => {
  const { storage, resolveGet } = createDelayedStorageArea();
  const handleStore = createHandleStore();
  const restored = [];
  const permissionModes = [];
  const directoryHandle = {
    name: 'browser.cpp',
    async queryPermission({ mode }) {
      permissionModes.push(`query:${mode}`);
      return 'granted';
    },
    async requestPermission({ mode }) {
      permissionModes.push(`request:${mode}`);
      return 'granted';
    },
  };
  const workspace = {
    name: 'browser.cpp',
    entries: [
      { path: 'bitmap.h', kind: 'file' },
      { path: 'bitmap.cpp', kind: 'file' },
      { path: 'test_runner.sh', kind: 'file' },
      { path: 'README.md', kind: 'file' },
    ],
  };

  const launchOneState = {
    directoryHandle: null,
    openTabPaths: [],
    activeTabPath: null,
  };
  const launchOne = createSessionPersistence({
    fsAPI: {
      getDirectoryHandle: () => launchOneState.directoryHandle,
      openFolderFromHandle: async () => workspace,
    },
    editorAPI: {
      getValue: () => '',
      setValue: () => {},
    },
    markDirty: () => {},
    getOpenTabPaths: () => launchOneState.openTabPaths,
    getActiveTabPath: () => launchOneState.activeTabPath,
    restoreWorkspace: async () => {},
    storage,
    handleStore,
  });
  const launchOneGate = createPersistenceGate(launchOne.persistSession);
  const launchOneRestore = launchOne.restoreSession();

  // Simulate user flow before startup restore completes:
  // launch -> open folder (grant permission) -> open files -> close tab.
  launchOneState.directoryHandle = directoryHandle;
  launchOneState.openTabPaths = ['README.md'];
  launchOneState.activeTabPath = 'README.md';
  await launchOneGate.persist(); // folder open + initial tab
  launchOneState.openTabPaths = ['README.md', 'bitmap.h', 'bitmap.cpp', 'test_runner.sh'];
  launchOneState.activeTabPath = 'test_runner.sh';
  await launchOneGate.persist(); // multiple file tabs open
  launchOneState.openTabPaths = ['bitmap.h', 'bitmap.cpp', 'test_runner.sh'];
  launchOneState.activeTabPath = 'test_runner.sh';
  await launchOneGate.persist(); // README closed

  // Closing and relaunching the extension tab:
  resolveGet();
  await launchOneRestore;
  await launchOneGate.enable();

  const launchTwo = createSessionPersistence({
    fsAPI: {
      getDirectoryHandle: () => null,
      openFolderFromHandle: async (handle) => {
        assert.equal(handle, directoryHandle);
        return workspace;
      },
    },
    editorAPI: {
      getValue: () => '',
      setValue: () => {},
    },
    markDirty: () => {},
    getOpenTabPaths: () => [],
    getActiveTabPath: () => null,
    restoreWorkspace: async (nextWorkspace, openTabPaths, activeTabPath) => {
      restored.push({ workspace: nextWorkspace, openTabPaths, activeTabPath });
    },
    storage,
    handleStore,
  });

  await launchTwo.restoreSession();

  assert.deepEqual(permissionModes, ['query:readwrite']);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].workspace.name, 'browser.cpp');
  assert.deepEqual(restored[0].openTabPaths, ['bitmap.h', 'bitmap.cpp', 'test_runner.sh']);
  assert.equal(restored[0].activeTabPath, 'test_runner.sh');
});

test('e2e: restores explorer folder and tabs when handle reload is unavailable', async () => {
  const storage = createStorageArea();
  const handleStore = createFailingHandleStore();
  const restored = [];
  const workspace = {
    name: 'browser.cpp',
    entries: [
      { path: 'bitmap.h', kind: 'file' },
      { path: 'bitmap.cpp', kind: 'file' },
      { path: 'test_runner.sh', kind: 'file' },
    ],
    git: { isRepo: true, branch: 'main', remotes: ['origin'] },
  };
  const tabContentByPath = {
    'bitmap.h': '#pragma once\n',
    'bitmap.cpp': '#include "bitmap.h"\n',
    'test_runner.sh': '#!/bin/bash\n',
  };

  const firstSession = createSessionPersistence({
    fsAPI: {
      getDirectoryHandle: () => ({ name: 'browser.cpp' }),
      getWorkspaceSnapshot: () => workspace,
      openFolderFromHandle: async () => null,
    },
    editorAPI: {
      getValue: () => '',
      setValue: () => {},
    },
    markDirty: () => {},
    getOpenTabPaths: () => ['bitmap.h', 'bitmap.cpp', 'test_runner.sh'],
    getActiveTabPath: () => 'test_runner.sh',
    getOpenTabsSnapshot: () => tabContentByPath,
    restoreWorkspace: async () => {},
    storage,
    handleStore,
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args);
  };
  try {
    await firstSession.persistSession();
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /Failed to persist workspace directory handle/);

  const secondSession = createSessionPersistence({
    fsAPI: {
      getDirectoryHandle: () => null,
      openFolderFromHandle: async () => {
        throw new Error('handle restore should not be attempted');
      },
    },
    editorAPI: {
      getValue: () => '',
      setValue: () => {},
    },
    markDirty: () => {},
    getOpenTabPaths: () => [],
    getActiveTabPath: () => null,
    restoreWorkspace: async (restoredWorkspace, openTabPaths, activeTabPath, restoredTabContentByPath) => {
      restored.push({
        restoredWorkspace,
        openTabPaths,
        activeTabPath,
        restoredTabContentByPath,
      });
    },
    storage,
    handleStore,
  });

  await secondSession.restoreSession();

  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].restoredWorkspace, workspace);
  assert.deepEqual(restored[0].openTabPaths, ['bitmap.h', 'bitmap.cpp', 'test_runner.sh']);
  assert.equal(restored[0].activeTabPath, 'test_runner.sh');
  assert.deepEqual(restored[0].restoredTabContentByPath, tabContentByPath);
});

test('e2e: after snapshot restore, selecting another file reconnects workspace and opens file', async () => {
  const originalDocument = global.document;
  global.document = createFakeDocument();
  try {
    const workspace = {
      name: 'browser.cpp',
      entries: [
        { path: 'bitmap.h', kind: 'file' },
        { path: 'bitmap.cpp', kind: 'file' },
      ],
    };
    const filesByPath = {
      'bitmap.h': '#pragma once\n',
      'bitmap.cpp': '#include "bitmap.h"\n',
    };
    let connected = false;
    let openFolderCalls = 0;

    initToolbar(
      { onmessage: null, postMessage() {} },
      {
        getValue: () => '',
        setValue: () => {},
        clearDiagnostics: () => {},
        setLanguage: () => {},
      },
      {
        setWorkspace: () => {},
        clearTerminal: () => {},
      },
      {
        getDirectoryHandle: () => (connected ? { name: 'browser.cpp' } : null),
        openFolder: async () => {
          openFolderCalls += 1;
          connected = true;
          return workspace;
        },
        readWorkspaceFile: async (path) => (connected ? filesByPath[path] ?? null : null),
      },
      () => {}
    );

    await restoreToolbarWorkspace(workspace, ['bitmap.h'], 'bitmap.h', {
      'bitmap.h': filesByPath['bitmap.h'],
    });
    assert.deepEqual(getToolbarOpenTabPaths(), ['bitmap.h']);

    const treeItems = global.document.getElementById('file-tree').querySelectorAll('li');
    const bitmapCppItem = treeItems.find((item) => item.dataset.path === 'bitmap.cpp');
    assert.ok(bitmapCppItem, 'expected bitmap.cpp in restored explorer');
    bitmapCppItem.click();
    await waitFor(
      () => getToolbarOpenTabPaths().includes('bitmap.cpp'),
      'bitmap.cpp tab should open after workspace reconnect'
    );

    assert.equal(openFolderCalls, 1);
    assert.deepEqual(getToolbarOpenTabPaths(), ['bitmap.h', 'bitmap.cpp']);
  } finally {
    global.document = originalDocument;
  }
});
