import test from 'node:test';
import assert from 'node:assert/strict';

import { validateRunRequest } from '../src/workers/run-request.mjs';

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

  const buffered = validateRunRequest(interactiveRequest({
    stdinMode: 'buffered',
    sharedBuffer: undefined,
    stdinBuffer: new TextEncoder().encode('Ada\n41\n').buffer,
  }));
  assert.equal(buffered.ok, true);
  assert.equal(buffered.value.stdin.mode, 'buffered');
  assert.deepEqual(
    [...buffered.value.stdin.bytes],
    [...new TextEncoder().encode('Ada\n41\n')]
  );

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
    interactiveRequest({ stdinMode: 'unknown' }),
  ];

  for (const request of cases) {
    const result = validateRunRequest(request);
    assert.equal(result.ok, false);
    assert.match(result.error, /stdin/i);
  }
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
