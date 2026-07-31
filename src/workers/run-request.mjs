'use strict';

export const BUFFERED_STDIN_MAX_BYTES = 256 * 1024;
export const INTERACTIVE_STDIN_CHUNK_MAX_BYTES = 64 * 1024;
const STDIN_SESSION_ID_MAX_LENGTH = 128;

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

function isValidStdinSessionId(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= STDIN_SESSION_ID_MAX_LENGTH;
}

export function validateStdinMessage(message) {
  if (!message || !isValidStdinSessionId(message.stdinSessionId)) {
    return invalid('Invalid stdin message: stdinSessionId is required.');
  }

  if (message.type === 'stdin-data') {
    if (!isByteSource(message.bytes)) {
      return invalid('Invalid stdin-data message: bytes must be a Uint8Array or ArrayBuffer.');
    }
    if (message.bytes.byteLength === 0) {
      return invalid('Invalid stdin-data message: bytes must not be empty.');
    }
    if (message.bytes.byteLength > INTERACTIVE_STDIN_CHUNK_MAX_BYTES) {
      return invalid('Invalid stdin-data message: input chunk exceeds the 64 KiB limit.');
    }
    return {
      ok: true,
      value: {
        type: 'stdin-data',
        sessionId: message.stdinSessionId,
        bytes: asUint8Array(message.bytes),
      },
    };
  }

  if (message.type === 'stdin-eof') {
    if (message.bytes !== undefined) {
      return invalid('Invalid stdin-eof message: bytes are not allowed.');
    }
    return {
      ok: true,
      value: { type: 'stdin-eof', sessionId: message.stdinSessionId },
    };
  }

  return invalid('Invalid stdin message type. Expected stdin-data or stdin-eof.');
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

    case 'interactive-message':
      if (
        !isValidStdinSessionId(request.stdinSessionId) ||
        request.sharedBuffer !== undefined ||
        request.stdinBuffer !== undefined
      ) {
        return invalid(
          'Invalid interactive-message stdin: stdinSessionId is required and no buffer may be supplied.'
        );
      }
      stdin = {
        mode: 'interactive-message',
        sessionId: request.stdinSessionId,
      };
      break;

    case 'buffered':
      if (!isByteSource(request.stdinBuffer) || request.sharedBuffer !== undefined) {
        return invalid('Invalid buffered stdin: stdinBuffer must be a Uint8Array or ArrayBuffer.');
      }
      if (request.stdinBuffer.byteLength > BUFFERED_STDIN_MAX_BYTES) {
        return invalid('Invalid buffered stdin: input exceeds the 256 KiB limit.');
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
      return invalid(
        'Invalid stdinMode. Expected interactive, interactive-message, buffered, or none.'
      );
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
