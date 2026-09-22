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

/** Extensions accepted by the C++ compiler, matched case-insensitively. */
export const PROJECT_SOURCE_EXTENSIONS = ['c', 'cc', 'cpp', 'cxx'];

/** Lower-cased extension (without the dot) of a path, or '' if none. */
export function fileExtension(path) {
  const base = String(path || '').split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** True when `path` is a project source file. */
export function isProjectSource(path) {
  return PROJECT_SOURCE_EXTENSIONS.includes(fileExtension(path));
}

/** Strip leading "./" and "/" so overlay/source paths are workspace-relative. */
export function normalizeOverlayPath(path) {
  return String(path || '').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

/**
 * Pick root-level C/C++ sources from workspace snapshot entries. Nested source
 * files require an explicit terminal command. Result is de-duplicated and
 * sorted for determinism.
 *
 * @param {Array<{path:string, kind:string}>} entries
 * @returns {string[]} workspace-relative source paths
 */
export function selectWorkspaceSources(entries = []) {
  const out = new Set();
  for (const entry of entries || []) {
    if (!entry || entry.kind !== 'file' || !entry.path) continue;
    const path = normalizeOverlayPath(entry.path);
    if (!path.includes('/') && isProjectSource(path)) out.add(path);
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

/** True when a path contains a supported wildcard expression. */
export function hasGlobPattern(path) {
  const value = String(path || '');
  return /[*?]/.test(value) || /\[(?:!|\^)?[^\]/]+\]/.test(value);
}

function escapeRegExpCharacter(character) {
  return /[|\\{}()[\]^$+*?.]/.test(character) ? `\\${character}` : character;
}

/**
 * Convert a supported workspace glob to a regular expression. Wildcards never
 * cross a path separator, which keeps matching non-recursive.
 */
export function globPatternToRegExp(pattern) {
  const value = String(pattern || '');
  let expression = '^';

  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else if (character === '[') {
      const closingIndex = value.indexOf(']', index + 1);
      const content = value.slice(index + 1, closingIndex);
      if (closingIndex === -1 || !content || content.includes('/')) {
        expression += '\\[';
      } else {
        const negated = content[0] === '!' || content[0] === '^';
        const classContent = negated ? content.slice(1) : content;
        if (!classContent) {
          expression += '\\[';
        } else {
          const escapedClassContent = classContent.replace(/\\/g, '\\\\');
          expression += `(?=[^/])[${negated ? '^' : ''}${escapedClassContent}]`;
          index = closingIndex;
        }
      }
    } else {
      expression += escapeRegExpCharacter(character);
    }
  }

  return new RegExp(`${expression}$`);
}

/**
 * Expand globbed `g++` source arguments against workspace files. Inputs and
 * outputs are workspace-relative paths. Patterns without matches stay literal
 * so the compiler can report its native missing-file diagnostic.
 */
export function expandGxxGlobArgs(sourcePaths = [], workspaceFilePaths = [], cwd = '/') {
  const files = workspaceFilePaths.map(normalizeOverlayPath);

  return sourcePaths.flatMap((sourcePath) => {
    const resolved = resolveWorkspacePath(cwd, sourcePath);
    if (!hasGlobPattern(resolved)) return [resolved];

    const matcher = globPatternToRegExp(resolved);
    const matches = files.filter((path) => matcher.test(path)).sort();
    return matches.length ? matches : [resolved];
  });
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
 * @param {string[]} workspaceFilePaths
 * @returns {{ ok:boolean, path?:string, source?:string, error?:string }}
 */
export function resolveRunTarget(command, lastBuiltArtifactPath, workspaceFilePaths = []) {
  const requested = normalizeOverlayPath(String(command || '').replace(/^\.\//, ''));
  const workspaceFiles = new Set(
    workspaceFilePaths.map((path) => normalizeOverlayPath(path)).filter(Boolean)
  );

  if (workspaceFiles.has(requested)) {
    return { ok: true, path: requested, source: 'workspace' };
  }

  if (!lastBuiltArtifactPath) {
    return workspaceFiles.size > 0
      ? { ok: false, error: 'not-found' }
      : { ok: false, error: 'no-binary' };
  }

  const artifact = normalizeOverlayPath(lastBuiltArtifactPath);
  const artifactBase = artifact.split('/').pop();
  if (requested === artifact || requested === artifactBase) {
    return { ok: true, path: artifact, source: 'last-built' };
  }
  return { ok: false, error: 'not-found' };
}

/**
 * Select bytes for a worker run request. Explicit terminal targets always use
 * their matching workspace file so an earlier in-memory compile cannot run by
 * mistake. Toolbar runs have no target and retain the cached artifact path.
 *
 * @param {{artifactPath?:string}} request
 * @param {Array<{path:string, bytes:Uint8Array}>} workspaceFiles
 * @param {Uint8Array|null} cachedBinaryBytes
 * @returns {Uint8Array|null}
 */
export function selectRunBinaryBytes(request, workspaceFiles = [], cachedBinaryBytes = null) {
  if (!request?.artifactPath) return cachedBinaryBytes;
  const artifact = workspaceFiles.find((file) => file.path === request.artifactPath);
  return artifact ? new Uint8Array(artifact.bytes) : null;
}
