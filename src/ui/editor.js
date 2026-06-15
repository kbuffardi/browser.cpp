/**
 * src/ui/editor.js
 *
 * Wraps Monaco Editor.  Provides:
 *  - createEditor(container)  – mounts Monaco in the given element
 *  - getValue / setValue      – get / set the current document text
 *  - setLanguage              – change syntax highlighting
 *  - markDiagnostics(items)   – render compiler error/warning markers
 *  - onDidChangeCursorPosition(cb) – cursor position events
 *  - onDidChangeContent(cb)   – content-change events
 *  - focus()                  – give keyboard focus to the editor
 */

'use strict';

import * as monaco from 'monaco-editor';
import { parseDiagnostics as parseDiagnosticsShared } from './diagnostics.mjs';

// ── Monaco worker bootstrap ───────────────────────────────────────────────────
// Must run before any monaco API call. Tells Monaco where its worker scripts
// are located relative to the extension root (the dist/ folder).
self.MonacoEnvironment = {
  getWorkerUrl(_moduleId, label) {
    if (label === 'typescript' || label === 'javascript') {
      return new URL('ts.worker.js', self.location.href).href;
    }
    return new URL('editor.worker.js', self.location.href).href;
  },
};

// ── Default C++ starter source ────────────────────────────────────────────────
export const DEFAULT_SOURCE = `#include <iostream>

int main() {
    std::cout << "Hello, World!" << std::endl;
    return 0;
}
`;

// ── Internal state ────────────────────────────────────────────────────────────
let _editor = null;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Mount Monaco Editor inside `container`.
 * @param {HTMLElement} container
 * @returns {monaco.editor.IStandaloneCodeEditor}
 */
export function createEditor(container) {
  // Define a custom VS Code–like dark theme that matches our CSS palette
  monaco.editor.defineTheme('browser-cpp-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment',    foreground: '6c7086', fontStyle: 'italic' },
      { token: 'keyword',    foreground: 'cba6f7', fontStyle: 'bold'   },
      { token: 'string',     foreground: 'a6e3a1' },
      { token: 'number',     foreground: 'fab387' },
      { token: 'type',       foreground: '89b4fa' },
      { token: 'function',   foreground: '89dceb' },
      { token: 'operator',   foreground: 'f38ba8' },
    ],
    colors: {
      'editor.background':           '#1e1e2e',
      'editor.foreground':           '#cdd6f4',
      'editorLineNumber.foreground': '#45475a',
      'editorLineNumber.activeForeground': '#a6adc8',
      'editor.lineHighlightBackground':   '#313244',
      'editorCursor.foreground':     '#f5c2e7',
      'editor.selectionBackground':  '#45475a',
      'editor.inactiveSelectionBackground': '#313244',
      'editorIndentGuide.background': '#313244',
      'editorWidget.background':     '#181825',
      'editorSuggestWidget.background': '#181825',
      'editorSuggestWidget.border':  '#45475a',
    },
  });

  _editor = monaco.editor.create(container, {
    value: DEFAULT_SOURCE,
    language: 'cpp',
    theme: 'browser-cpp-dark',
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Courier New', monospace",
    fontLigatures: true,
    lineHeight: 22,
    tabSize: 4,
    insertSpaces: true,
    wordWrap: 'off',
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true, indentation: true },
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    automaticLayout: true, // resize with container
  });

  return _editor;
}

/** Get the full text of the current document. */
export function getValue() {
  return _editor ? _editor.getValue() : '';
}

/** Replace the full text of the current document. */
export function setValue(text) {
  if (_editor) _editor.setValue(text);
}

/** Change the editor language (e.g. 'cpp', 'c', 'plaintext'). */
export function setLanguage(lang) {
  if (_editor) {
    monaco.editor.setModelLanguage(_editor.getModel(), lang);
  }
}

/**
 * Render compiler diagnostics as editor markers (squiggly underlines).
 *
 * @param {Array<{severity:'error'|'warning'|'info', message:string, line:number, col:number}>} items
 */
export function markDiagnostics(items) {
  if (!_editor) return;
  const model = _editor.getModel();
  if (!model) return;

  const markers = items.map((d) => ({
    severity:
      d.severity === 'error'   ? monaco.MarkerSeverity.Error   :
      d.severity === 'warning' ? monaco.MarkerSeverity.Warning :
                                 monaco.MarkerSeverity.Info,
    message:         d.message,
    startLineNumber: d.line  || 1,
    startColumn:     d.col   || 1,
    endLineNumber:   d.endLine || d.line   || 1,
    endColumn:       d.endCol  || (d.col ? d.col + 1 : 2),
  }));

  monaco.editor.setModelMarkers(model, 'clang', markers);
}

/** Clear all diagnostic markers. */
export function clearDiagnostics() {
  if (!_editor) return;
  const model = _editor.getModel();
  if (model) monaco.editor.setModelMarkers(model, 'clang', []);
}

/**
 * Parse Clang/GCC diagnostic output into structured objects.
 *
 * Delegates to the shared, browser-free parser in diagnostics.mjs so editor
 * markers, the terminal, and the E2E suite all agree on diagnostic shape. The
 * parser captures arbitrary workspace-relative paths (not just `/input.cpp`),
 * which is required once builds target multiple project files.
 *
 * @param {string} diagnosticsText
 * @returns {Array}
 */
export function parseDiagnostics(diagnosticsText) {
  return parseDiagnosticsShared(diagnosticsText);
}

/** Register a callback for cursor position changes. */
export function onDidChangeCursorPosition(cb) {
  if (_editor) _editor.onDidChangeCursorPosition(cb);
}

/** Register a callback for content changes (marks the file dirty). */
export function onDidChangeContent(cb) {
  if (_editor) _editor.getModel()?.onDidChangeContent(cb);
}

/** Give keyboard focus to the editor. */
export function focus() {
  if (_editor) _editor.focus();
}

/** Get the underlying Monaco editor instance (for advanced use). */
export function getEditor() {
  return _editor;
}
