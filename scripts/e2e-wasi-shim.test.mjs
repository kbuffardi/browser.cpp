import test from 'node:test';
import assert from 'node:assert/strict';

import { createWasiRuntime } from '../src/workers/wasi-shim.mjs';

function makeRuntime() {
  const sharedBuffer = new SharedArrayBuffer(8 + 32);
  const writes = [];
  const runtime = createWasiRuntime({
    sharedBuffer,
    onStdout: (text) => writes.push(['stdout', text]),
    onStderr: (text) => writes.push(['stderr', text]),
  });

  runtime.setMemory({ buffer: new ArrayBuffer(1024) });
  return { runtime, writes };
}

function writeString(memory, ptr, text) {
  const bytes = new TextEncoder().encode(text);
  new Uint8Array(memory.buffer).set(bytes, ptr);
  return bytes.length;
}

test('e2e: wasi shim exposes callable fd_fdstat_set_flags', () => {
  const { runtime } = makeRuntime();
  assert.equal(typeof runtime.wasi.fd_fdstat_set_flags, 'function');
});

test('e2e: wasi shim rejects fd_fdstat_set_flags on invalid descriptors', () => {
  const { runtime } = makeRuntime();
  assert.equal(runtime.wasi.fd_fdstat_set_flags(99, 0), 8);
});

test('e2e: wasi shim preserves append semantics for fstream-style writes', () => {
  const { runtime } = makeRuntime();
  const memory = runtime.getMemoryForTesting();
  runtime.initRunVfs([{ path: 'log.txt', bytes: new TextEncoder().encode('hello') }]);

  const pathPtr = 16;
  const openedFdPtr = 64;
  const iovsPtr = 80;
  const dataPtr = 128;
  const pathLen = writeString(memory, pathPtr, 'log.txt');

  const openResult = runtime.wasi.path_open(3, 0, pathPtr, pathLen, 0, 0n, 0n, 0, openedFdPtr);
  assert.equal(openResult, 0);

  const fd = new DataView(memory.buffer).getUint32(openedFdPtr, true);
  assert.equal(runtime.wasi.fd_fdstat_set_flags(fd, 1), 0);

  const appendedLen = writeString(memory, dataPtr, '!');
  const dv = new DataView(memory.buffer);
  dv.setUint32(iovsPtr, dataPtr, true);
  dv.setUint32(iovsPtr + 4, appendedLen, true);

  assert.equal(runtime.wasi.fd_write(fd, iovsPtr, 1, openedFdPtr), 0);
  assert.equal(runtime.wasi.fd_close(fd), 0);

  const changes = runtime.getDirtyVfsFiles();
  assert.equal(changes.length, 1);
  assert.equal(new TextDecoder().decode(changes[0].bytes), 'hello!');
});

test('e2e: wasi shim creates and persists a new file opened for output', () => {
  const { runtime } = makeRuntime();
  const memory = runtime.getMemoryForTesting();
  runtime.initRunVfs([]);

  const pathPtr = 16;
  const openedFdPtr = 64;
  const iovsPtr = 80;
  const dataPtr = 128;
  const pathLen = writeString(memory, pathPtr, 'created.txt');

  const OFLAGS_CREAT = 0x0001;
  const openResult = runtime.wasi.path_open(3, 0, pathPtr, pathLen, OFLAGS_CREAT, 0n, 0n, 0, openedFdPtr);
  assert.equal(openResult, 0);

  const fd = new DataView(memory.buffer).getUint32(openedFdPtr, true);
  const createdLen = writeString(memory, dataPtr, 'new data');
  const dv = new DataView(memory.buffer);
  dv.setUint32(iovsPtr, dataPtr, true);
  dv.setUint32(iovsPtr + 4, createdLen, true);

  assert.equal(runtime.wasi.fd_write(fd, iovsPtr, 1, openedFdPtr), 0);
  assert.equal(runtime.wasi.fd_close(fd), 0);

  const changes = runtime.getDirtyVfsFiles();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, 'created.txt');
  assert.equal(new TextDecoder().decode(changes[0].bytes), 'new data');
});

test('e2e: wasi shim creates a missing file opened with write rights', () => {
  const { runtime } = makeRuntime();
  const memory = runtime.getMemoryForTesting();
  runtime.initRunVfs([]);

  const pathPtr = 16;
  const openedFdPtr = 64;
  const iovsPtr = 80;
  const dataPtr = 128;
  const pathLen = writeString(memory, pathPtr, 'output.txt');

  const RIGHTS_FD_WRITE = 1n << 6n;
  const openResult = runtime.wasi.path_open(3, 0, pathPtr, pathLen, 0, RIGHTS_FD_WRITE, 0n, 0, openedFdPtr);
  assert.equal(openResult, 0);

  const fd = new DataView(memory.buffer).getUint32(openedFdPtr, true);
  const outputLen = writeString(memory, dataPtr, '42\n');
  const dv = new DataView(memory.buffer);
  dv.setUint32(iovsPtr, dataPtr, true);
  dv.setUint32(iovsPtr + 4, outputLen, true);

  assert.equal(runtime.wasi.fd_write(fd, iovsPtr, 1, openedFdPtr), 0);
  assert.equal(runtime.wasi.fd_close(fd), 0);

  const changes = runtime.getDirtyVfsFiles();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, 'output.txt');
  assert.equal(new TextDecoder().decode(changes[0].bytes), '42\n');
});

test('e2e: wasi shim does not create a missing read-only file', () => {
  const { runtime } = makeRuntime();
  const memory = runtime.getMemoryForTesting();
  runtime.initRunVfs([]);

  const pathPtr = 16;
  const openedFdPtr = 64;
  const pathLen = writeString(memory, pathPtr, 'missing.txt');

  const RIGHTS_FD_READ = 1n << 1n;
  const openResult = runtime.wasi.path_open(3, 0, pathPtr, pathLen, 0, RIGHTS_FD_READ, 0n, 0, openedFdPtr);
  assert.equal(openResult, 44);
  assert.deepEqual(runtime.getDirtyVfsFiles(), []);
});
