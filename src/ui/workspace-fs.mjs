/**
 * src/ui/workspace-fs.mjs
 *
 * Pure, browser-free workspace-path + workspace-index helpers shared by the UI
 * (`filesystem.js`, `toolbar.js`), and the Node E2E suite. This is the single
 * source of truth for:
 *   - validating/normalising a user-entered workspace-relative file path, and
 *   - applying an incremental file creation to a workspace entry list
 *     (adding the file plus any missing ancestor directories without rescanning
 *     the whole folder or duplicating entries), and
 *   - diffing two workspace scans so Explorer/terminal refreshes can react to
 *     files created, removed, or edited outside the current in-memory index.
 *
 * Why pure: Explorer-created files, persisted compile artifacts (`a.out`, custom
 * `-o` targets) and runtime `fstream` writes all mutate the same in-memory
 * workspace index. Keeping the rules here means every path produces an identical
 * Explorer/terminal view regardless of which code path created the file, and the
 * tricky path rules can be unit-tested without a DOM or the WASM toolchain.
 */

'use strict';

/**
 * Validate and normalise a workspace-relative target path entered for file
 * creation. Accepts nested relative paths (`src/lib/util.hpp`); a bare filename
 * resolves to the workspace root. Rejects absolute paths, empty input, and any
 * `..` traversal so creation can never escape the opened folder.
 *
 * @param {string} input
 * @returns {{ok:true, path:string} | {ok:false, error:string}}
 *   error is one of: 'empty', 'absolute', 'traversal', 'no-filename'.
 */
export function validateNewFilePath(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'empty' };
  if (raw.startsWith('/')) return { ok: false, error: 'absolute' };

  const segments = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return { ok: false, error: 'traversal' };
    segments.push(seg);
  }

  if (segments.length === 0) return { ok: false, error: 'empty' };

  const path = segments.join('/');
  // A trailing slash (directory only) leaves no basename to create.
  if (/\/$/.test(raw) || !segments[segments.length - 1]) {
    return { ok: false, error: 'no-filename' };
  }
  return { ok: true, path };
}

/**
 * Ordered ancestor directory paths for a workspace-relative path.
 * `src/lib/util.hpp` -> ['src', 'src/lib'].
 *
 * @param {string} path
 * @returns {string[]}
 */
export function directoriesForPath(path) {
  const segments = String(path || '').split('/').filter(Boolean);
  segments.pop(); // drop the basename
  const dirs = [];
  let acc = '';
  for (const seg of segments) {
    acc = acc ? `${acc}/${seg}` : seg;
    dirs.push(acc);
  }
  return dirs;
}

/** Sort entries the same way `filesystem.js` sorts a freshly-walked folder. */
function sortEntries(entries) {
  return entries.slice().sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * True when an entry for the exact path already exists (any kind).
 * @param {Array<{path:string, kind:string}>} entries
 * @param {string} path
 */
export function entryExists(entries, path) {
  return entries.some((e) => e.path === path);
}

/**
 * Apply a file creation to a workspace entry list: add the file entry plus any
 * missing ancestor directory entries, de-duplicated and sorted. Returns a new
 * array (the input is not mutated) and the list of newly added entries.
 *
 * @param {Array<{path:string, kind:'file'|'directory'}>} entries
 * @param {string} path  – validated workspace-relative file path
 * @returns {{entries:Array, added:Array<{path:string, kind:string}>}}
 */
export function applyWorkspaceMutation(entries, path) {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const added = [];

  for (const dir of directoriesForPath(path)) {
    if (!byPath.has(dir)) {
      const entry = { path: dir, kind: 'directory' };
      byPath.set(dir, entry);
      added.push(entry);
    }
  }

  if (!byPath.has(path)) {
    const entry = { path, kind: 'file' };
    byPath.set(path, entry);
    added.push(entry);
  }

  return { entries: sortEntries([...byPath.values()]), added };
}

/**
 * Build a path-keyed lookup for entries.
 * @param {Array<{path:string, kind:string}>} entries
 */
function entriesByPath(entries) {
  return new Map((entries || []).map((entry) => [entry.path, entry]));
}

/**
 * Return a fingerprint from either a Map or a plain object.
 * @param {Map<string, object>|Object<string, object>|null|undefined} source
 * @param {string} path
 */
function fingerprintFor(source, path) {
  if (!source) return null;
  if (typeof source.get === 'function') return source.get(path) ?? null;
  return source[path] ?? null;
}

function fingerprintsDiffer(oldFingerprint, newFingerprint) {
  if (!oldFingerprint || !newFingerprint) return false;
  return oldFingerprint.size !== newFingerprint.size ||
    oldFingerprint.lastModified !== newFingerprint.lastModified;
}

/**
 * Compare two workspace entry lists and optional file fingerprints.
 *
 * A path whose kind changed is reported as remove + add because the Explorer and
 * terminal indexes need to discard the old kind before adopting the new one.
 * File content edits are reported as `changed` only when both old and new scans
 * provide fingerprints, avoiding noisy first-refresh updates for legacy state.
 *
 * @param {Array<{path:string, kind:'file'|'directory'}>} oldEntries
 * @param {Array<{path:string, kind:'file'|'directory'}>} newEntries
 * @param {Map<string, object>|Object<string, object>} [oldFingerprints]
 * @param {Map<string, object>|Object<string, object>} [newFingerprints]
 * @returns {{added:Array, removed:Array, changed:Array}}
 */
export function diffWorkspaceEntries(
  oldEntries,
  newEntries,
  oldFingerprints = null,
  newFingerprints = null
) {
  const oldByPath = entriesByPath(oldEntries);
  const newByPath = entriesByPath(newEntries);
  const added = [];
  const removed = [];
  const changed = [];

  for (const oldEntry of oldEntries || []) {
    const next = newByPath.get(oldEntry.path);
    if (!next || next.kind !== oldEntry.kind) {
      removed.push(oldEntry);
    }
  }

  for (const newEntry of newEntries || []) {
    const previous = oldByPath.get(newEntry.path);
    if (!previous || previous.kind !== newEntry.kind) {
      added.push(newEntry);
      continue;
    }

    if (
      newEntry.kind === 'file' &&
      fingerprintsDiffer(
        fingerprintFor(oldFingerprints, newEntry.path),
        fingerprintFor(newFingerprints, newEntry.path)
      )
    ) {
      changed.push(newEntry);
    }
  }

  return {
    added: sortEntries(added),
    removed: sortEntries(removed),
    changed: sortEntries(changed),
  };
}
