import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTERACTIVE_STDIN_CHUNK_MAX_BYTES,
  validateRunRequest,
  validateStdinMessage,
} from '../src/workers/run-request.mjs';

function interactiveRequest(overrides = {}) {
  return {
    type: 'run',
    stdinMode: 'interactive',
    sharedBuffer: new SharedArrayBuffer(16),
    vfsFiles: [{ path: 'input.txt', bytes: new Uint8Array([1, 2]) }],
    binaryBytes: new Uint8Array([0, 97, 115, 109]),
    ...overrides,
  };
}

test('e2e: worker run contract accepts and normalizes all stdin modes', () => {
  const interactive = validateRunRequest(interactiveRequest());
  assert.equal(interactive.ok, true);
  assert.equal(interactive.value.stdin.mode, 'interactive');

  const interactiveMessage = validateRunRequest(interactiveRequest({
    stdinMode: 'interactive-message',
    sharedBuffer: undefined,
    stdinSessionId: 'stdin-session-1',
  }));
  assert.equal(interactiveMessage.ok, true);
  assert.deepEqual(interactiveMessage.value.stdin, {
    mode: 'interactive-message',
    sessionId: 'stdin-session-1',
  });

  const none = validateRunRequest(interactiveRequest({
    stdinMode: 'none',
    sharedBuffer: undefined,
  }));
  assert.equal(none.ok, true);
  assert.deepEqual(none.value.stdin, { mode: 'none' });
});

test('e2e: worker run contract rejects mismatched stdin variants', () => {
  const cases = [
    interactiveRequest({ sharedBuffer: new ArrayBuffer(16) }),
    interactiveRequest({ stdinMode: 'buffered', sharedBuffer: undefined, stdinBuffer: 'Ada' }),
    interactiveRequest({ stdinMode: 'none', sharedBuffer: new SharedArrayBuffer(16) }),
    interactiveRequest({ stdinMode: 'interactive-message', sharedBuffer: undefined }),
    interactiveRequest({
      stdinMode: 'interactive-message',
      sharedBuffer: undefined,
      stdinSessionId: '',
    }),
    interactiveRequest({ stdinMode: 'unknown' }),
  ];

  for (const request of cases) {
    const result = validateRunRequest(request);
    assert.equal(result.ok, false);
    assert.match(result.error, /stdin/i);
  }
});

test('e2e: worker stdin message contract validates session-scoped data and EOF', () => {
  const bytes = new TextEncoder().encode('Ada\n');
  const data = validateStdinMessage({
    type: 'stdin-data',
    stdinSessionId: 'stdin-session-1',
    bytes: bytes.buffer,
  });
  assert.equal(data.ok, true);
  assert.equal(data.value.type, 'stdin-data');
  assert.equal(data.value.sessionId, 'stdin-session-1');
  assert.deepEqual([...data.value.bytes], [...bytes]);

  const eof = validateStdinMessage({
    type: 'stdin-eof',
    stdinSessionId: 'stdin-session-1',
  });
  assert.deepEqual(eof, {
    ok: true,
    value: { type: 'stdin-eof', sessionId: 'stdin-session-1' },
  });
});

test('e2e: worker stdin message contract rejects malformed and oversized input', () => {
  const cases = [
    { type: 'stdin-data', stdinSessionId: '', bytes: new Uint8Array([1]) },
    { type: 'stdin-data', stdinSessionId: 'session', bytes: 'Ada' },
    { type: 'stdin-data', stdinSessionId: 'session', bytes: new Uint8Array() },
    {
      type: 'stdin-data',
      stdinSessionId: 'session',
      bytes: new Uint8Array(INTERACTIVE_STDIN_CHUNK_MAX_BYTES + 1),
    },
    { type: 'stdin-eof', stdinSessionId: 'session', bytes: new Uint8Array() },
  ];

  for (const message of cases) {
    const result = validateStdinMessage(message);
    assert.equal(result.ok, false);
    assert.match(result.error, /stdin/i);
  }
});

test('e2e: worker run contract rejects buffered stdin entirely', () => {
  const result = validateRunRequest(interactiveRequest({
    stdinMode: 'buffered',
    sharedBuffer: undefined,
    stdinBuffer: new Uint8Array([1]),
  }));

  assert.equal(result.ok, false);
  assert.match(result.error, /stdin/i);
});

test('e2e: worker run contract rejects invalid binary and VFS byte fields', () => {
  const invalidBinary = validateRunRequest(interactiveRequest({ binaryBytes: 'wasm' }));
  assert.equal(invalidBinary.ok, false);
  assert.match(invalidBinary.error, /binaryBytes/);

  const invalidVfs = validateRunRequest(interactiveRequest({
    vfsFiles: [{ path: 'input.txt', bytes: [1, 2] }],
  }));
  assert.equal(invalidVfs.ok, false);
  assert.match(invalidVfs.error, /vfsFiles/);
});
