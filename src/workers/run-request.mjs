'use strict';

function isByteSource(value) {
  return value instanceof Uint8Array || value instanceof ArrayBuffer;
}

function asUint8Array(value) {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value);
}

function invalid(error) {
  return { ok: false, error };
}

/**
 * Validate and normalize the main-thread → compiler-worker run contract.
 *
 * This is the trust boundary for UI-provided binary, VFS, and stdin data. The
 * returned value contains only byte views and a discriminated stdin source.
 */
export function validateRunRequest(request) {
  if (!request || request.type !== 'run') {
    return invalid('Invalid run request.');
  }

  let stdin;
  switch (request.stdinMode) {
    case 'interactive':
      if (
        typeof SharedArrayBuffer === 'undefined' ||
        !(request.sharedBuffer instanceof SharedArrayBuffer) ||
        request.stdinBuffer !== undefined
      ) {
        return invalid('Invalid interactive stdin: sharedBuffer must be a SharedArrayBuffer.');
      }
      stdin = { mode: 'interactive', sharedBuffer: request.sharedBuffer };
      break;

    case 'buffered':
      if (!isByteSource(request.stdinBuffer) || request.sharedBuffer !== undefined) {
        return invalid('Invalid buffered stdin: stdinBuffer must be a Uint8Array or ArrayBuffer.');
      }
      stdin = { mode: 'buffered', bytes: asUint8Array(request.stdinBuffer) };
      break;

    case 'none':
      if (request.sharedBuffer !== undefined || request.stdinBuffer !== undefined) {
        return invalid('Invalid none stdin: no stdin buffer may be supplied.');
      }
      stdin = { mode: 'none' };
      break;

    default:
      return invalid('Invalid stdinMode. Expected interactive, buffered, or none.');
  }

  let binaryBytes = null;
  if (request.binaryBytes !== undefined && request.binaryBytes !== null) {
    if (!isByteSource(request.binaryBytes)) {
      return invalid('Invalid binaryBytes: expected a Uint8Array or ArrayBuffer.');
    }
    binaryBytes = asUint8Array(request.binaryBytes);
  }

  const rawVfsFiles = request.vfsFiles ?? [];
  if (!Array.isArray(rawVfsFiles)) {
    return invalid('Invalid vfsFiles: expected an array.');
  }

  const vfsFiles = [];
  for (const file of rawVfsFiles) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      file.path.length === 0 ||
      !isByteSource(file.bytes)
    ) {
      return invalid('Invalid vfsFiles entry: expected a non-empty path and Uint8Array or ArrayBuffer bytes.');
    }
    vfsFiles.push({ path: file.path, bytes: asUint8Array(file.bytes) });
  }

  return {
    ok: true,
    value: { stdin, vfsFiles, binaryBytes },
  };
}
