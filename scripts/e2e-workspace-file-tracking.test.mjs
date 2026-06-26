import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateNewFilePath,
  directoriesForPath,
  applyWorkspaceMutation,
  diffWorkspaceEntries,
  entryExists,
} from '../src/ui/workspace-fs.mjs';
import { parseDiagnostics, diagnosticsForPath } from '../src/ui/diagnostics.mjs';

// E2E coverage for workspace file tracking: Explorer new-file creation,
// folder-first gating, nested path handling, compile-output visibility, and
// runtime-created file refresh.
//
// Why these tests: file creation now flows through a single workspace-mutation
// contract shared by the Explorer, the compiler artifact persistence path, and
// runtime fstream write-back. Verifying the pure path rules, the filesystem
// index updates (driven through filesystem.js with a fake directory handle), and
// the toolbar UX glue (driven through toolbar.js with a fake DOM) verifies the
// real behaviour without a browser or the WASM toolchain.

// ── Pure path validation/normalisation ────────────────────────────────────────

test('e2e: validateNewFilePath accepts a bare filename at the workspace root', () => {
  assert.deepEqual(validateNewFilePath('main.cpp'), { ok: true, path: 'main.cpp' });
});

test('e2e: validateNewFilePath accepts and normalises nested relative paths', () => {
  assert.deepEqual(validateNewFilePath('src/lib/util.hpp'), { ok: true, path: 'src/lib/util.hpp' });
  assert.deepEqual(validateNewFilePath('./src/main.cpp'), { ok: true, path: 'src/main.cpp' });
  assert.deepEqual(validateNewFilePath('  src//main.cpp  '), { ok: true, path: 'src/main.cpp' });
});

test('e2e: validateNewFilePath rejects empty, absolute, and traversal inputs', () => {
  assert.deepEqual(validateNewFilePath(''), { ok: false, error: 'empty' });
  assert.deepEqual(validateNewFilePath('   '), { ok: false, error: 'empty' });
  assert.deepEqual(validateNewFilePath('/absolute.cpp'), { ok: false, error: 'absolute' });
  assert.deepEqual(validateNewFilePath('../escape.cpp'), { ok: false, error: 'traversal' });
  assert.deepEqual(validateNewFilePath('src/../../escape.cpp'), { ok: false, error: 'traversal' });
  assert.deepEqual(validateNewFilePath('src/'), { ok: false, error: 'no-filename' });
});

// ── Incremental workspace index updates ───────────────────────────────────────

test('e2e: applyWorkspaceMutation adds a root file without parent dirs', () => {
  const { entries, added } = applyWorkspaceMutation([], 'main.cpp');
  assert.deepEqual(entries, [{ path: 'main.cpp', kind: 'file' }]);
  assert.deepEqual(added, [{ path: 'main.cpp', kind: 'file' }]);
});

test('e2e: applyWorkspaceMutation creates missing ancestor directories', () => {
  assert.deepEqual(directoriesForPath('src/lib/util.hpp'), ['src', 'src/lib']);

  const { entries } = applyWorkspaceMutation([{ path: 'README.md', kind: 'file' }], 'src/lib/util.hpp');
  assert.deepEqual(entries, [
    { path: 'README.md', kind: 'file' },
    { path: 'src', kind: 'directory' },
    { path: 'src/lib', kind: 'directory' },
    { path: 'src/lib/util.hpp', kind: 'file' },
  ]);
});

test('e2e: applyWorkspaceMutation does not duplicate existing entries on overwrite', () => {
  const start = [
    { path: 'src', kind: 'directory' },
    { path: 'src/main.cpp', kind: 'file' },
  ];
  const { entries, added } = applyWorkspaceMutation(start, 'src/main.cpp');
  assert.equal(added.length, 0, 'overwrite adds nothing');
  assert.equal(entries.filter((e) => e.path === 'src/main.cpp').length, 1);
  assert.equal(entries.filter((e) => e.path === 'src').length, 1);
});

test('e2e: entryExists detects existing files and directories', () => {
  const entries = [{ path: 'src', kind: 'directory' }, { path: 'a.cpp', kind: 'file' }];
  assert.equal(entryExists(entries, 'a.cpp'), true);
  assert.equal(entryExists(entries, 'src'), true);
  assert.equal(entryExists(entries, 'b.cpp'), false);
});

test('e2e: diffWorkspaceEntries reports added and removed entries in stable order', () => {
  const oldEntries = [
    { path: 'src', kind: 'directory' },
    { path: 'src/main.cpp', kind: 'file' },
    { path: 'tmp.txt', kind: 'file' },
  ];
  const newEntries = [
    { path: 'README.md', kind: 'file' },
    { path: 'src', kind: 'directory' },
    { path: 'src/lib.hpp', kind: 'file' },
  ];

  assert.deepEqual(diffWorkspaceEntries(oldEntries, newEntries), {
    added: [
      { path: 'README.md', kind: 'file' },
      { path: 'src/lib.hpp', kind: 'file' },
    ],
    removed: [
      { path: 'src/main.cpp', kind: 'file' },
      { path: 'tmp.txt', kind: 'file' },
    ],
    changed: [],
  });
});

test('e2e: diffWorkspaceEntries treats kind changes as remove plus add', () => {
  const oldEntries = [{ path: 'build', kind: 'directory' }];
  const newEntries = [{ path: 'build', kind: 'file' }];

  assert.deepEqual(diffWorkspaceEntries(oldEntries, newEntries), {
    added: [{ path: 'build', kind: 'file' }],
    removed: [{ path: 'build', kind: 'directory' }],
    changed: [],
  });
});

test('e2e: diffWorkspaceEntries reports file fingerprint changes', () => {
  const entries = [
    { path: 'src', kind: 'directory' },
    { path: 'src/main.cpp', kind: 'file' },
    { path: 'README.md', kind: 'file' },
  ];
  const oldFingerprints = new Map([
    ['src/main.cpp', { size: 10, lastModified: 100 }],
    ['README.md', { size: 20, lastModified: 200 }],
  ]);
  const newFingerprints = new Map([
    ['src/main.cpp', { size: 11, lastModified: 101 }],
    ['README.md', { size: 20, lastModified: 200 }],
  ]);

  assert.deepEqual(diffWorkspaceEntries(entries, entries, oldFingerprints, newFingerprints), {
    added: [],
    removed: [],
    changed: [{ path: 'src/main.cpp', kind: 'file' }],
  });
});

// ── filesystem.js driven by a fake File System Access directory handle ─────────

class FakeWritable {
  constructor(file) { this._file = file; this._buf = new Uint8Array(); }
  async write(data) {
    this._buf = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
  }
  async close() {
    this._file.data = this._buf;
    this._file.lastModified += 1;
  }
}

class FakeFileHandle {
  constructor(name) {
    this.kind = 'file';
    this.name = name;
    this.data = new Uint8Array();
    this.lastModified = 1;
  }
  async getFile() {
    const data = this.data;
    const lastModified = this.lastModified;
    return {
      size: data.byteLength,
      lastModified,
      async text() { return new TextDecoder().decode(data); },
      async arrayBuffer() { return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength); },
    };
  }
  async createWritable() { return new FakeWritable(this); }
}

class FakeDirHandle {
  constructor(name) { this.kind = 'directory'; this.name = name; this.children = new Map(); }
  async *entries() { for (const pair of this.children) yield pair; }
  async getDirectoryHandle(name, { create = false } = {}) {
    let child = this.children.get(name);
    if (!child) {
      if (!create) { const e = new Error('NotFound'); e.name = 'NotFoundError'; throw e; }
      child = new FakeDirHandle(name);
      this.children.set(name, child);
    }
    return child;
  }
  async getFileHandle(name, { create = false } = {}) {
    let child = this.children.get(name);
    if (!child) {
      if (!create) { const e = new Error('NotFound'); e.name = 'NotFoundError'; throw e; }
      child = new FakeFileHandle(name);
      this.children.set(name, child);
    }
    return child;
  }
  async removeEntry(name) {
    if (!this.children.has(name)) { const e = new Error('NotFound'); e.name = 'NotFoundError'; throw e; }
    this.children.delete(name);
  }
}

async function importFreshFilesystem() {
  // Cache-bust so module-level workspace state is isolated per test.
  return import(`../src/ui/filesystem.js?fs=${Math.random()}`);
}

test('e2e: createWorkspaceFile writes a root file and refreshes the snapshot', async () => {
  const fs = await importFreshFilesystem();
  const root = new FakeDirHandle('project');
  await fs.openFolderFromHandle(root);

  const result = await fs.createWorkspaceFile('main.cpp', '// hi\n');
  assert.equal(result.ok, true);
  assert.equal(result.path, 'main.cpp');
  assert.ok(result.snapshot.entries.some((e) => e.path === 'main.cpp' && e.kind === 'file'));
  // Materialised on disk through the handle.
  assert.equal(await fs.readWorkspaceFile('main.cpp'), '// hi\n');
  assert.ok(root.children.get('main.cpp') instanceof FakeFileHandle);
});

test('e2e: createWorkspaceFile creates missing parent directories for nested paths', async () => {
  const fs = await importFreshFilesystem();
  const root = new FakeDirHandle('project');
  await fs.openFolderFromHandle(root);

  const result = await fs.createWorkspaceFile('src/lib/util.hpp', '');
  assert.equal(result.ok, true);
  const paths = result.snapshot.entries.map((e) => e.path);
  assert.ok(paths.includes('src'));
  assert.ok(paths.includes('src/lib'));
  assert.ok(paths.includes('src/lib/util.hpp'));
  // Real nested directory handles were created.
  const src = root.children.get('src');
  assert.ok(src instanceof FakeDirHandle);
  assert.ok(src.children.get('lib').children.get('util.hpp') instanceof FakeFileHandle);
});

test('e2e: createWorkspaceFile rejects duplicate and invalid paths without mutating', async () => {
  const fs = await importFreshFilesystem();
  const root = new FakeDirHandle('project');
  await fs.openFolderFromHandle(root);
  await fs.createWorkspaceFile('main.cpp', '');

  assert.deepEqual(await fs.createWorkspaceFile('main.cpp', ''), { ok: false, error: 'exists' });
  assert.deepEqual(await fs.createWorkspaceFile('/abs.cpp', ''), { ok: false, error: 'absolute' });
  assert.deepEqual(await fs.createWorkspaceFile('../x.cpp', ''), { ok: false, error: 'traversal' });
  assert.deepEqual(await fs.createWorkspaceFile('', ''), { ok: false, error: 'empty' });

  const snapshot = fs.getWorkspaceSnapshot();
  assert.equal(snapshot.entries.filter((e) => e.path === 'main.cpp').length, 1);
});

test('e2e: createWorkspaceFile refuses when no workspace is open', async () => {
  const fs = await importFreshFilesystem();
  assert.deepEqual(await fs.createWorkspaceFile('main.cpp', ''), { ok: false, error: 'no-workspace' });
});

test('e2e: writeWorkspaceFile materialises a compile artifact and returns the snapshot', async () => {
  const fs = await importFreshFilesystem();
  const root = new FakeDirHandle('project');
  await fs.openFolderFromHandle(root);

  const snapshot = await fs.writeWorkspaceFile('a.out', new Uint8Array([0, 1, 2]));
  assert.ok(snapshot.entries.some((e) => e.path === 'a.out' && e.kind === 'file'));
  assert.ok(root.children.get('a.out') instanceof FakeFileHandle);

  // Repeated builds overwrite cleanly without duplicating Explorer entries.
  const snapshot2 = await fs.writeWorkspaceFile('a.out', new Uint8Array([9]));
  assert.equal(snapshot2.entries.filter((e) => e.path === 'a.out').length, 1);
});

test('e2e: writeWorkspaceFile syncs nested runtime fstream output into the index', async () => {
  const fs = await importFreshFilesystem();
  const root = new FakeDirHandle('project');
  await fs.openFolderFromHandle(root);

  const snapshot = await fs.writeWorkspaceFile('out/logs/run.txt', 'hello\n');
  const paths = snapshot.entries.map((e) => e.path);
  assert.ok(paths.includes('out'));
  assert.ok(paths.includes('out/logs'));
  assert.ok(paths.includes('out/logs/run.txt'));
  assert.equal(await fs.readWorkspaceFile('out/logs/run.txt'), 'hello\n');
});

test('e2e: writeWorkspaceFile is a no-op with no workspace open (no phantom files)', async () => {
  const fs = await importFreshFilesystem();
  assert.equal(await fs.writeWorkspaceFile('a.out', new Uint8Array([1])), null);
});

test('e2e: refreshWorkspace notices files created directly in the opened folder', async () => {
  const fs = await importFreshFilesystem();
  const root = new FakeDirHandle('project');
  await fs.openFolderFromHandle(root);

  const external = new FakeFileHandle('generated.txt');
  external.data = new TextEncoder().encode('from outside\n');
  root.children.set('generated.txt', external);

  const result = await fs.refreshWorkspace({ reason: 'test' });
  assert.deepEqual(result.added, [{ path: 'generated.txt', kind: 'file' }]);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.changed, []);
  assert.ok(result.snapshot.entries.some((e) => e.path === 'generated.txt'));
  assert.equal(await fs.readWorkspaceFile('generated.txt'), 'from outside\n');
});

test('e2e: refreshWorkspace removes files deleted directly from the opened folder', async () => {
  const fs = await importFreshFilesystem();
  const root = new FakeDirHandle('project');
  root.children.set('obsolete.cpp', new FakeFileHandle('obsolete.cpp'));
  await fs.openFolderFromHandle(root);

  root.children.delete('obsolete.cpp');

  const result = await fs.refreshWorkspace({ reason: 'test' });
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, [{ path: 'obsolete.cpp', kind: 'file' }]);
  assert.deepEqual(result.changed, []);
  assert.equal(result.snapshot.entries.some((e) => e.path === 'obsolete.cpp'), false);
  assert.equal(await fs.readWorkspaceFile('obsolete.cpp'), null);
});

test('e2e: refreshWorkspace reports externally edited files by fingerprint', async () => {
  const fs = await importFreshFilesystem();
  const root = new FakeDirHandle('project');
  const main = new FakeFileHandle('main.cpp');
  main.data = new TextEncoder().encode('int main(){return 0;}\n');
  root.children.set('main.cpp', main);
  await fs.openFolderFromHandle(root);

  main.data = new TextEncoder().encode('int main(){return 1;}\n');
  main.lastModified += 1;

  const result = await fs.refreshWorkspace({ reason: 'test' });
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.changed, [{ path: 'main.cpp', kind: 'file' }]);
  assert.equal(await fs.readWorkspaceFile('main.cpp'), 'int main(){return 1;}\n');
});

test('e2e: deleteWorkspaceFile removes a file from disk and refreshes the snapshot', async () => {
  const fs = await importFreshFilesystem();
  const root = new FakeDirHandle('project');
  root.children.set('out.txt', new FakeFileHandle('out.txt'));
  await fs.openFolderFromHandle(root);

  const snapshot = await fs.deleteWorkspaceFile('out.txt');

  assert.equal(root.children.has('out.txt'), false);
  assert.equal(snapshot.entries.some((e) => e.path === 'out.txt'), false);
  assert.equal(await fs.readWorkspaceFile('out.txt'), null);
});

test('e2e: deleteWorkspaceFile is a no-op when no workspace is open', async () => {
  const fs = await importFreshFilesystem();
  assert.equal(await fs.deleteWorkspaceFile('out.txt'), null);
});

// ── Diagnostics stay scoped to the exact path for duplicate basenames ──────────

test('e2e: diagnostics scope to the exact path when basenames collide', () => {
  const output = [
    'src/main.cpp:3:5: error: undeclared identifier in src',
    'tests/main.cpp:7:1: warning: unused variable in tests',
  ].join('\n');
  const all = parseDiagnostics(output);

  const inSrc = diagnosticsForPath(all, 'src/main.cpp');
  assert.equal(inSrc.length, 1);
  assert.equal(inSrc[0].severity, 'error');

  const inTests = diagnosticsForPath(all, 'tests/main.cpp');
  assert.equal(inTests.length, 1);
  assert.equal(inTests[0].severity, 'warning');

  // A bare basename must NOT pull in same-named diagnostics from other dirs.
  assert.equal(diagnosticsForPath(all, 'main.cpp').length, 0);
});

// ── Toolbar Explorer new-file UX driven through a fake DOM ─────────────────────

class FakeElement {
  constructor(tagName, doc) {
    this.tagName = String(tagName).toUpperCase();
    this._doc = doc;
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this._className = '';
    this.classList = {
      _set: new Set(),
      add: (c) => this.classList._set.add(c),
      remove: (c) => this.classList._set.delete(c),
      contains: (c) => this.classList._set.has(c),
      toggle: (c) => {
        if (this.classList._set.has(c)) { this.classList._set.delete(c); return false; }
        this.classList._set.add(c); return true;
      },
    };
    this.textContent = '';
    this.title = '';
    this.value = '';
    this.placeholder = '';
    this.type = '';
    this.disabled = false;
    this.parentNode = null;
    this._id = '';
  }

  set id(v) { this._id = v; if (this._doc && v) this._doc.byId.set(v, this); }
  get id() { return this._id; }

  set className(v) { this._className = v; }
  get className() { return this._className; }

  set innerHTML(value) { if (value === '') this.children = []; }

  get firstChild() { return this.children[0] ?? null; }

  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }

  insertBefore(child, ref) {
    child.parentNode = this;
    const idx = ref ? this.children.indexOf(ref) : -1;
    if (idx === -1) this.children.push(child);
    else this.children.splice(idx, 0, child);
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
    child.unregisterTree?.();
    child.parentNode = null;
    return child;
  }

  unregisterTree() {
    if (this._id) this._doc?.byId.delete(this._id);
    for (const child of this.children) child.unregisterTree?.();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatch(type, event = {}) {
    const base = { preventDefault() {}, stopPropagation() {}, target: this };
    for (const fn of this.listeners.get(type) ?? []) fn({ ...base, ...event });
  }

  click() { this.dispatch('click'); }
  focus() {}

  setAttribute(name, value) {
    if (name === 'id') { this.id = value; return; }
    if (name.startsWith('data-')) this.dataset[name.slice(5)] = value;
  }
  getAttribute() { return null; }

  querySelectorAll(selector) {
    if (selector !== 'li') return [];
    const out = [];
    const visit = (node) => {
      for (const c of node.children) {
        if (c.tagName === 'LI') out.push(c);
        visit(c);
      }
    };
    visit(this);
    return out;
  }
}

function createFakeDocument() {
  const doc = {
    byId: new Map(),
    createElement(tag) { return new FakeElement(tag, doc); },
    getElementById(id) { return doc.byId.get(id) ?? null; },
    addEventListener() {},
  };
  const ids = [
    'btn-new', 'btn-open', 'btn-save', 'btn-save-as', 'btn-compile', 'btn-run',
    'btn-compile-run', 'btn-clear-terminal', 'btn-toggle-terminal',
    'tab-bar', 'file-tree', 'status-file', 'status-compiler', 'cpp-standard',
  ];
  for (const id of ids) {
    const el = new FakeElement('div', doc);
    el.id = id;
  }
  return doc;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeFakes() {
  const editorCalls = { setValue: [] };
  const editorAPI = {
    DEFAULT_SOURCE: '// default\n',
    getValue: () => '',
    setValue(value) { editorCalls.setValue.push(value); },
    clearDiagnostics() {},
    setLanguage() {},
    markDiagnostics() {},
  };
  const terminalCalls = { refresh: [], setWorkspace: [], compileResults: [], runResults: [] };
  const terminalAPI = {
    clearTerminal() {},
    fitTerminal() {},
    printInfo() {},
    startRun() {},
    setWorkspace(w) { terminalCalls.setWorkspace.push(w); },
    refreshWorkspace(w) { terminalCalls.refresh.push(w); },
    onCompileResult(d) { terminalCalls.compileResults.push(d); },
    onRunResult(d) { terminalCalls.runResults.push(d); },
  };
  return { editorAPI, editorCalls, terminalAPI, terminalCalls };
}

async function setupToolbar(fsOverrides = {}) {
  const document = createFakeDocument();
  global.document = document;
  if (fsOverrides.window) global.window = fsOverrides.window;
  else delete global.window;
  const toolbar = await import(`../src/ui/toolbar.js?tb=${Math.random()}`);
  const { editorAPI, editorCalls, terminalAPI, terminalCalls } = makeFakes();

  const fsCalls = { create: [], write: [], delete: [], refresh: [], openFolder: 0 };
  const fsAPI = {
    newFile() {},
    getDirectoryHandle: () => ({}),
    readAllWorkspaceFiles: async () => [],
    readWorkspaceFile: async (path) => {
      if (fsOverrides.readWorkspaceFile) return fsOverrides.readWorkspaceFile(path);
      return '';
    },
    openFolder: async () => { fsCalls.openFolder += 1; return fsOverrides.openFolderResult ?? null; },
    createWorkspaceFile: async (path, content) => {
      fsCalls.create.push({ path, content });
      if (fsOverrides.createWorkspaceFile) return fsOverrides.createWorkspaceFile(path, content);
      return { ok: true, path, snapshot: { name: 'p', entries: [{ path, kind: 'file' }] } };
    },
    writeWorkspaceFile: async (path, bytes) => {
      fsCalls.write.push({ path, bytes });
      return { name: 'p', entries: [{ path, kind: 'file' }] };
    },
    deleteWorkspaceFile: async (path) => {
      fsCalls.delete.push(path);
      return fsOverrides.deleteWorkspaceFileResult ?? { name: 'p', entries: [] };
    },
    refreshWorkspace: async (options) => {
      fsCalls.refresh.push(options);
      if (fsOverrides.refreshWorkspace) return fsOverrides.refreshWorkspace(options);
      return fsOverrides.refreshWorkspaceResult ?? null;
    },
  };

  const worker = { postMessage() {}, onmessage: null };
  toolbar.initToolbar(worker, editorAPI, terminalAPI, fsAPI, () => {});
  return { toolbar, document, worker, editorAPI, editorCalls, terminalAPI, terminalCalls, fsAPI, fsCalls };
}

function inlineInput(document) {
  const row = document.getElementById('file-tree-new-row');
  return row ? row.children.find((c) => c.tagName === 'INPUT') : null;
}

test('e2e: New file with no workspace opens the folder picker; cancel leaves state unchanged', async () => {
  const ctx = await setupToolbar({ openFolderResult: null });
  ctx.toolbar.resetToNewProject(); // no workspace, single main.cpp tab

  ctx.document.getElementById('btn-new').click();
  await tick();

  assert.equal(ctx.fsCalls.openFolder, 1, 'folder picker invoked');
  assert.equal(inlineInput(ctx.document), null, 'no inline input after cancel');
  assert.equal(ctx.fsCalls.create.length, 0, 'no file created');
});

test('e2e: New file with a workspace shows an inline Explorer naming input', async () => {
  const ctx = await setupToolbar();
  await ctx.toolbar.restoreWorkspace({ name: 'p', entries: [] }, [], null);

  ctx.document.getElementById('btn-new').click();
  await tick();

  const input = inlineInput(ctx.document);
  assert.ok(input, 'inline input rendered');
  assert.equal(input.tagName, 'INPUT');
});

test('e2e: submitting a root filename creates the file and opens it as the active tab', async () => {
  const ctx = await setupToolbar();
  await ctx.toolbar.restoreWorkspace({ name: 'p', entries: [] }, [], null);

  ctx.document.getElementById('btn-new').click();
  await tick();
  const input = inlineInput(ctx.document);
  input.value = 'main.cpp';
  input.dispatch('keydown', { key: 'Enter' });
  await tick();

  assert.deepEqual(ctx.fsCalls.create.map((c) => c.path), ['main.cpp']);
  assert.ok(ctx.toolbar.getOpenTabPaths().includes('main.cpp'));
  assert.equal(ctx.toolbar.getActiveTabPath(), 'main.cpp');
  assert.equal(inlineInput(ctx.document), null, 'inline row removed after success');
});

test('e2e: submitting a nested path creates parent directories and opens the file', async () => {
  const ctx = await setupToolbar({
    createWorkspaceFile: (path) => ({
      ok: true,
      path,
      snapshot: {
        name: 'p',
        entries: [
          { path: 'src', kind: 'directory' },
          { path: 'src/lib', kind: 'directory' },
          { path, kind: 'file' },
        ],
      },
    }),
  });
  await ctx.toolbar.restoreWorkspace({ name: 'p', entries: [] }, [], null);

  ctx.document.getElementById('btn-new').click();
  await tick();
  const input = inlineInput(ctx.document);
  input.value = 'src/lib/util.hpp';
  input.dispatch('keydown', { key: 'Enter' });
  await tick();

  assert.deepEqual(ctx.fsCalls.create.map((c) => c.path), ['src/lib/util.hpp']);
  assert.ok(ctx.toolbar.getOpenTabPaths().includes('src/lib/util.hpp'));
  assert.ok(ctx.terminalCalls.refresh.length >= 1, 'terminal workspace refreshed');
});

test('e2e: Escape cancels inline creation and removes the row cleanly', async () => {
  const ctx = await setupToolbar();
  await ctx.toolbar.restoreWorkspace({ name: 'p', entries: [] }, [], null);

  ctx.document.getElementById('btn-new').click();
  await tick();
  const input = inlineInput(ctx.document);
  input.dispatch('keydown', { key: 'Escape' });
  await tick();

  assert.equal(inlineInput(ctx.document), null);
  assert.equal(ctx.fsCalls.create.length, 0);
});

test('e2e: an invalid inline name is rejected and keeps the row open', async () => {
  const ctx = await setupToolbar({
    createWorkspaceFile: () => ({ ok: false, error: 'exists' }),
  });
  await ctx.toolbar.restoreWorkspace({ name: 'p', entries: [] }, [], null);

  ctx.document.getElementById('btn-new').click();
  await tick();
  const input = inlineInput(ctx.document);
  input.value = 'dup.cpp';
  input.dispatch('keydown', { key: 'Enter' });
  await tick();

  assert.ok(inlineInput(ctx.document), 'row stays open for retry');
  assert.equal(ctx.toolbar.getOpenTabPaths().includes('dup.cpp'), false, 'no tab opened');
});

// ── Compile artifact + runtime sync driven through the worker message handler ──

test('e2e: a successful compile persists the artifact into the open workspace', async () => {
  const ctx = await setupToolbar();
  await ctx.toolbar.restoreWorkspace({ name: 'p', entries: [] }, [], null);

  ctx.worker.onmessage({
    data: {
      type: 'compile-result',
      success: true,
      diagnostics: '',
      outputPath: 'a.out',
      outputBytes: new Uint8Array([1, 2, 3]),
    },
  });
  await tick();

  assert.deepEqual(ctx.fsCalls.write.map((c) => c.path), ['a.out']);
  assert.ok(ctx.terminalCalls.refresh.length >= 1, 'Explorer/terminal refreshed for artifact');
});

test('e2e: a failed compile creates no phantom artifact', async () => {
  const ctx = await setupToolbar();
  await ctx.toolbar.restoreWorkspace({ name: 'p', entries: [] }, [], null);

  ctx.worker.onmessage({
    data: { type: 'compile-result', success: false, diagnostics: 'error', outputPath: null, outputBytes: null },
  });
  await tick();

  assert.equal(ctx.fsCalls.write.length, 0);
});

test('e2e: runtime vfsChanges are written back and refresh the workspace', async () => {
  const ctx = await setupToolbar();
  await ctx.toolbar.restoreWorkspace({ name: 'p', entries: [] }, [], null);

  ctx.worker.onmessage({
    data: {
      type: 'run-result',
      exitCode: 0,
      vfsChanges: [{ path: 'out/log.txt', bytes: new TextEncoder().encode('hi') }],
    },
  });
  await tick();

  assert.deepEqual(ctx.fsCalls.write.map((c) => c.path), ['out/log.txt']);
  assert.ok(ctx.terminalCalls.refresh.length >= 1);
});

test('e2e: runtime vfsDeletes are deleted from the workspace and refreshed', async () => {
  const ctx = await setupToolbar({
    deleteWorkspaceFileResult: { name: 'p', entries: [] },
    refreshWorkspaceResult: { snapshot: { name: 'p', entries: [] }, added: [], removed: [], changed: [] },
  });
  await ctx.toolbar.restoreWorkspace({ name: 'p', entries: [{ path: 'old.txt', kind: 'file' }] }, [], null);

  ctx.worker.onmessage({
    data: {
      type: 'run-result',
      exitCode: 0,
      vfsChanges: [],
      vfsDeletes: ['old.txt'],
    },
  });
  await tick();

  assert.deepEqual(ctx.fsCalls.delete, ['old.txt']);
  assert.equal(ctx.terminalCalls.refresh.at(-1).entries.length, 0);
});

test('e2e: run-result sync keeps deleted open tabs while removing them from Explorer', async () => {
  const ctx = await setupToolbar({
    refreshWorkspaceResult: {
      snapshot: { name: 'p', entries: [] },
      added: [],
      removed: [{ path: 'old.cpp', kind: 'file' }],
      changed: [],
    },
  });
  await ctx.toolbar.restoreWorkspace(
    { name: 'p', entries: [{ path: 'old.cpp', kind: 'file' }] },
    ['old.cpp'],
    'old.cpp'
  );

  ctx.worker.onmessage({ data: { type: 'run-result', exitCode: 0, vfsChanges: [] } });
  await tick();

  assert.ok(ctx.toolbar.getOpenTabPaths().includes('old.cpp'), 'deleted backing file tab stays open');
  assert.equal(ctx.terminalCalls.refresh.at(-1).entries.length, 0, 'terminal receives refreshed empty workspace');
});

test('e2e: run-result sync reloads changed clean tabs from disk', async () => {
  let content = 'old content\n';
  const ctx = await setupToolbar({
    readWorkspaceFile: async () => content,
    refreshWorkspaceResult: {
      snapshot: { name: 'p', entries: [{ path: 'main.cpp', kind: 'file' }] },
      added: [],
      removed: [],
      changed: [{ path: 'main.cpp', kind: 'file' }],
    },
  });
  await ctx.toolbar.restoreWorkspace(
    { name: 'p', entries: [{ path: 'main.cpp', kind: 'file' }] },
    ['main.cpp'],
    'main.cpp'
  );

  content = 'new content\n';
  ctx.worker.onmessage({ data: { type: 'run-result', exitCode: 0, vfsChanges: [] } });
  await tick();

  assert.equal(ctx.editorCalls.setValue.at(-1), 'new content\n');
});

test('e2e: run-result sync preserves changed dirty tabs', async () => {
  let content = 'old content\n';
  const ctx = await setupToolbar({
    readWorkspaceFile: async () => content,
    refreshWorkspaceResult: {
      snapshot: { name: 'p', entries: [{ path: 'main.cpp', kind: 'file' }] },
      added: [],
      removed: [],
      changed: [{ path: 'main.cpp', kind: 'file' }],
    },
  });
  await ctx.toolbar.restoreWorkspace(
    { name: 'p', entries: [{ path: 'main.cpp', kind: 'file' }] },
    ['main.cpp'],
    'main.cpp'
  );
  ctx.toolbar.markDirty(true);

  content = 'new content\n';
  ctx.worker.onmessage({ data: { type: 'run-result', exitCode: 0, vfsChanges: [] } });
  await tick();

  assert.equal(ctx.editorCalls.setValue.at(-1), 'old content\n');
});

test('e2e: workspace polling starts in workspace mode and stops on reset', async () => {
  const intervals = [];
  const cleared = [];
  const fakeWindow = {
    addEventListener() {},
    setInterval(fn, ms) {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval(id) { cleared.push(id); },
  };
  const ctx = await setupToolbar({ window: fakeWindow });

  await ctx.toolbar.restoreWorkspace({ name: 'p', entries: [] }, [], null);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 2000);

  ctx.toolbar.resetToNewProject();
  assert.deepEqual(cleared, [1]);
});

test('e2e: with no workspace open, compile/run perform no workspace write-back', async () => {
  const ctx = await setupToolbar();
  ctx.toolbar.resetToNewProject(); // no workspace

  ctx.worker.onmessage({
    data: { type: 'compile-result', success: true, diagnostics: '', outputPath: 'a.out', outputBytes: new Uint8Array([1]) },
  });
  await tick();
  ctx.worker.onmessage({
    data: { type: 'run-result', exitCode: 0, vfsChanges: [{ path: 'log.txt', bytes: new Uint8Array([1]) }] },
  });
  await tick();

  assert.equal(ctx.fsCalls.write.length, 0, 'no write-back without an open folder');
});
