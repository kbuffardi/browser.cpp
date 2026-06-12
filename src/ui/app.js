/**
 * src/ui/app.js  –  Main entry point for the browser.cpp IDE
 *
 * Boot order:
 *  1. Import styles (injected by webpack / MiniCssExtractPlugin)
 *  2. Create Monaco editor
 *  3. Create xterm.js terminal
 *  4. Spawn compiler Web Worker
 *  5. Wire up toolbar / keyboard shortcuts
 *  6. Restore the last session from chrome.storage.local (if available)
 */

'use strict';

import './styles.css';

import * as editorAPI   from './editor.js';
import * as terminalAPI from './terminal.js';
import * as fsAPI       from './filesystem.js';
import { initToolbar, markDirty, getOpenTabPaths, getActiveTabPath, restoreWorkspace } from './toolbar.js';

// ── Boot ──────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  // 1. Monaco editor
  const editorContainer = document.getElementById('editor-container');
  editorAPI.createEditor(editorContainer);

  // 2. Compiler web worker
  //    The worker starts loading the Clang WASM binary immediately.
  const worker = new Worker(
    new URL('../workers/compiler.worker.js', import.meta.url),
    { type: 'classic' }
  );

  // 3. Terminal
  //    Pass callbacks so the terminal's `g++` command dispatches to the worker.
  const terminalContainer = document.getElementById('terminal-container');
  terminalAPI.createTerminal(terminalContainer, {
    onCompile: (source, flags, std) =>
      worker.postMessage({ type: 'compile', source, flags, std }),
    onRun: async (sab) => {
      const vfsFiles = await fsAPI.readAllWorkspaceFiles();
      worker.postMessage({ type: 'run', sharedBuffer: sab, vfsFiles });
    },
    getSource: () => editorAPI.getValue(),
    readWorkspaceFile: (path) => fsAPI.readWorkspaceFile(path),
  });

  // 4. Toolbar (wires buttons + worker messages + keyboard shortcuts)
  initToolbar(worker, editorAPI, terminalAPI, fsAPI);

  // 5. Track unsaved changes
  editorAPI.onDidChangeContent(() => markDirty(true));

  // 6. Cursor position → status bar
  editorAPI.onDidChangeCursorPosition((e) => {
    const pos = e.position;
    const el  = document.getElementById('status-cursor');
    if (el) el.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`;
  });

  // 7. Restore last session from chrome.storage if available
  await restoreSession();

  // 8. Resize terminal when the window or terminal panel is resized
  const resizeObserver = new ResizeObserver(() => terminalAPI.fitTerminal());
  const terminalPanel  = document.getElementById('terminal-container');
  if (terminalPanel) resizeObserver.observe(terminalPanel);
  initPanelResizers();

  // 9. Persist session on unload
  window.addEventListener('beforeunload', persistSession);

  editorAPI.focus();
});

function initPanelResizers() {
  initTerminalResizer();
  initSidebarResizer();
}

function initTerminalResizer() {
  const panel = document.getElementById('terminal-panel');
  const header = document.getElementById('terminal-panel-header');
  const workspace = document.getElementById('workspace');
  const tabBar = document.getElementById('tab-bar');
  const toggleButton = document.getElementById('btn-toggle-terminal');
  if (!panel || !header || !workspace || !tabBar || !toggleButton) return;

  const minTerminalHeight = 80;
  const minEditorHeight = 80;

  header.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.target.closest('button')) return;

    const startY = event.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    const workspaceHeight = workspace.getBoundingClientRect().height;
    const maxHeight = Math.max(
      minTerminalHeight,
      workspaceHeight - tabBar.offsetHeight - minEditorHeight
    );

    panel.classList.remove('collapsed');
    toggleButton.textContent = '▾';

    const onMouseMove = (moveEvent) => {
      const nextHeight = clamp(startHeight - (moveEvent.clientY - startY), minTerminalHeight, maxHeight);
      panel.style.height = `${nextHeight}px`;
    };

    const onMouseUp = () => {
      document.body.classList.remove('is-resizing');
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    document.body.classList.add('is-resizing');
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp, { once: true });
    event.preventDefault();
  });
}

function initSidebarResizer() {
  const sidebar = document.getElementById('sidebar');
  const main = document.getElementById('main');
  if (!sidebar || !main) return;

  const edgeThreshold = 6;
  const minSidebarWidth = 120;
  const minWorkspaceWidth = 240;

  sidebar.addEventListener('mousemove', (event) => {
    sidebar.style.cursor = isNearRightEdge(event, sidebar, edgeThreshold) ? 'ew-resize' : '';
  });

  sidebar.addEventListener('mouseleave', () => {
    sidebar.style.cursor = '';
  });

  sidebar.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || !isNearRightEdge(event, sidebar, edgeThreshold)) return;

    const startX = event.clientX;
    const startWidth = sidebar.getBoundingClientRect().width;
    const maxWidth = Math.max(minSidebarWidth, main.getBoundingClientRect().width - minWorkspaceWidth);

    const onMouseMove = (moveEvent) => {
      const nextWidth = clamp(startWidth + (moveEvent.clientX - startX), minSidebarWidth, maxWidth);
      sidebar.style.width = `${nextWidth}px`;
    };

    const onMouseUp = () => {
      document.body.classList.remove('is-resizing-horizontal');
      sidebar.style.cursor = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    document.body.classList.add('is-resizing-horizontal');
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp, { once: true });
    event.preventDefault();
  });
}

function isNearRightEdge(event, element, threshold) {
  const rect = element.getBoundingClientRect();
  return rect.right - event.clientX <= threshold;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// ── Session persistence (chrome.storage.local + IndexedDB) ───────────────────

const STORAGE_KEY = 'browser_cpp_session';

// ── IndexedDB helpers for FileSystemDirectoryHandle ──────────────────────────
// FileSystemHandle objects are structured-cloneable and can be stored in IDB.

const _IDB_NAME    = 'browser-cpp-handles';
const _IDB_VERSION = 1;
const _IDB_STORE   = 'handles';
const _IDB_KEY     = 'workspace-dir';

function _openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_IDB_NAME, _IDB_VERSION);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(_IDB_STORE);
    };
    req.onsuccess  = (e) => resolve(e.target.result);
    req.onerror    = ()  => reject(req.error);
  });
}

async function _saveDirectoryHandle(handle) {
  try {
    const db = await _openHandleDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(_IDB_STORE, 'readwrite');
      tx.objectStore(_IDB_STORE).put(handle, _IDB_KEY);
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  } catch (_err) {
    // IDB not available – skip persistence
  }
}

async function _loadDirectoryHandle() {
  try {
    const db = await _openHandleDB();
    return await new Promise((resolve, reject) => {
      const tx  = db.transaction(_IDB_STORE, 'readonly');
      const req = tx.objectStore(_IDB_STORE).get(_IDB_KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => reject(req.error);
    });
  } catch (_) {
    return null;
  }
}

async function _clearDirectoryHandle() {
  try {
    const db = await _openHandleDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(_IDB_STORE, 'readwrite');
      tx.objectStore(_IDB_STORE).delete(_IDB_KEY);
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  } catch (_err) {
    // IDB not available – skip deletion
  }
}

async function restoreSession() {
  try {
    const storage =
      typeof chrome !== 'undefined' && chrome.storage?.local
        ? chrome.storage.local
        : null;

    if (!storage) return;

    const data    = await storage.get(STORAGE_KEY);
    const session = data[STORAGE_KEY];
    if (!session) return;

    // ── Workspace mode: restore folder + open tabs ─────────────────────────
    const handle = await _loadDirectoryHandle();
    if (handle && Array.isArray(session.openTabPaths)) {
      let permission = await handle.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted') {
        // requestPermission requires a user gesture; attempt it anyway — it
        // works on Chrome extension pages that were opened by the user.
        try {
          permission = await handle.requestPermission({ mode: 'readwrite' });
        } catch (_err) {
          // SecurityError if no user gesture is present; proceed without restore
        }
      }
      if (permission === 'granted') {
        const workspace = await fsAPI.openFolderFromHandle(handle);
        if (workspace) {
          await restoreWorkspace(workspace, session.openTabPaths, session.activeTabPath ?? null);
          return;
        }
      }
    }

    // ── Single-file / plain-source fallback ────────────────────────────────
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
    const storage =
      typeof chrome !== 'undefined' && chrome.storage?.local
        ? chrome.storage.local
        : null;

    if (!storage) return;

    const dirHandle = fsAPI.getDirectoryHandle();
    if (dirHandle) {
      // Workspace mode – persist handle + tab list
      await _saveDirectoryHandle(dirHandle);
      await storage.set({
        [STORAGE_KEY]: {
          openTabPaths: getOpenTabPaths(),
          activeTabPath: getActiveTabPath(),
          savedAt: Date.now(),
        },
      });
    } else {
      // Single-file mode – persist current source only
      await _clearDirectoryHandle();
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
