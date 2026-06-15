/**
 * src/ui/build-request.mjs
 *
 * Pure, browser-free helpers that assemble project-build requests. Living in a
 * standalone module (no xterm/monaco imports) lets both the real UI modules and
 * the Node E2E suite share one source of truth — the same pattern used by
 * session-persistence.mjs.
 *
 * Why this exists: compilation moved from "one editor buffer" to "the whole
 * opened workspace". The toolbar must discover every project source file, the
 * terminal must honour explicit `g++ a.cpp b.cpp` arguments, and both must
 * overlay unsaved tab edits on top of on-disk content so the compiler sees the
 * exact in-memory project the user is looking at.
 */

'use strict';

/** Extensions that whole-project discovery compiles (MVP product constraint). */
export const PROJECT_SOURCE_EXTENSIONS = ['cpp', 'cxx'];

/**
 * Extensions that look like C/C++ sources but are intentionally rejected by this
 * MVP. `.cc` is commonly C++ elsewhere, but the spec deliberately excludes it so
 * discovery stays predictable; explicit terminal targets fail loudly instead of
 * compiling silently.
 */
export const REJECTED_SOURCE_EXTENSIONS = ['c', 'cc'];

/** Lower-cased extension (without the dot) of a path, or '' if none. */
export function fileExtension(path) {
  const base = String(path || '').split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** True when `path` is a project source file (`.cpp`/`.cxx`). */
export function isProjectSource(path) {
  return PROJECT_SOURCE_EXTENSIONS.includes(fileExtension(path));
}

/** True when `path` is a rejected source kind (`.c`/`.cc`) under this MVP. */
export function isRejectedSource(path) {
  return REJECTED_SOURCE_EXTENSIONS.includes(fileExtension(path));
}

/** Strip leading "./" and "/" so overlay/source paths are workspace-relative. */
export function normalizeOverlayPath(path) {
  return String(path || '').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

/**
 * Pick every recursive `.cpp`/`.cxx` file from workspace snapshot entries,
 * ignoring `.c`/`.cc`. Result is de-duplicated and sorted for determinism.
 *
 * @param {Array<{path:string, kind:string}>} entries
 * @returns {string[]} workspace-relative source paths
 */
export function selectWorkspaceSources(entries = []) {
  const out = new Set();
  for (const entry of entries || []) {
    if (!entry || entry.kind !== 'file' || !entry.path) continue;
    if (isProjectSource(entry.path)) out.add(normalizeOverlayPath(entry.path));
  }
  return [...out].sort();
}

/**
 * Merge on-disk workspace files with unsaved (dirty) open-tab content so the
 * compiler sees the live project state. Dirty tab content always wins over the
 * disk copy of the same path.
 *
 * @param {Array<{path:string, bytes:Uint8Array}>} diskFiles
 * @param {Record<string, string|Uint8Array>} dirtyContentByPath
 * @returns {Array<{path:string, content:string|Uint8Array}>}
 */
export function buildCompileOverlay(diskFiles = [], dirtyContentByPath = {}) {
  const overlay = new Map();
  for (const file of diskFiles || []) {
    if (!file || !file.path || file.bytes == null) continue;
    overlay.set(normalizeOverlayPath(file.path), file.bytes);
  }
  for (const [path, content] of Object.entries(dirtyContentByPath || {})) {
    if (content == null) continue;
    overlay.set(normalizeOverlayPath(path), content);
  }
  return [...overlay.entries()].map(([path, content]) => ({ path, content }));
}

/**
 * Resolve a terminal path argument relative to the workspace cwd, returning a
 * workspace-relative path (no leading slash). Mirrors POSIX `.`/`..` handling.
 *
 * @param {string} cwd   – current working directory (e.g. '/' or '/src')
 * @param {string} input – path argument (relative or absolute)
 * @returns {string}
 */
export function resolveWorkspacePath(cwd, input) {
  const raw = String(input || '').trim();
  const absolute = raw.startsWith('/');
  const segments = absolute
    ? raw.split('/')
    : [...String(cwd || '/').split('/'), ...raw.split('/')];
  const parts = [];
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Parse `g++`/`clang++` arguments, preserving positional source files and the
 * `-o` output name (both previously discarded). Recognised flags are split out;
 * everything else is forwarded as an extra compiler flag.
 *
 * @param {string[]} args
 * @returns {{ std:string, outputName:(string|null), flags:string[], sourcePaths:string[] }}
 */
export function parseGxxArgs(args = []) {
  let std = 'c++20';
  let outputName = null;
  const flags = [];
  const sourcePaths = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-std=')) {
      std = a.slice(5);
    } else if (a === '-std' && args[i + 1]) {
      std = args[++i];
    } else if (a === '-o' && args[i + 1]) {
      outputName = args[++i];
    } else if (a.startsWith('-o') && a.length > 2) {
      outputName = a.slice(2);
    } else if (a.startsWith('-')) {
      flags.push(a);
    } else {
      sourcePaths.push(a);
    }
  }

  return { std, outputName, flags, sourcePaths };
}

/**
 * Decide what a `./name` terminal invocation should run. A failed build must
 * never overwrite the last successful artifact, so the comparison is purely
 * against the last successfully built artifact path.
 *
 * @param {string} command               – e.g. './a.out' or './custom-name'
 * @param {string|null} lastBuiltArtifactPath
 * @returns {{ ok:boolean, error?:string }}
 */
export function resolveRunTarget(command, lastBuiltArtifactPath) {
  if (!lastBuiltArtifactPath) {
    return { ok: false, error: 'no-binary' };
  }
  const requested = normalizeOverlayPath(String(command || '').replace(/^\.\//, ''));
  const artifact = normalizeOverlayPath(lastBuiltArtifactPath);
  const artifactBase = artifact.split('/').pop();
  if (requested === artifact || requested === artifactBase) {
    return { ok: true };
  }
  return { ok: false, error: 'not-found' };
}
