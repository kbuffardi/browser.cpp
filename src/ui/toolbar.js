/**
 * src/ui/toolbar.js
 *
 * Wires up toolbar buttons and keyboard shortcuts to the compiler worker.
 * Acts as the bridge between the UI, the editor, the terminal, and the worker.
 *
 * Exported:
 *   initToolbar(worker, editorAPI, terminalAPI, filesystemAPI)
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let _worker      = null;
let _editorAPI   = null;
let _terminalAPI = null;
let _fsAPI       = null;
let _fileName    = 'main.cpp';
let _workspace   = null;
const _expandedWorkspaceDirectories = new Set();

// ── Multi-tab state ───────────────────────────────────────────────────────────
// Map<path, { content: string, dirty: boolean }>
const _openTabs = new Map();
let _activeTabPath = null;
/** When true, programmatic setValue calls do not trigger markDirty(true). */
let _loadingFile = false;

// ── Session persistence callback ──────────────────────────────────────────────
/** Optional callback supplied by app.js to persist the session after state changes. */
let _persistSession = null;
let _persistTimer = null;

/** Schedule a debounced session persist (e.g. after active-tab switches). */
function schedulePersist() {
  if (!_persistSession) return;
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => _persistSession(), 300);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialise the toolbar, hooking up all buttons and keyboard shortcuts.
 *
 * @param {Worker}  worker         – compiler.worker instance
 * @param {object}  editorAPI      – module exports from editor.js
 * @param {object}  terminalAPI    – module exports from terminal.js
 * @param {object}  fsAPI          – module exports from filesystem.js
 * @param {Function} [persistSession] – optional callback to persist session state
 */
export function initToolbar(worker, editorAPI, terminalAPI, fsAPI, persistSession) {
  _worker      = worker;
  _editorAPI   = editorAPI;
  _terminalAPI = terminalAPI;
  _fsAPI       = fsAPI;
  _persistSession = persistSession ?? null;

  bindButtons();
  bindKeyboardShortcuts();
  handleWorkerMessages();
  updateStatusBar('compiler', 'loading', 'Compiler loading…');
}

// ── Button bindings ───────────────────────────────────────────────────────────

function bindButtons() {
  on('btn-new',          () => actionNew());
  on('btn-open',         () => actionOpen());
  on('btn-save',         () => actionSave());
  on('btn-save-as',      () => actionSaveAs());
  on('btn-compile',      () => actionCompile());
  on('btn-run',          () => actionRun());
  on('btn-compile-run',  () => actionCompileRun());
  on('btn-clear-terminal', () => _terminalAPI.clearTerminal());
  on('btn-toggle-terminal',() => toggleTerminalPanel());
}

function on(id, handler) {
  document.getElementById(id)?.addEventListener('click', handler);
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

function bindKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5') {
      e.preventDefault();
      actionCompileRun();
    } else if (e.ctrlKey && e.shiftKey && e.key === 'B') {
      e.preventDefault();
      actionCompile();
    } else if (e.ctrlKey && e.shiftKey && e.key === 'R') {
      e.preventDefault();
      actionRun();
    } else if (e.ctrlKey && !e.shiftKey && e.key === 's') {
      e.preventDefault();
      actionSave();
    } else if (e.ctrlKey && e.key === 'o') {
      e.preventDefault();
      actionOpen();
    } else if (e.ctrlKey && e.key === 'n') {
      e.preventDefault();
      actionNew();
    } else if (e.ctrlKey && e.key === 'k') {
      // Ctrl+K clears the terminal regardless of which element has focus
      _terminalAPI.clearTerminal();
    }
  });
}

// ── Worker message handler ────────────────────────────────────────────────────

function handleWorkerMessages() {
  _worker.onmessage = ({ data }) =>
    handleWorkerMessage(data).catch((err) =>
      console.error('[browser.cpp] Worker message handler error:', err)
    );
}

async function handleWorkerMessage(data) {
  switch (data.type) {
    case 'compiler-loading':
      updateStatusBar(
        'compiler', 'loading',
        `Loading compiler… ${data.progress}%`
      );
      break;

    case 'compiler-ready':
      updateStatusBar('compiler', 'ready', 'Compiler ready');
      _terminalAPI.printInfo('Clang WASM compiler loaded. Ready to compile C++20.');
      break;

    case 'compiler-error':
      updateStatusBar('compiler', 'error', 'Compiler unavailable');
      _terminalAPI.printInfo(
        `⚠ Compiler not available:\n${data.message}\n\n` +
        'Run:  npm run fetch-clang  then reload the extension.'
      );
      break;

    case 'compile-start':
      updateStatusBar('compiler', 'busy', 'Compiling…');
      setButtonsEnabled(false);
      _editorAPI.clearDiagnostics();
      break;

    case 'compile-result': {
      setButtonsEnabled(true);
      updateStatusBar('compiler', 'ready', 'Compiler ready');

      // Parse and render inline diagnostics in the editor
      if (data.diagnostics) {
        const items = _editorAPI.parseDiagnostics(data.diagnostics);
        if (items.length) _editorAPI.markDiagnostics(items);
      }

      _terminalAPI.onCompileResult(data);
      break;
    }

    case 'run-start':
      updateStatusBar('compiler', 'busy', 'Running…');
      setButtonsEnabled(false);
      break;

    case 'stdout':
      _terminalAPI.writeStdout(data.data);
      break;

    case 'stderr':
      _terminalAPI.writeStderr(data.data);
      break;

    case 'run-result':
      setButtonsEnabled(true);
      updateStatusBar('compiler', 'ready', 'Compiler ready');
      _terminalAPI.onRunResult(data);
      // Write any files created or modified by the program back to the workspace
      if (data.vfsChanges?.length && _fsAPI?.writeWorkspaceFile) {
        for (const change of data.vfsChanges) {
          try {
            await _fsAPI.writeWorkspaceFile(change.path, change.bytes);
          } catch (err) {
            console.warn('[browser.cpp] Failed to write file to workspace:', change.path, err);
          }
        }
      }
      break;

    default:
      break;
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

function actionNew() {
  if (hasUnsavedChanges() && !confirm('Discard unsaved changes?')) return;
  closeAllTabs();
  _fsAPI.newFile();
  clearWorkspaceMode();
  const defaultContent = _editorAPI.DEFAULT_SOURCE ?? '';
  openTabForFile('main.cpp', defaultContent);
}

async function actionSave() {
  try {
    const name = await _fsAPI.saveFile(_editorAPI.getValue(), _fileName);
    if (name) {
      setFileName(name);
      markDirty(false);
    }
  } catch (err) {
    alert(`Could not save file:\n${err.message}`);
  }
}

async function actionSaveAs() {
  try {
    const name = await _fsAPI.saveFileAs(_editorAPI.getValue(), _fileName);
    if (name) {
      setFileName(name);
      markDirty(false);
    }
  } catch (err) {
    alert(`Could not save file:\n${err.message}`);
  }
}

async function actionCompile() {
  const source = _editorAPI.getValue();
  const std    = document.getElementById('cpp-standard')?.value || 'c++20';
  const vfsFiles = await _fsAPI.readAllWorkspaceFiles();
  _worker.postMessage({
    type: 'compile',
    source,
    flags: [],
    std,
    fileName: _activeTabPath || 'input.cpp',
    vfsFiles,
  });
}

function actionRun() {
  _terminalAPI.startRun();
}

async function actionCompileRun() {
  const source = _editorAPI.getValue();
  const std    = document.getElementById('cpp-standard')?.value || 'c++20';
  const vfsFiles = await _fsAPI.readAllWorkspaceFiles();

  // Chain: compile → on success, immediately run
  const originalOnMessage = _worker.onmessage;
  const oneShot = ({ data }) => {
    if (data.type === 'compile-result') {
      _worker.onmessage = originalOnMessage;
      originalOnMessage({ data }); // let normal handler render diagnostics
      if (data.success) {
        _terminalAPI.startRun();
      }
    } else {
      originalOnMessage({ data });
    }
  };
  _worker.onmessage = oneShot;
  _worker.postMessage({
    type: 'compile',
    source,
    flags: [],
    std,
    fileName: _activeTabPath || 'input.cpp',
    vfsFiles,
  });
}

// ── Terminal panel toggle ─────────────────────────────────────────────────────

function toggleTerminalPanel() {
  const panel  = document.getElementById('terminal-panel');
  const btn    = document.getElementById('btn-toggle-terminal');
  const collapsed = panel.classList.toggle('collapsed');
  btn.textContent = collapsed ? '▸' : '▾';
  if (!collapsed) {
    _terminalAPI.fitTerminal();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Update the compiler status indicator in the status bar.
 * @param {'compiler'} area
 * @param {'loading'|'ready'|'error'|'busy'} state
 * @param {string} message
 */
function updateStatusBar(area, state, message) {
  const el = document.getElementById(`status-${area}`);
  if (!el) return;
  el.textContent = message;
  el.className   = `status-item ${state}`;
}

function setButtonsEnabled(enabled) {
  ['btn-compile', 'btn-run', 'btn-compile-run'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !enabled;
  });
}

/** Update the filename shown in the status bar and sidebar. */
function setFileName(name) {
  _fileName = name;
  const statusFile = document.getElementById('status-file');
  if (statusFile) statusFile.textContent = name;
  if (_workspace) {
    highlightWorkspaceFile(name);
  } else {
    updateSidebar(name);
  }
}

/** Mark the current file as dirty (has unsaved changes). */
export function markDirty(isDirty) {
  if (_loadingFile && isDirty) return; // suppress during programmatic loads
  if (_activeTabPath !== null && _openTabs.has(_activeTabPath)) {
    _openTabs.get(_activeTabPath).dirty = isDirty;
  }
  renderTabBar();
}

/** Infer Monaco language identifier from a file path. */
function inferLanguage(path) {
  const lower = path.toLowerCase();
  if (/\.(cpp|cc|cxx|c\+\+)$/.test(lower)) return 'cpp';
  if (/\.c$/.test(lower)) return 'c';
  if (/\.(h|hpp|hxx)$/.test(lower)) return 'cpp';
  if (/\.md$/.test(lower)) return 'markdown';
  if (/\.json$/.test(lower)) return 'json';
  if (/\.js$/.test(lower)) return 'javascript';
  if (/\.ts$/.test(lower)) return 'typescript';
  if (/\.(html|htm)$/.test(lower)) return 'html';
  if (/\.css$/.test(lower)) return 'css';
  if (/\.py$/.test(lower)) return 'python';
  return 'plaintext';
}

/** Returns true if any open tab has unsaved changes. */
function hasUnsavedChanges() {
  for (const tab of _openTabs.values()) {
    if (tab.dirty) return true;
  }
  return false;
}

/** Re-render the entire tab bar from _openTabs. */
function renderTabBar() {
  const tabBar = document.getElementById('tab-bar');
  if (!tabBar) return;
  tabBar.innerHTML = '';
  for (const [path, tab] of _openTabs.entries()) {
    const active = path === _activeTabPath;
    const div = document.createElement('div');
    div.className = `tab${active ? ' active' : ''}${tab.dirty ? ' dirty' : ''}`;
    div.setAttribute('role', 'tab');
    div.setAttribute('aria-selected', String(active));
    div.setAttribute('title', path);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tab-name';
    nameSpan.textContent = workspaceBaseName(path) || path;
    div.appendChild(nameSpan);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.title = `Close ${workspaceBaseName(path) || path}`;
    closeBtn.setAttribute('aria-label', `Close ${workspaceBaseName(path) || path}`);
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(path);
    });
    div.appendChild(closeBtn);

    div.addEventListener('click', () => switchToTab(path));
    tabBar.appendChild(div);
  }
}

/** Switch the editor to the tab for the given path. */
function switchToTab(path) {
  if (!_openTabs.has(path)) return;

  // Snapshot the current editor content before leaving the active tab
  if (_activeTabPath !== null && _openTabs.has(_activeTabPath)) {
    _openTabs.get(_activeTabPath).content = _editorAPI.getValue();
  }

  _activeTabPath = path;
  const tab = _openTabs.get(path);

  _loadingFile = true;
  _editorAPI.setValue(tab.content);
  _editorAPI.clearDiagnostics();
  _editorAPI.setLanguage(inferLanguage(path));
  _loadingFile = false;

  _fileName = workspaceBaseName(path) || path;
  const statusFile = document.getElementById('status-file');
  if (statusFile) statusFile.textContent = _fileName;

  if (_workspace) {
    highlightWorkspaceFile(path);
  } else {
    updateSidebar(_fileName);
  }

  renderTabBar();
  schedulePersist(); // debounced – tracks active tab changes
}

/**
 * Open a file as a new tab (or switch to its existing tab).
 * @param {string} path  – workspace-relative path used as tab key
 * @param {string} content
 */
function openTabForFile(path, content) {
  const isNew = !_openTabs.has(path);
  if (isNew) {
    _openTabs.set(path, { content, dirty: false });
  }
  switchToTab(path);
}

/** Close the tab for the given path, prompting if it has unsaved changes. */
function closeTab(path) {
  if (!_openTabs.has(path)) return;
  const tab = _openTabs.get(path);
  const name = workspaceBaseName(path) || path;
  let switchedTabs = false;

  if (tab.dirty && !confirm(`Close "${name}" with unsaved changes?`)) return;

  const paths = [..._openTabs.keys()];
  const idx = paths.indexOf(path);
  _openTabs.delete(path);

  if (_activeTabPath === path) {
    const remaining = [..._openTabs.keys()];
    if (remaining.length > 0) {
      _activeTabPath = null; // reset before switchToTab to avoid snapshot of deleted tab
      switchToTab(remaining[Math.min(idx, remaining.length - 1)]);
      switchedTabs = true;
    } else {
      _activeTabPath = null;
      _fileName = '';
      _loadingFile = true;
      _editorAPI.setValue('');
      _editorAPI.clearDiagnostics();
      _loadingFile = false;
      const statusFile = document.getElementById('status-file');
      if (statusFile) statusFile.textContent = '';
      renderTabBar();
    }
  } else {
    renderTabBar();
  }
  if (!switchedTabs) {
    _persistSession?.(); // switching tabs already schedules a debounced persist
  }
}

/** Close all open tabs without prompting. */
function closeAllTabs() {
  _openTabs.clear();
  _activeTabPath = null;
  renderTabBar();
}

function updateSidebar(name) {
  const tree = document.getElementById('file-tree');
  if (!tree) return;
  tree.innerHTML = '';
  const li = document.createElement('li');
  li.className = 'active';
  li.setAttribute('role', 'treeitem');
  li.textContent = `📄 ${name}`;
  tree.appendChild(li);
}

function renderWorkspaceSidebar(workspace) {
  const tree = document.getElementById('file-tree');
  if (!tree) return;
  tree.innerHTML = '';

  const childrenByParent = buildWorkspaceChildrenMap(workspace.entries);
  renderWorkspaceChildren(tree, childrenByParent, '', 0);
  highlightWorkspaceFile(_fileName);
}

function buildWorkspaceChildrenMap(entries) {
  const childrenByParent = new Map();
  childrenByParent.set('', []);

  for (const entry of entries) {
    const parent = parentWorkspacePath(entry.path);
    if (!childrenByParent.has(parent)) {
      childrenByParent.set(parent, []);
    }
    childrenByParent.get(parent).push(entry);
  }

  for (const list of childrenByParent.values()) {
    list.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      const aBaseName = workspaceBaseName(a.path);
      const bBaseName = workspaceBaseName(b.path);
      return aBaseName.localeCompare(bBaseName);
    });
  }
  return childrenByParent;
}

function renderWorkspaceChildren(tree, childrenByParent, parentPath, depth) {
  const children = childrenByParent.get(parentPath) || [];
  for (const entry of children) {
    const li = document.createElement('li');
    li.setAttribute('role', 'treeitem');
    li.setAttribute('aria-level', String(depth + 1));
    li.dataset.path = entry.path;
    li.style.paddingLeft = `${16 + depth * 14}px`;

    if (entry.kind === 'directory') {
      const isExpanded = _expandedWorkspaceDirectories.has(entry.path);
      li.setAttribute('aria-expanded', String(isExpanded));
      li.textContent = `${isExpanded ? '📂' : '📁'} ${workspaceBaseName(entry.path)}`;
      li.addEventListener('click', (event) => {
        event.stopPropagation();
        if (_expandedWorkspaceDirectories.has(entry.path)) {
          _expandedWorkspaceDirectories.delete(entry.path);
        } else {
          _expandedWorkspaceDirectories.add(entry.path);
        }
        renderWorkspaceSidebar(_workspace);
      });
      tree.appendChild(li);

      if (isExpanded) {
        renderWorkspaceChildren(tree, childrenByParent, entry.path, depth + 1);
      }
      continue;
    }

    li.textContent = `📄 ${workspaceBaseName(entry.path)}`;
    li.addEventListener('click', (event) => {
      event.stopPropagation();
      void openWorkspaceFile(entry.path);
    });
    tree.appendChild(li);
  }
}

function highlightWorkspaceFile(path) {
  const tree = document.getElementById('file-tree');
  if (!tree) return;
  const items = tree.querySelectorAll('li');
  let active = null;
  items.forEach((li) => {
    li.classList.remove('active');
    if (li.dataset.path === path) active = li;
  });
  if (active) active.classList.add('active');
}

async function openWorkspaceInitialFile(workspace) {
  const file = pickInitialWorkspaceFile(workspace.entries);
  if (!file) {
    // No README.md at root – clear editor but open no tab automatically
    _loadingFile = true;
    _editorAPI.setValue('');
    _editorAPI.clearDiagnostics();
    _loadingFile = false;
    return;
  }
  await openWorkspaceFile(file.path);
}

async function openWorkspaceFile(path) {
  if (_openTabs.has(path)) {
    switchToTab(path);
    return;
  }
  let content = null;
  try {
    content = await _fsAPI.readWorkspaceFile(path);
  } catch {
    content = null;
  }
  if (content === null && _workspace && !_fsAPI.getDirectoryHandle?.()) {
    let reconnectedWorkspace;
    try {
      reconnectedWorkspace = await _fsAPI.openFolder();
    } catch (err) {
      showOpenError(err);
      return;
    }
    if (!reconnectedWorkspace) return;
    setWorkspaceMode(reconnectedWorkspace);
    renderWorkspaceSidebar(reconnectedWorkspace);
    _persistSession?.();
    try {
      content = await _fsAPI.readWorkspaceFile(path);
    } catch {
      content = null;
    }
  }
  if (content == null) return;
  openTabForFile(path, content);
}

function pickInitialWorkspaceFile(entries) {
  // Only auto-open README.md if it exists at the workspace root
  return entries.find(
    (entry) => entry.kind === 'file' && entry.path.toLowerCase() === 'readme.md'
  ) || null;
}

function showOpenError(err) {
  const kind = _workspace ? 'folder' : 'file';
  alert(`Could not open ${kind}:\n${err.message}`);
}

function setWorkspaceMode(workspace) {
  _workspace = workspace;
  _expandedWorkspaceDirectories.clear();
  _terminalAPI.setWorkspace?.(workspace);
}

function clearWorkspaceMode() {
  _workspace = null;
  _expandedWorkspaceDirectories.clear();
  _terminalAPI.setWorkspace?.(null);
}

function parentWorkspacePath(path) {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function workspaceBaseName(path) {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

async function openFolderWorkspace() {
  const workspace = await _fsAPI.openFolder();
  if (!workspace) return false;
  closeAllTabs();
  setWorkspaceMode(workspace);
  await openWorkspaceInitialFile(workspace);
  renderWorkspaceSidebar(workspace);
  _persistSession?.(); // persist immediately so the new workspace survives unload
  return true;
}

async function actionOpen() {
  if (hasUnsavedChanges() && !confirm('Discard unsaved changes?')) return;
  try {
    await openFolderWorkspace();
  } catch (err) {
    showOpenError(err);
  }
}

// ── Session persistence helpers ───────────────────────────────────────────────

/** Return the workspace-relative paths of all currently open tabs. */
export function getOpenTabPaths() {
  return [..._openTabs.keys()];
}

/** Return the path of the currently active tab, or null. */
export function getActiveTabPath() {
  return _activeTabPath;
}

/** Return current tab contents keyed by workspace path. */
export function getOpenTabsSnapshot() {
  const snapshot = {};
  for (const [path, tab] of _openTabs.entries()) {
    snapshot[path] = tab.content;
  }
  return snapshot;
}

/**
 * Restore a previously persisted workspace and its open tabs.
 * Called from app.js after the directory handle has been re-authenticated.
 *
 * @param {object} workspace – value returned by openFolderFromHandle / openFolder
 * @param {string[]} openPaths – ordered list of tab paths to restore
 * @param {string|null} activePath – which tab should be active
 * @param {Object<string,string>|null} [tabContentByPath] – fallback tab contents
 */
export async function restoreWorkspace(workspace, openPaths, activePath, tabContentByPath = null) {
  closeAllTabs();
  setWorkspaceMode(workspace);
  renderWorkspaceSidebar(workspace);

  for (const path of openPaths) {
    let content = await _fsAPI.readWorkspaceFile(path);
    if (content == null && tabContentByPath && typeof tabContentByPath[path] === 'string') {
      content = tabContentByPath[path];
    }
    if (content == null) continue;
    _openTabs.set(path, { content, dirty: false });
  }

  const target = activePath && _openTabs.has(activePath)
    ? activePath
    : [..._openTabs.keys()][0] ?? null;

  if (target) {
    switchToTab(target);
  } else {
    // No tabs to restore – clear the editor so no stale content is shown
    _loadingFile = true;
    _editorAPI.setValue('');
    _editorAPI.clearDiagnostics();
    _loadingFile = false;
    renderTabBar();
  }
}
