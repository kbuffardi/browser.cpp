/**
 * src/ui/filesystem.js
 *
 * Thin wrapper around the File System Access API (WICG).
 * Provides open / save / saveAs operations with graceful fallbacks for
 * browsers that do not yet support the API.
 *
 * https://wicg.github.io/file-system-access/
 */

'use strict';

import {
  validateNewFilePath,
  validateNewDirectoryPath,
  applyWorkspaceMutation,
  applyWorkspaceDirectoryMutation,
  diffWorkspaceEntries,
  entryExists,
} from './workspace-fs.mjs';

/** Milliseconds before a blob URL created for download is revoked. */
const BLOB_URL_REVOKE_DELAY_MS = 2_000;

/** @type {FileSystemFileHandle|null} */
let currentHandle = null;
/** @type {FileSystemDirectoryHandle|null} */
let currentDirectoryHandle = null;
let workspaceName = null;
const workspaceEntries = [];
const workspaceFiles = new Map();
const workspaceFileFingerprints = new Map();
let workspaceGit = { isRepo: false, branch: null, remotes: [] };

const CPP_TYPES = [
  {
    description: 'C++ source files',
    accept: {
      'text/x-c++src': ['.cpp', '.cc', '.cxx', '.c++'],
      'text/x-csrc':   ['.c'],
      'text/x-chdr':   ['.h', '.hpp', '.hxx'],
    },
  },
  {
    description: 'All files',
    accept: { '*/*': [] },
  },
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Open a file from disk.
 * @returns {Promise<{ name: string, content: string }|null>}
 *   null if the user cancelled.
 */
export async function openFile() {
  clearWorkspace();
  if (!supportsFileSystemAccess()) {
    return openFileFallback();
  }

  let handle;
  try {
    [handle] = await window.showOpenFilePicker({
      types: CPP_TYPES,
      excludeAcceptAllOption: false,
      multiple: false,
    });
  } catch (err) {
    if (err.name === 'AbortError') return null; // user cancelled
    throw err;
  }

  currentHandle = handle;
  const file    = await handle.getFile();
  const content = await file.text();
  return { name: file.name, content };
}

/**
 * Open a local folder and index its files/subdirectories.
 * @returns {Promise<{ name: string, entries: Array<{path:string, kind:'file'|'directory'}>, git: {isRepo:boolean, branch:string|null, remotes:string[]} }|null>}
 */
export async function openFolder() {
  clearWorkspace();

  if (!supportsDirectoryAccess()) {
    return openFolderFallback();
  }

  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err) {
    if (err.name === 'AbortError') return null;
    throw err;
  }

  currentDirectoryHandle = handle;
  workspaceName = handle.name;
  replaceWorkspaceIndex(await scanDirectoryHandle(handle));
  workspaceGit = await detectGitMetadata();

  return {
    name: workspaceName,
    entries: [...workspaceEntries],
    git: workspaceGit,
  };
}

/**
 * Save content to the currently open file handle.
 * Falls back to saveAs if no handle exists yet.
 *
 * @param {string} content
 * @param {string} [suggestedName='main.cpp']
 * @returns {Promise<string|null>} The file name saved to, or null if cancelled.
 */
export async function saveFile(content, suggestedName = 'main.cpp') {
  if (!currentHandle) {
    return saveFileAs(content, suggestedName);
  }

  try {
    const writable = await currentHandle.createWritable();
    await writable.write(content);
    await writable.close();
    return currentHandle.name;
  } catch (err) {
    // If permission was revoked, fall back to saveAs
    if (err.name === 'NotAllowedError') {
      currentHandle = null;
      return saveFileAs(content, suggestedName);
    }
    throw err;
  }
}

/**
 * Show a Save As dialog and write content to the chosen location.
 *
 * @param {string} content
 * @param {string} [suggestedName='main.cpp']
 * @returns {Promise<string|null>} The file name saved to, or null if cancelled.
 */
export async function saveFileAs(content, suggestedName = 'main.cpp') {
  if (!supportsFileSystemAccess()) {
    return saveFileFallback(content, suggestedName);
  }

  let handle;
  try {
    handle = await window.showSaveFilePicker({
      suggestedName,
      types: CPP_TYPES,
    });
  } catch (err) {
    if (err.name === 'AbortError') return null;
    throw err;
  }

  currentHandle = handle;
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
  return handle.name;
}

/** Return the name of the currently open file, or null. */
export function currentFileName() {
  return currentHandle?.name ?? null;
}

/** Clear the current file handle (i.e. treat editor as a new unsaved file). */
export function newFile() {
  currentHandle = null;
}

/** Return the currently open directory handle (for session persistence). */
export function getDirectoryHandle() {
  return currentDirectoryHandle;
}

/**
 * Reset all in-memory workspace state so a previously opened folder is fully
 * abandoned. Used by the relaunch "Start new project" path so the old
 * workspace cannot be rehydrated later by accident.
 */
export function resetWorkspace() {
  clearWorkspace();
}

/** Return a serializable snapshot of the current workspace metadata. */
export function getWorkspaceSnapshot() {
  if (!workspaceName) return null;
  return {
    name: workspaceName,
    entries: [...workspaceEntries],
    git: workspaceGit,
  };
}

/**
 * Restore a workspace from a previously stored FileSystemDirectoryHandle.
 * The caller must ensure the handle has read permission before calling.
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<{name:string, entries:Array, git:object}>}
 */
export async function openFolderFromHandle(handle) {
  clearWorkspace();
  currentDirectoryHandle = handle;
  workspaceName = handle.name;
  replaceWorkspaceIndex(await scanDirectoryHandle(handle));
  workspaceGit = await detectGitMetadata();
  return {
    name: workspaceName,
    entries: [...workspaceEntries],
    git: workspaceGit,
  };
}

/** Read a file from the currently opened workspace folder. */
export async function readWorkspaceFile(path) {
  const key = normalizeWorkspacePath(path);
  const item = workspaceFiles.get(key);
  if (!item) return null;
  if (item.handle) {
    const file = await item.handle.getFile();
    return file.text();
  }
  if (item.file) {
    return item.file.text();
  }
  return null;
}

/**
 * Read all files in the currently opened workspace as raw bytes.
 * Returns an array of { path: string, bytes: Uint8Array } objects.
 * Returns an empty array when no workspace is open.
 */
export async function readAllWorkspaceFiles() {
  const result = [];
  for (const [path, item] of workspaceFiles) {
    try {
      let file;
      if (item.handle) {
        file = await item.handle.getFile();
      } else if (item.file) {
        file = item.file;
      } else {
        continue;
      }
      const buf = await file.arrayBuffer();
      result.push({ path, bytes: new Uint8Array(buf) });
    } catch (err) {
      console.warn('[browser.cpp] Could not read workspace file for VFS:', path, err);
    }
  }
  return result;
}

/**
 * Merge a newly written file into the in-memory workspace index so the Explorer
 * and terminal reflect it immediately: store the file (with its handle when we
 * have one) and add the file + any missing ancestor directory entries.
 *
 * Single source of truth for index updates shared by Explorer-created files,
 * persisted compile artifacts, and runtime `fstream` write-back.
 *
 * @param {string} key – normalised workspace-relative path
 * @param {FileSystemFileHandle|null} fileHandle
 */
function indexWorkspaceFile(key, fileHandle) {
  if (fileHandle) {
    workspaceFiles.set(key, { handle: fileHandle });
  } else if (!workspaceFiles.has(key)) {
    workspaceFiles.set(key, {});
  }
  if (!entryExists(workspaceEntries, key)) {
    const { entries } = applyWorkspaceMutation(workspaceEntries, key);
    workspaceEntries.length = 0;
    workspaceEntries.push(...entries);
  }
}

function indexWorkspaceDirectory(key) {
  const { entries } = applyWorkspaceDirectoryMutation(workspaceEntries, key);
  workspaceEntries.length = 0;
  workspaceEntries.push(...entries);
}

async function updateFileFingerprint(key, fileHandle) {
  if (!fileHandle) return;
  try {
    const file = await fileHandle.getFile();
    const fingerprint = fingerprintForFile(file);
    if (fingerprint) workspaceFileFingerprints.set(key, fingerprint);
  } catch {
    workspaceFileFingerprints.delete(key);
  }
}

/**
 * Write `data` to `key` in the opened folder, creating any missing parent
 * directories, and update the in-memory index. Returns the file handle when the
 * on-disk write succeeded plus persistence metadata. When persistence fails we
 * still update the in-memory workspace index so the UI can surface generated
 * files and explain why they were not written to disk.
 *
 * @param {string} key – normalised workspace-relative path
 * @param {Uint8Array} data
 * @returns {Promise<{ fileHandle: FileSystemFileHandle|null, persisted: boolean, persistenceReason: string|null }>}
 */
async function writeAndIndex(key, data) {
  // Prefer the stored handle if we already have one.
  const item = workspaceFiles.get(key);
  if (item?.handle) {
    try {
      const writable = await item.handle.createWritable();
      await writable.write(data);
      await writable.close();
      indexWorkspaceFile(key, item.handle);
      await updateFileFingerprint(key, item.handle);
      return { fileHandle: item.handle, persisted: true, persistenceReason: null };
    } catch (err) {
      console.warn('[browser.cpp] Could not write via stored handle, retrying via directory:', key, err);
    }
  }

  // No usable handle – navigate the directory tree and create the file.
  if (!currentDirectoryHandle) {
    // Fallback (webkitdirectory) workspaces cannot write to disk, but the
    // Explorer index should still reflect the new file.
    indexWorkspaceFile(key, null);
    return { fileHandle: null, persisted: false, persistenceReason: 'no-directory-handle' };
  }

  const parts = key.split('/');
  const filename = parts.pop();
  let dirHandle = currentDirectoryHandle;

  for (const part of parts) {
    if (!part) continue;
    try {
      dirHandle = await dirHandle.getDirectoryHandle(part, { create: true });
    } catch (err) {
      indexWorkspaceFile(key, null);
      return {
        fileHandle: null,
        persisted: false,
        persistenceReason: err?.name === 'NotAllowedError' ? 'permission-denied' : 'directory-create-failed',
      };
    }
  }

  let fileHandle;
  try {
    fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  } catch (err) {
    indexWorkspaceFile(key, null);
    return {
      fileHandle: null,
      persisted: false,
      persistenceReason: err?.name === 'NotAllowedError' ? 'permission-denied' : 'file-create-failed',
    };
  }

  try {
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
    indexWorkspaceFile(key, fileHandle);
    await updateFileFingerprint(key, fileHandle);
    return { fileHandle, persisted: true, persistenceReason: null };
  } catch (err) {
    // Write permission denied – changes remain in-memory only.
    indexWorkspaceFile(key, null);
    return {
      fileHandle: null,
      persisted: false,
      persistenceReason: err?.name === 'NotAllowedError' ? 'permission-denied' : 'disk-write-failed',
    };
  }
}

/**
 * Write content to a file in the currently opened workspace folder.
 * Creates the file (and any missing parent directories) if it does not exist
 * and refreshes the in-memory workspace index so the Explorer/terminal reflect
 * the new file immediately. Does nothing when no workspace folder is open.
 *
 * @param {string}            path    – workspace-relative path (e.g. "output.txt")
 * @param {Uint8Array|string} content – bytes or text to write
 * @returns {Promise<object|null>} refreshed workspace snapshot, or null when no
 *   workspace is open.
 */
export async function writeWorkspaceFile(path, content) {
  const key = normalizeWorkspacePath(path);
  if (!key) return null;
  if (!workspaceName) return null; // no workspace open → no write-back

  const data = content instanceof Uint8Array
    ? content
    : new TextEncoder().encode(content);

  const writeResult = await writeAndIndex(key, data);
  return {
    ...getWorkspaceSnapshot(),
    persisted: writeResult.persisted,
    persistenceReason: writeResult.persistenceReason,
  };
}

/**
 * Rescan the opened folder and diff the result against the in-memory workspace
 * index. This is the authoritative sync path for changes made outside the
 * current UI flow (external edits, deletes, and runtime delete write-back).
 *
 * @returns {Promise<{snapshot:object, added:Array, removed:Array, changed:Array}|null>}
 */
export async function refreshWorkspace() {
  if (!workspaceName) return null;
  if (!currentDirectoryHandle) {
    return {
      snapshot: getWorkspaceSnapshot(),
      added: [],
      removed: [],
      changed: [],
    };
  }

  const oldEntries = [...workspaceEntries];
  const oldFingerprints = new Map(workspaceFileFingerprints);
  const scanned = await scanDirectoryHandle(currentDirectoryHandle);
  const diff = diffWorkspaceEntries(
    oldEntries,
    scanned.entries,
    oldFingerprints,
    scanned.fingerprints
  );

  replaceWorkspaceIndex(scanned);
  workspaceGit = await detectGitMetadata();
  return {
    snapshot: getWorkspaceSnapshot(),
    ...diff,
  };
}

/**
 * Delete a file from the opened workspace folder and return the refreshed
 * snapshot. Missing files are treated as already deleted.
 *
 * @param {string} path
 * @returns {Promise<object|null>}
 */
export async function deleteWorkspaceFile(path) {
  const key = normalizeWorkspacePath(path);
  if (!key || !workspaceName) return null;

  if (!currentDirectoryHandle) {
    workspaceFiles.delete(key);
    workspaceFileFingerprints.delete(key);
    const idx = workspaceEntries.findIndex((entry) => entry.path === key && entry.kind === 'file');
    if (idx !== -1) workspaceEntries.splice(idx, 1);
    return getWorkspaceSnapshot();
  }

  const parts = key.split('/').filter(Boolean);
  const filename = parts.pop();
  if (!filename) return getWorkspaceSnapshot();

  let dirHandle = currentDirectoryHandle;
  try {
    for (const part of parts) {
      dirHandle = await dirHandle.getDirectoryHandle(part);
    }
    await dirHandle.removeEntry(filename);
  } catch (err) {
    if (err.name !== 'NotFoundError') throw err;
  }

  const refreshed = await refreshWorkspace();
  return refreshed?.snapshot ?? getWorkspaceSnapshot();
}

/**
 * Create a new, empty (or seeded) file in the opened workspace from an
 * Explorer-driven action. Validates/normalises the user-entered path, rejects
 * paths that already exist, materialises the file on disk, updates the in-memory
 * index, and returns the refreshed workspace snapshot plus the normalised path.
 *
 * @param {string} inputPath – user-entered workspace-relative path
 * @param {string} [content='']
 * @returns {Promise<{ok:true, path:string, snapshot:object} | {ok:false, error:string}>}
 */
export async function createWorkspaceFile(inputPath, content = '') {
  if (!workspaceName) return { ok: false, error: 'no-workspace' };

  const validated = validateNewFilePath(inputPath);
  if (!validated.ok) return validated;
  const key = validated.path;

  if (entryExists(workspaceEntries, key)) {
    return { ok: false, error: 'exists' };
  }

  const data = content instanceof Uint8Array
    ? content
    : new TextEncoder().encode(content);

  await writeAndIndex(key, data);
  return { ok: true, path: key, snapshot: getWorkspaceSnapshot() };
}

/**
 * Create a directory in the currently opened workspace folder.
 *
 * Supports nested paths and Linux-like `mkdir -p` semantics: without
 * `parents`, missing ancestors cause a failure; with `parents`, missing
 * ancestors are created. Final-target file collisions always fail. When the
 * final directory already exists, only `parents: true` treats it as success.
 *
 * @param {string} inputPath
 * @param {{ parents?: boolean }} [options]
 * @returns {Promise<
 *   {ok:true, path:string, snapshot:object, created:boolean} |
 *   {ok:false, error:string, path?:string}
 * >}
 */
export async function createWorkspaceDirectory(inputPath, { parents = false } = {}) {
  if (!workspaceName) return { ok: false, error: 'no-workspace' };
  if (!currentDirectoryHandle) return { ok: false, error: 'not-writable' };

  const validated = validateNewDirectoryPath(inputPath);
  if (!validated.ok) return validated;
  const key = validated.path;

  const existing = workspaceEntries.find((entry) => entry.path === key) || null;
  if (existing) {
    if (existing.kind === 'directory' && parents) {
      return { ok: true, path: key, snapshot: getWorkspaceSnapshot(), created: false };
    }
    return { ok: false, error: 'exists', path: key };
  }

  const segments = key.split('/').filter(Boolean);
  let dirHandle = currentDirectoryHandle;
  let prefix = '';

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    prefix = prefix ? `${prefix}/${segment}` : segment;
    const isFinal = index === segments.length - 1;
    const existingEntry = workspaceEntries.find((entry) => entry.path === prefix) || null;

    if (existingEntry?.kind === 'file') {
      return { ok: false, error: 'exists', path: prefix };
    }

    try {
      dirHandle = await dirHandle.getDirectoryHandle(segment, {
        create: isFinal || parents,
      });
    } catch (err) {
      if (err?.name === 'NotAllowedError') {
        return { ok: false, error: 'permission-denied', path: prefix };
      }
      if (!isFinal && !parents && err?.name === 'NotFoundError') {
        return { ok: false, error: 'missing-parent', path: prefix };
      }
      if (err?.name === 'TypeMismatchError') {
        return { ok: false, error: 'exists', path: prefix };
      }
      return {
        ok: false,
        error: isFinal ? 'directory-create-failed' : 'missing-parent',
        path: prefix,
      };
    }
  }

  indexWorkspaceDirectory(key);
  return { ok: true, path: key, snapshot: getWorkspaceSnapshot(), created: true };
}

// ── Feature detection ─────────────────────────────────────────────────────────

function supportsFileSystemAccess() {
  return typeof window.showOpenFilePicker === 'function';
}

function supportsDirectoryAccess() {
  return typeof window.showDirectoryPicker === 'function';
}

// ── Fallbacks for browsers without File System Access API ─────────────────────

/**
 * Classic <input type="file"> fallback for opening.
 */
function openFileFallback() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type   = 'file';
    input.accept = '.cpp,.cc,.cxx,.c++,.c,.h,.hpp,.hxx';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      const content = await file.text();
      resolve({ name: file.name, content });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

function openFolderFallback() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.webkitdirectory = true;
    input.onchange = () => {
      const files = Array.from(input.files || []);
      if (!files.length) {
        resolve(null);
        return;
      }

      const firstParts = (files[0].webkitRelativePath || '').split('/');
      workspaceName = firstParts.length > 1 && firstParts[0]
        ? firstParts[0]
        : 'workspace';

      const dirSet = new Set();
      for (const file of files) {
        const full = file.webkitRelativePath || file.name;
        const withoutRoot = full.startsWith(`${workspaceName}/`)
          ? full.slice(workspaceName.length + 1)
          : full;
        const path = normalizeWorkspacePath(withoutRoot);
        workspaceFiles.set(path, { file });
        const fingerprint = fingerprintForFile(file);
        if (fingerprint) workspaceFileFingerprints.set(path, fingerprint);
        workspaceEntries.push({ path, kind: 'file' });

        const segments = path.split('/');
        segments.pop();
        let cur = '';
        for (const seg of segments) {
          cur = cur ? `${cur}/${seg}` : seg;
          dirSet.add(cur);
        }
      }

      for (const dir of dirSet) {
        workspaceEntries.push({ path: dir, kind: 'directory' });
      }

      workspaceEntries.sort((a, b) => a.path.localeCompare(b.path));
      detectGitMetadata().then((git) => {
        workspaceGit = git;
        resolve({
          name: workspaceName,
          entries: [...workspaceEntries],
          git: workspaceGit,
        });
      });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/**
 * Classic <a download> fallback for saving.
 */
function saveFileFallback(content, suggestedName) {
  const blob = new Blob([content], { type: 'text/x-c++src' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_REVOKE_DELAY_MS);
  return Promise.resolve(suggestedName);
}

function clearWorkspace() {
  workspaceName = null;
  workspaceEntries.length = 0;
  workspaceFiles.clear();
  workspaceFileFingerprints.clear();
  workspaceGit = { isRepo: false, branch: null, remotes: [] };
  currentDirectoryHandle = null;
}

async function scanDirectoryHandle(dirHandle, prefix = '', scan = null) {
  const result = scan || {
    entries: [],
    files: new Map(),
    fingerprints: new Map(),
  };

  for await (const [name, entry] of dirHandle.entries()) {
    const relPath = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === 'directory') {
      result.entries.push({ path: relPath, kind: 'directory' });
      await scanDirectoryHandle(entry, relPath, result);
    } else if (entry.kind === 'file') {
      result.entries.push({ path: relPath, kind: 'file' });
      result.files.set(relPath, { handle: entry });
      const fingerprint = await fingerprintForFileHandle(entry);
      if (fingerprint) result.fingerprints.set(relPath, fingerprint);
    }
  }

  if (!scan) {
    result.entries.sort((a, b) => a.path.localeCompare(b.path));
  }
  return result;
}

function replaceWorkspaceIndex({ entries, files, fingerprints }) {
  workspaceEntries.length = 0;
  workspaceEntries.push(...entries);
  workspaceFiles.clear();
  for (const [path, item] of files) workspaceFiles.set(path, item);
  workspaceFileFingerprints.clear();
  for (const [path, fingerprint] of fingerprints) {
    workspaceFileFingerprints.set(path, fingerprint);
  }
}

async function fingerprintForFileHandle(handle) {
  try {
    return fingerprintForFile(await handle.getFile());
  } catch {
    return null;
  }
}

function fingerprintForFile(file) {
  if (!file) return null;
  const size = Number(file.size);
  const lastModified = Number(file.lastModified);
  if (!Number.isFinite(size) || !Number.isFinite(lastModified)) return null;
  return { size, lastModified };
}

async function detectGitMetadata() {
  const hasGitDir = workspaceEntries.some(
    (entry) => entry.kind === 'directory' && entry.path === '.git'
  );
  if (!hasGitDir && !workspaceFiles.has('.git/HEAD')) {
    return { isRepo: false, branch: null, remotes: [] };
  }

  let branch = null;
  const head = await readWorkspaceFile('.git/HEAD');
  if (head?.startsWith('ref:')) {
    const ref = head.slice(5).trim();
    branch = ref.split('/').pop() || null;
  }

  const remotes = [];
  const config = await readWorkspaceFile('.git/config');
  if (config) {
    const lines = config.split('\n');
    let inRemote = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[remote "')) {
        inRemote = true;
        continue;
      }
      if (trimmed.startsWith('[')) {
        inRemote = false;
        continue;
      }
      if (inRemote && trimmed.startsWith('url = ')) {
        remotes.push(trimmed.slice(6).trim());
      }
    }
  }

  return { isRepo: true, branch, remotes };
}

function normalizeWorkspacePath(path) {
  return String(path || '').replace(/^\/+/, '');
}
