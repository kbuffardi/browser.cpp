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

/** Milliseconds before a blob URL created for download is revoked. */
const BLOB_URL_REVOKE_DELAY_MS = 2_000;

/** @type {FileSystemFileHandle|null} */
let currentHandle = null;
let currentDirectoryHandle = null;
let workspaceName = null;
const workspaceEntries = [];
const workspaceFiles = new Map();
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
    handle = await window.showDirectoryPicker();
  } catch (err) {
    if (err.name === 'AbortError') return null;
    throw err;
  }

  currentDirectoryHandle = handle;
  workspaceName = handle.name;
  await walkDirectoryHandle(handle, '');
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
 * Restore a workspace from a previously stored FileSystemDirectoryHandle.
 * The caller must ensure the handle has read permission before calling.
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<{name:string, entries:Array, git:object}>}
 */
export async function openFolderFromHandle(handle) {
  clearWorkspace();
  currentDirectoryHandle = handle;
  workspaceName = handle.name;
  await walkDirectoryHandle(handle, '');
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
  currentDirectoryHandle = null;
  workspaceName = null;
  workspaceEntries.length = 0;
  workspaceFiles.clear();
  workspaceGit = { isRepo: false, branch: null, remotes: [] };
}

async function walkDirectoryHandle(dirHandle, prefix) {
  for await (const [name, entry] of dirHandle.entries()) {
    const relPath = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === 'directory') {
      workspaceEntries.push({ path: relPath, kind: 'directory' });
      await walkDirectoryHandle(entry, relPath);
    } else if (entry.kind === 'file') {
      workspaceEntries.push({ path: relPath, kind: 'file' });
      workspaceFiles.set(relPath, { handle: entry });
    }
  }
  workspaceEntries.sort((a, b) => a.path.localeCompare(b.path));
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
