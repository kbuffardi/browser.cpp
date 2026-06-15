/**
 * src/ui/diagnostics.mjs
 *
 * Pure compiler-diagnostic parsing shared by editor.js and the E2E suite.
 *
 * Why: once builds target arbitrary workspace files (not just `/input.cpp`),
 * diagnostic parsing must capture any source path and stay scopable so the
 * active editor only shows markers for its own file while the terminal still
 * prints the full multi-file compiler/linker output.
 */

'use strict';

// Matches: path:line:col: severity: message   (path may be relative/absolute)
const DIAGNOSTIC_RE = /^\s*(\S.*?):(\d+):(\d+):\s+(error|warning|note):\s+(.+)$/gm;

/** Strip leading "./" and "/" so diagnostic paths compare to overlay paths. */
function normalize(path) {
  return String(path || '').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

/**
 * Parse compiler diagnostics from arbitrary workspace paths into structured
 * objects. Each item carries its (normalised) source `path`.
 *
 * @param {string} text
 * @returns {Array<{path:string, line:number, col:number, severity:string, message:string}>}
 */
export function parseDiagnostics(text) {
  const results = [];
  const re = new RegExp(DIAGNOSTIC_RE.source, 'gm');
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    results.push({
      path: normalize(m[1]),
      line: parseInt(m[2], 10),
      col: parseInt(m[3], 10),
      severity: m[4],
      message: m[5],
    });
  }
  return results;
}

/** True when a diagnostic path refers to the given active file. */
export function diagnosticMatchesPath(diagPath, activePath) {
  const a = normalize(diagPath);
  const b = normalize(activePath);
  if (!b) return false;
  if (a === b) return true;
  return a.split('/').pop() === b.split('/').pop();
}

/**
 * Filter diagnostics down to a single active file (for editor markers). When no
 * active path is supplied, all diagnostics are returned unchanged.
 *
 * @param {Array} items – output of {@link parseDiagnostics}
 * @param {string|null} activePath
 */
export function diagnosticsForPath(items, activePath) {
  if (!activePath) return items;
  return items.filter((d) => diagnosticMatchesPath(d.path, activePath));
}
