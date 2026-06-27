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

import {
  buildCompileOverlay,
  selectWorkspaceSources,
  normalizeOverlayPath,
} from './build-request.mjs';
import { parseDiagnostics, diagnosticsForPath } from './diagnostics.mjs';
import { directoriesForPath } from './workspace-fs.mjs';

// ── State ─────────────────────────────────────────────────────────────────────
let _worker      = null;
let _editorAPI   = null;
let _terminalAPI = null;
let _fsAPI       = null;
let _fileName    = 'main.cpp';
let _workspace   = null;
let _runAfterSuccessfulCompile = false;
let _lastRunBinaryBytes = null;
const _expandedWorkspaceDirectories = new Set();
const WORKSPACE_SYNC_INTERVAL_MS = 2_000;
let _workspaceSyncTimer = null;
let _workspaceSyncRunning = false;
let _workspaceSyncQueued = false;
let _workspaceSyncEventsBound = false;

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
  _worker      = null;
  _editorAPI   = editorAPI;
  _terminalAPI = terminalAPI;
  _fsAPI       = fsAPI;
  _persistSession = persistSession ?? null;

  bindButtons();
  bindKeyboardShortcuts();
  bindWorkspaceSyncEvents();
  setWorker(worker);
}

export function setWorker(worker) {
  if (_worker && _worker !== worker) {
    _worker.onmessage = null;
  }
  _worker = worker;
  _runAfterSuccessfulCompile = false;
  handleWorkerMessages();
  updateStatusBar('compiler', 'loading', 'Compiler loading…');
  setButtonsEnabled(false);
}

export function getLastRunBinaryBytes() {
  return _lastRunBinaryBytes ? new Uint8Array(_lastRunBinaryBytes) : null;
}

// ── Button bindings ───────────────────────────────────────────────────────────

function bindButtons() {
  on('btn-new',          () => actionNewFile());
  on('btn-open',         () => actionOpen());
  on('btn-save',         () => actionSave());
  on('btn-save-as',      () => actionSaveAs());
  on('btn-compile',      () => actionCompile());
  on('btn-run',          () => actionRun());
  on('btn-compile-run',  () => actionCompileRun());
  on('btn-stop-run',     () => _terminalAPI.stopRun?.());
  on('btn-clear-terminal', () => _terminalAPI.clearTerminal());
  on('btn-toggle-terminal',() => toggleTerminalPanel());
  updateShortcutTitles();
}

function on(id, handler) {
  document.getElementById(id)?.addEventListener('click', handler);
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

function bindKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
    const isMac = isMacPlatform();
    const primaryModifier = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey;

    if (e.key === 'F5') {
      e.preventDefault();
      actionCompileRun();
    } else if (e.ctrlKey && e.shiftKey && e.key === 'B') {
      e.preventDefault();
      actionCompile();
    } else if (e.ctrlKey && e.shiftKey && e.key === 'R') {
      e.preventDefault();
      actionRun();
    } else if (primaryModifier && !e.shiftKey && key === 's') {
      e.preventDefault();
      actionSave();
    } else if (primaryModifier && key === 'o') {
      e.preventDefault();
      actionOpen();
    } else if (e.ctrlKey && e.key === 'n') {
      e.preventDefault();
      actionNewFile();
    } else if (e.ctrlKey && e.key === 'k') {
      // Ctrl+K clears the terminal regardless of which element has focus
      _terminalAPI.clearTerminal();
    }
  });
}

// ── Worker message handler ────────────────────────────────────────────────────

function handleWorkerMessages() {
  if (!_worker) return;
  const boundWorker = _worker;
  boundWorker.onmessage = ({ data }) => {
    if (boundWorker !== _worker) return;
    handleWorkerMessage(data).catch((err) =>
      console.error('[browser.cpp] Worker message handler error:', err)
    );
  };
}

async function handleWorkerMessage(data) {
  switch (data.type) {
    case 'compiler-loading':
      updateStatusBar(
        'compiler', 'loading',
        `Loading compiler… ${data.progress}%`
      );
      setButtonsEnabled(false);
      break;

    case 'compiler-ready':
      updateStatusBar('compiler', 'ready', 'Compiler ready');
      setButtonsEnabled(true);
      _terminalAPI.printInfo('Clang WASM compiler loaded. Ready to compile C++20.');
      break;

    case 'compiler-error':
      updateStatusBar('compiler', 'error', 'Compiler unavailable');
      setButtonsEnabled(false);
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
      const shouldRunAfterCompile = _runAfterSuccessfulCompile;
      _runAfterSuccessfulCompile = false;
      setButtonsEnabled(true);
      updateStatusBar('compiler', 'ready', 'Compiler ready');

      // Render inline editor markers, scoped to the active file. The terminal
      // still prints the full multi-file compiler/linker output via onCompileResult.
      if (data.diagnostics) {
        const items = parseDiagnostics(data.diagnostics);
        const scoped = diagnosticsForPath(items, data.primarySourcePath || _activeTabPath);
        if (scoped.length) _editorAPI.markDiagnostics(scoped);
      }

      if (data.success) {
        _lastRunBinaryBytes = data.outputBytes ? new Uint8Array(data.outputBytes) : null;
      }

      _terminalAPI.onCompileResult(data);

      // When a folder is open, materialise the built artifact (a.out or a custom
      // -o target) into the workspace so it appears in the Explorer immediately.
      // Failed builds carry no bytes, so no phantom artifact is ever created.
      if (data.success && data.outputBytes && _workspace) {
        await persistWorkspaceFile(data.outputPath || 'a.out', data.outputBytes);
      }
      if (shouldRunAfterCompile && data.success) {
        _terminalAPI.startRun();
      }
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

    case 'run-result': {
      setButtonsEnabled(true);
      updateStatusBar('compiler', 'ready', 'Compiler ready');
      _terminalAPI.onRunResult(data);
      // Write files created/modified by the program back to the workspace and
      // refresh the Explorer/terminal so runtime fstream output is visible.
      let snapshot = null;
      const changedPaths = [];
      if (data.vfsChanges?.length && _workspace && _fsAPI?.writeWorkspaceFile) {
        for (const change of data.vfsChanges) {
          try {
            const result = await _fsAPI.writeWorkspaceFile(change.path, change.bytes);
            if (result) snapshot = result;
            changedPaths.push(normalizeOverlayPath(change.path));
          } catch (err) {
            console.warn('[browser.cpp] Failed to write file to workspace:', change.path, err);
          }
        }
        if (snapshot) {
          applyWorkspaceSnapshot(snapshot, changedPaths);
          await reloadOverwrittenTabs(changedPaths);
        }
      }
      if (data.vfsDeletes?.length && _workspace && _fsAPI?.deleteWorkspaceFile) {
        for (const path of data.vfsDeletes) {
          try {
            const result = await _fsAPI.deleteWorkspaceFile(path);
            if (result) snapshot = result;
          } catch (err) {
            console.warn('[browser.cpp] Failed to delete workspace file:', path, err);
          }
        }
        if (snapshot) applyWorkspaceSnapshot(snapshot);
      }
      await syncWorkspaceFromDisk('run-result');
      break;
    }

    default:
      break;
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

/**
 * Explorer **New file** action.
 *
 * Folder-first: managed workspace file creation requires an opened folder, so
 * with no workspace we open the folder picker first and only proceed once a
 * workspace exists (cancelling leaves the current UI/editor state untouched).
 * With a workspace open we show an inline VS Code-style naming row in the
 * Explorer rather than resetting the editor.
 */
async function actionNewFile() {
  if (!_workspace) {
    let opened = false;
    try {
      opened = await openFolderWorkspace();
    } catch (err) {
      showOpenError(err);
      return;
    }
    if (!opened) return; // user cancelled the folder picker → unchanged
  }
  beginInlineFileCreation();
}

// ── Inline Explorer file creation ─────────────────────────────────────────────

let _inlineCreationActive = false;

/** Render the inline naming input at the top of the Explorer tree. */
function beginInlineFileCreation() {
  if (_inlineCreationActive) return;
  const tree = document.getElementById('file-tree');
  if (!tree) return;
  _inlineCreationActive = true;

  const li = document.createElement('li');
  li.className = 'file-tree-new';
  li.id = 'file-tree-new-row';
  li.setAttribute('role', 'treeitem');

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'file-tree-new-input';
  input.setAttribute('aria-label', 'New file name');
  input.placeholder = 'name.cpp or dir/name.cpp';

  const error = document.createElement('span');
  error.className = 'file-tree-new-error';
  error.id = 'file-tree-new-error';

  let finishing = false;
  const cancel = () => {
    if (finishing) return;
    finishing = true;
    endInlineFileCreation();
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finishing = true;
      void submitInlineFileCreation(input.value, error, () => {
        finishing = false; // creation rejected – keep the row open for retry
      });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  });
  input.addEventListener('blur', () => cancel());

  li.appendChild(input);
  li.appendChild(error);
  tree.insertBefore(li, tree.firstChild);
  input.focus();
}

/** Remove the inline naming row and reset creation state. */
function endInlineFileCreation() {
  _inlineCreationActive = false;
  const row = document.getElementById('file-tree-new-row');
  row?.parentNode?.removeChild(row);
}

/**
 * Validate + create the file named in the inline input. On success the file is
 * created in the workspace, the Explorer/terminal refresh, and the file opens as
 * the active tab. On failure the inline row stays open with an error message.
 *
 * @param {string} rawName
 * @param {HTMLElement} errorEl – inline error message element
 * @param {Function} onReject – invoked to keep the row open for another attempt
 */
async function submitInlineFileCreation(rawName, errorEl, onReject) {
  let result;
  try {
    result = await _fsAPI.createWorkspaceFile(rawName, '');
  } catch (err) {
    if (errorEl) errorEl.textContent = err.message;
    onReject();
    return;
  }

  if (!result.ok) {
    if (errorEl) errorEl.textContent = inlineCreateErrorMessage(result.error);
    onReject();
    return;
  }

  endInlineFileCreation();
  applyWorkspaceSnapshot(result.snapshot, [result.path]);
  openTabForFile(result.path, '');
  markDirty(false);
  highlightWorkspaceFile(result.path);
  _persistSession?.();
  void syncWorkspaceFromDisk('create-file');
}

function inlineCreateErrorMessage(error) {
  switch (error) {
    case 'empty':       return 'Enter a file name.';
    case 'absolute':    return 'Use a path relative to the workspace.';
    case 'traversal':   return '".." is not allowed in the path.';
    case 'no-filename': return 'Enter a file name, not a folder.';
    case 'exists':      return 'A file or folder with that path already exists.';
    case 'no-workspace':return 'Open a folder first.';
    default:            return 'Could not create file.';
  }
}

/**
 * Adopt a refreshed workspace snapshot after an incremental mutation: update the
 * in-memory workspace, refresh the terminal index (preserving cwd), expand the
 * ancestor directories of any newly created paths so they are visible, and
 * re-render the Explorer.
 *
 * @param {object} snapshot – workspace snapshot from filesystem.js
 * @param {string[]} [revealPaths] – paths whose ancestor dirs should be expanded
 */
function applyWorkspaceSnapshot(snapshot, revealPaths = []) {
  if (!snapshot) return;
  _workspace = snapshot;
  _terminalAPI.refreshWorkspace?.(snapshot);
  pruneExpandedWorkspaceDirectories(snapshot);
  for (const path of revealPaths) {
    for (const dir of directoriesForPath(path)) {
      _expandedWorkspaceDirectories.add(dir);
    }
  }
  renderWorkspaceSidebar(snapshot);
}

function pruneExpandedWorkspaceDirectories(snapshot) {
  const existingDirs = new Set(
    (snapshot.entries || [])
      .filter((entry) => entry.kind === 'directory')
      .map((entry) => entry.path)
  );
  for (const dir of _expandedWorkspaceDirectories) {
    if (!existingDirs.has(dir)) _expandedWorkspaceDirectories.delete(dir);
  }
}

async function syncWorkspaceFromDisk(reason) {
  if (!_workspace || typeof _fsAPI?.refreshWorkspace !== 'function') return null;
  if (_workspaceSyncRunning) {
    _workspaceSyncQueued = true;
    return null;
  }

  _workspaceSyncRunning = true;
  try {
    const result = await _fsAPI.refreshWorkspace({ reason });
    if (!result?.snapshot) return null;
    if (!hasWorkspaceDiff(result)) return result;

    const revealPaths = (result.added || []).map((entry) => normalizeOverlayPath(entry.path));
    applyWorkspaceSnapshot(result.snapshot, revealPaths);

    const changedPaths = (result.changed || []).map((entry) => normalizeOverlayPath(entry.path));
    if (changedPaths.length) {
      await reloadOverwrittenTabs(changedPaths);
    }

    _persistSession?.();
    return result;
  } catch (err) {
    console.warn('[browser.cpp] Failed to refresh workspace from disk:', err);
    return null;
  } finally {
    _workspaceSyncRunning = false;
    if (_workspaceSyncQueued) {
      _workspaceSyncQueued = false;
      void syncWorkspaceFromDisk('queued');
    }
  }
}

function hasWorkspaceDiff(result) {
  return Boolean(
    result.added?.length ||
    result.removed?.length ||
    result.changed?.length
  );
}

/**
 * Persist a file produced outside the Explorer (a compile artifact) into the
 * workspace and refresh the Explorer/terminal so it appears immediately.
 */
async function persistWorkspaceFile(path, bytes) {
  try {
    const snapshot = await _fsAPI.writeWorkspaceFile(path, bytes);
    if (snapshot) applyWorkspaceSnapshot(snapshot, [normalizeOverlayPath(path)]);
    await syncWorkspaceFromDisk('compile-result');
  } catch (err) {
    console.warn('[browser.cpp] Failed to persist workspace file:', path, err);
  }
}

/**
 * Reload the on-disk content of any open, non-dirty tabs that the running
 * program overwrote, so the editor never shows stale content.
 */
async function reloadOverwrittenTabs(changedPaths) {
  for (const path of changedPaths) {
    const tab = _openTabs.get(path);
    if (!tab || tab.dirty) continue;
    let content;
    try {
      content = await _fsAPI.readWorkspaceFile(path);
    } catch {
      content = null;
    }
    if (content == null) continue;
    tab.content = content;
    if (path === _activeTabPath) {
      _loadingFile = true;
      _editorAPI.setValue(content);
      _loadingFile = false;
    }
  }
}

/**
 * Load the default new-project state (no workspace, a single `main.cpp` tab with
 * `editorAPI.DEFAULT_SOURCE`). Unlike {@link actionNew} this skips the
 * unsaved-changes confirmation so it can drive the relaunch "Start new project"
 * path, where the prior session is being intentionally abandoned.
 */
export function resetToNewProject() {
  closeAllTabs();
  _fsAPI.newFile();
  clearWorkspaceMode();
  const defaultContent = _editorAPI.DEFAULT_SOURCE ?? '';
  openTabForFile('main.cpp', defaultContent);
}

async function actionSave() {
  try {
    if (_workspace && _activeTabPath && _fsAPI?.writeWorkspaceFile) {
      if (_openTabs.has(_activeTabPath)) {
        _openTabs.get(_activeTabPath).content = _editorAPI.getValue();
      }
      const snapshot = await _fsAPI.writeWorkspaceFile(_activeTabPath, _editorAPI.getValue());
      if (!snapshot) {
        throw new Error('Could not save workspace file.');
      }
      markDirty(false);
      _persistSession?.();
      return;
    }

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
  if (!_worker) return;
  _runAfterSuccessfulCompile = false;
  const payload = await assembleCompilePayload({});
  _worker.postMessage({ type: 'compile', ...payload });
}

function actionRun() {
  _terminalAPI.startRun();
}

async function actionCompileRun() {
  if (!_worker) return;
  _runAfterSuccessfulCompile = true;
  const payload = await assembleCompilePayload({});
  _worker.postMessage({ type: 'compile', ...payload });
}

/**
 * Assemble a worker compile request from the live UI state.
 *
 * Why: builds must reflect the exact in-memory project the user sees. We snapshot
 * the active editor buffer into its tab, layer all dirty tab content over the
 * on-disk workspace files, and choose the build target set:
 *   - explicit `sourcePaths` (terminal `g++ a.cpp b.cpp`)
 *   - otherwise every recursive `.cpp`/`.cxx` workspace file (toolbar project build)
 *   - otherwise, with no folder open, the single editor buffer (legacy behaviour)
 *
 * @param {{ sourcePaths?:string[], std?:string, flags?:string[], outputName?:(string|null) }} opts
 * @returns {Promise<object>} worker `compile` message payload
 */
export async function assembleCompilePayload({ sourcePaths = null, std, flags = [], outputName = null }) {
  // Snapshot the active editor buffer so unsaved edits to the focused tab build.
  if (_activeTabPath !== null && _openTabs.has(_activeTabPath)) {
    _openTabs.get(_activeTabPath).content = _editorAPI.getValue();
  }

  const resolvedStd = std || document.getElementById('cpp-standard')?.value || 'c++20';
  const primarySourcePath = _activeTabPath || 'input.cpp';

  // No folder open → preserve single-buffer compile for new unsaved files.
  if (!_workspace) {
    const buffer = _editorAPI.getValue();
    const path = normalizeOverlayPath(primarySourcePath) || 'input.cpp';
    return {
      sourcePaths: [path],
      files: [{ path, content: buffer }],
      std: resolvedStd,
      flags,
      outputName,
      primarySourcePath: path,
    };
  }

  const diskFiles = await _fsAPI.readAllWorkspaceFiles();
  const dirtyContentByPath = {};
  for (const [path, tab] of _openTabs.entries()) {
    dirtyContentByPath[path] = tab.content;
  }
  const files = buildCompileOverlay(diskFiles, dirtyContentByPath);

  const targets = (sourcePaths && sourcePaths.length)
    ? sourcePaths.map(normalizeOverlayPath)
    : selectWorkspaceSources(_workspace.entries);

  return {
    sourcePaths: targets,
    files,
    std: resolvedStd,
    flags,
    outputName,
    primarySourcePath: normalizeOverlayPath(primarySourcePath),
  };
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
  ['btn-compile', 'btn-compile-run'].forEach((id) => {
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
  startWorkspaceSyncPolling();
}

function clearWorkspaceMode() {
  _workspace = null;
  _expandedWorkspaceDirectories.clear();
  _terminalAPI.setWorkspace?.(null);
  stopWorkspaceSyncPolling();
}

function bindWorkspaceSyncEvents() {
  if (_workspaceSyncEventsBound) return;
  _workspaceSyncEventsBound = true;

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', () => {
      startWorkspaceSyncPolling();
      void syncWorkspaceFromDisk('focus');
    });
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (isDocumentVisible()) {
        startWorkspaceSyncPolling();
        void syncWorkspaceFromDisk('visibility');
      } else {
        stopWorkspaceSyncPolling();
      }
    });
  }
}

function startWorkspaceSyncPolling() {
  if (!_workspace || _workspaceSyncTimer || !isDocumentVisible()) return;
  if (typeof window === 'undefined' || typeof window.setInterval !== 'function') return;
  _workspaceSyncTimer = window.setInterval(() => {
    if (isDocumentVisible()) void syncWorkspaceFromDisk('poll');
  }, WORKSPACE_SYNC_INTERVAL_MS);
}

function stopWorkspaceSyncPolling() {
  if (!_workspaceSyncTimer) return;
  if (typeof window !== 'undefined' && typeof window.clearInterval === 'function') {
    window.clearInterval(_workspaceSyncTimer);
  }
  _workspaceSyncTimer = null;
}

function isDocumentVisible() {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function parentWorkspacePath(path) {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function workspaceBaseName(path) {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

function updateShortcutTitles() {
  setButtonTitle('btn-open', `Open folder (${platformShortcutLabel('O')})`);
  setButtonTitle('btn-save', `Save file (${platformShortcutLabel('S')})`);
}

function setButtonTitle(id, title) {
  const button = document.getElementById(id);
  if (button) button.title = title;
}

function platformShortcutLabel(key) {
  return `${isMacPlatform() ? 'Cmd' : 'Ctrl'}+${key}`;
}

function isMacPlatform() {
  const platform =
    globalThis.navigator?.userAgentData?.platform ??
    globalThis.navigator?.platform ??
    '';
  return /mac/i.test(platform);
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
