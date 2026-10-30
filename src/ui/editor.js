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
import { VISUAL_THEMES } from './themes.mjs';

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

// ── Internal state ────────────────────────────────────────────────────────────
let _editor = null;

function isMonochromeTheme(theme) {
  return theme === 'browser-cpp-monochrome-light' || theme === 'browser-cpp-monochrome-dark';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Mount Monaco Editor inside `container`.
 * @param {HTMLElement} container
 * @returns {monaco.editor.IStandaloneCodeEditor}
 */
export function createEditor(container, { theme = 'browser-cpp-dark' } = {}) {
  const darkTheme = VISUAL_THEMES.find(({ id }) => id === 'browser-cpp-dark');
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
      'editor.selectionForeground': darkTheme.selection.foreground,
      'editor.selectionBackground': darkTheme.selection.background,
      'editor.inactiveSelectionBackground': darkTheme.selection.inactiveBackground,
      'editorIndentGuide.background': '#313244',
      'editorWidget.background':     '#181825',
      'editorSuggestWidget.background': '#181825',
      'editorSuggestWidget.border':  '#45475a',
    },
  });

  for (const visualTheme of VISUAL_THEMES) {
    if (visualTheme.id === 'browser-cpp-dark') continue;
    if (visualTheme.id.startsWith('monochrome-')) {
      const { cssTokens: colors } = visualTheme;
      const isLight = visualTheme.id === 'monochrome-light';
      monaco.editor.defineTheme(visualTheme.monacoTheme, {
        base: isLight ? 'vs' : 'vs-dark',
        inherit: false,
        rules: [],
        colors: {
          'editor.background': colors.base,
          'editor.foreground': colors.text,
          'editorLineNumber.foreground': colors.subtext0,
          'editorLineNumber.activeForeground': colors.text,
          'editor.lineHighlightBackground': colors.surface0,
          'editorCursor.foreground': colors.text,
          'editor.selectionForeground': visualTheme.selection.foreground,
          'editor.selectionBackground': visualTheme.selection.background,
          'editor.inactiveSelectionBackground': visualTheme.selection.inactiveBackground,
          'editorIndentGuide.background': colors.surface1,
          'editorWidget.background': colors.mantle,
          'editorSuggestWidget.background': colors.mantle,
          'editorSuggestWidget.border': colors.surface1,
          'minimap.background': colors.mantle,
          'editorBracketHighlight.foreground1': colors.text,
          'editorBracketHighlight.foreground2': colors.text,
          'editorBracketHighlight.foreground3': colors.text,
          'editorBracketHighlight.foreground4': colors.text,
          'editorBracketHighlight.foreground5': colors.text,
          'editorBracketHighlight.foreground6': colors.text,
          'editorBracketHighlight.unexpectedBracket.foreground': colors.text,
        },
      });
      continue;
    }
    monaco.editor.defineTheme(visualTheme.monacoTheme, {
      base: visualTheme.id,
      inherit: true,
      rules: [],
      colors: {
        'editor.selectionForeground': visualTheme.selection.foreground,
        'editor.selectionBackground': visualTheme.selection.background,
        'editor.inactiveSelectionBackground': visualTheme.selection.inactiveBackground,
      },
    });
  }

  _editor = monaco.editor.create(container, {
    value: '',
    language: 'cpp',
    theme,
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

  _editor.updateOptions({
    bracketPairColorization: { enabled: !isMonochromeTheme(theme) },
    guides: { bracketPairs: !isMonochromeTheme(theme), indentation: true },
  });

  if (new URLSearchParams(globalThis.location?.search || '').has('smoke-test')) {
    container.__browserCppPrepareSelectionColorRead = () => {
      return true;
    };
    container.__browserCppReadSelectionColors = () => {
      const editorNode = _editor.getDomNode();
      if (!editorNode) return null;
      const viewLine = document.createElement('div');
      viewLine.className = 'view-line focused';
      const selected = document.createElement('span');
      selected.className = 'selected-text inline-selected-text';
      selected.textContent = 'theme color probe';
      viewLine.append(selected);
      editorNode.append(viewLine);
      const toHex = (value) => {
        const channels = value.match(/[\d.]+/g)?.map(Number);
        if (!channels || channels.length < 3) return value;
        return `#${channels.slice(0, 3).map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
      };
      const background = toHex(getComputedStyle(selected).backgroundColor);
      const foreground = toHex(getComputedStyle(selected).color);
      viewLine.classList.remove('focused');
      const inactiveBackground = toHex(getComputedStyle(selected).backgroundColor);
      viewLine.remove();
      return { background, foreground, inactiveBackground };
    };
  }

  return _editor;
}

export function setTheme(theme) {
  monaco.editor.setTheme(theme);
  _editor?.updateOptions({
    bracketPairColorization: { enabled: !isMonochromeTheme(theme) },
    guides: { bracketPairs: !isMonochromeTheme(theme), indentation: true },
  });
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
