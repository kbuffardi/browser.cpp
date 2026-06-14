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
import { createSessionPersistence, createPersistenceGate } from './session-persistence.mjs';

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
    onCompile: async (source, flags, std) => {
      const vfsFiles = await fsAPI.readAllWorkspaceFiles();
      worker.postMessage({
        type: 'compile',
        source,
        flags,
        std,
        fileName: getActiveTabPath() || 'input.cpp',
        vfsFiles,
      });
    },
    onRun: async (sab) => {
      const vfsFiles = await fsAPI.readAllWorkspaceFiles();
      worker.postMessage({ type: 'run', sharedBuffer: sab, vfsFiles });
    },
    getSource: () => editorAPI.getValue(),
    readWorkspaceFile: (path) => fsAPI.readWorkspaceFile(path),
  });

  // 4. Toolbar (wires buttons + worker messages + keyboard shortcuts)
  const { restoreSession, persistSession } = createSessionPersistence({
    fsAPI,
    editorAPI,
    markDirty,
    getOpenTabPaths,
    getActiveTabPath,
    restoreWorkspace,
  });
  const persistenceGate = createPersistenceGate(persistSession);
  initToolbar(worker, editorAPI, terminalAPI, fsAPI, () => persistenceGate.persist());

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
  persistenceGate.enable();

  // 8. Resize terminal when the window or terminal panel is resized
  const resizeObserver = new ResizeObserver(() => terminalAPI.fitTerminal());
  const terminalPanel  = document.getElementById('terminal-container');
  if (terminalPanel) resizeObserver.observe(terminalPanel);
  initPanelResizers();

  // 9. Persist session on unload
  window.addEventListener('beforeunload', () => persistenceGate.persist());

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
