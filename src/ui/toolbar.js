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
let _dirty       = false;
let _fileName    = 'main.cpp';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialise the toolbar, hooking up all buttons and keyboard shortcuts.
 *
 * @param {Worker}  worker       – compiler.worker instance
 * @param {object}  editorAPI    – module exports from editor.js
 * @param {object}  terminalAPI  – module exports from terminal.js
 * @param {object}  fsAPI        – module exports from filesystem.js
 */
export function initToolbar(worker, editorAPI, terminalAPI, fsAPI) {
  _worker      = worker;
  _editorAPI   = editorAPI;
  _terminalAPI = terminalAPI;
  _fsAPI       = fsAPI;

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
      // Ctrl+K in the terminal panel
      _terminalAPI.clearTerminal();
    }
  });
}

// ── Worker message handler ────────────────────────────────────────────────────

function handleWorkerMessages() {
  _worker.onmessage = ({ data }) => {
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
        break;

      default:
        break;
    }
  };
}

// ── Actions ───────────────────────────────────────────────────────────────────

function actionNew() {
  if (_dirty && !confirm('Discard unsaved changes?')) return;
  _fsAPI.newFile();
  _editorAPI.setValue(_editorAPI.DEFAULT_SOURCE ?? '');
  _editorAPI.clearDiagnostics();
  setFileName('main.cpp');
  markDirty(false);
}

async function actionOpen() {
  if (_dirty && !confirm('Discard unsaved changes?')) return;
  try {
    const result = await _fsAPI.openFile();
    if (!result) return;
    _editorAPI.setValue(result.content);
    _editorAPI.clearDiagnostics();
    setFileName(result.name);
    markDirty(false);
  } catch (err) {
    alert(`Could not open file:\n${err.message}`);
  }
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

function actionCompile() {
  const source = _editorAPI.getValue();
  const std    = document.getElementById('cpp-standard')?.value || 'c++20';
  _worker.postMessage({ type: 'compile', source, flags: [], std });
}

function actionRun() {
  _worker.postMessage({ type: 'run', stdin: '' });
}

function actionCompileRun() {
  const source = _editorAPI.getValue();
  const std    = document.getElementById('cpp-standard')?.value || 'c++20';

  // Chain: compile → on success, immediately run
  const originalOnMessage = _worker.onmessage;
  const oneShot = ({ data }) => {
    if (data.type === 'compile-result') {
      _worker.onmessage = originalOnMessage;
      originalOnMessage({ data }); // let normal handler render diagnostics
      if (data.success) {
        _worker.postMessage({ type: 'run', stdin: '' });
      }
    } else {
      originalOnMessage({ data });
    }
  };
  _worker.onmessage = oneShot;
  _worker.postMessage({ type: 'compile', source, flags: [], std });
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

/** Update the filename shown in the tab and status bar. */
function setFileName(name) {
  _fileName = name;
  const statusFile = document.getElementById('status-file');
  if (statusFile) statusFile.textContent = name;
  // Update the single tab
  updateTab(name, _dirty);
  // Sidebar entry
  updateSidebar(name);
}

/** Mark the current file as dirty (has unsaved changes). */
export function markDirty(isDirty) {
  _dirty = isDirty;
  updateTab(_fileName, isDirty);
}

function updateTab(name, dirty) {
  const tabBar = document.getElementById('tab-bar');
  if (!tabBar) return;
  let tab = tabBar.querySelector('.tab');
  if (!tab) {
    tab = document.createElement('div');
    tab.className = 'tab active';
    tab.innerHTML = `<span class="tab-name"></span>`;
    tabBar.appendChild(tab);
  }
  tab.querySelector('.tab-name').textContent = name;
  tab.classList.toggle('dirty', dirty);
}

function updateSidebar(name) {
  const tree = document.getElementById('file-tree');
  if (!tree) return;
  let li = tree.querySelector('li');
  if (!li) {
    li = document.createElement('li');
    li.className = 'active';
    li.setAttribute('role', 'treeitem');
    tree.appendChild(li);
  }
  li.textContent = `📄 ${name}`;
}
