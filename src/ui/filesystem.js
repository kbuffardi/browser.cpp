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

/** @type {FileSystemFileHandle|null} */
let currentHandle = null;

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

// ── Feature detection ─────────────────────────────────────────────────────────

function supportsFileSystemAccess() {
  return typeof window.showOpenFilePicker === 'function';
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
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return Promise.resolve(suggestedName);
}
