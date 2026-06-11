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
import { initToolbar, markDirty } from './toolbar.js';

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
    onRun: (sab) =>
      worker.postMessage({ type: 'run', sharedBuffer: sab }),
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

  // 9. Persist session on unload
  window.addEventListener('beforeunload', persistSession);

  editorAPI.focus();
});

// ── Session persistence (chrome.storage.local) ────────────────────────────────

const STORAGE_KEY = 'browser_cpp_session';

async function restoreSession() {
  try {
    const storage =
      typeof chrome !== 'undefined' && chrome.storage?.local
        ? chrome.storage.local
        : null;

    if (!storage) return;

    const data = await storage.get(STORAGE_KEY);
    const session = data[STORAGE_KEY];
    if (session?.source) {
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

    await storage.set({
      [STORAGE_KEY]: { source: editorAPI.getValue(), savedAt: Date.now() },
    });
  } catch (_) {
    return;
  }
}
