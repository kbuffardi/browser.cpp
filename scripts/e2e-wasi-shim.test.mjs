import test from 'node:test';
import assert from 'node:assert/strict';

import { createWasiRuntime } from '../src/workers/wasi-shim.mjs';

function makeRuntime(stdin = { mode: 'interactive', sharedBuffer: new SharedArrayBuffer(8 + 32) }) {
  const writes = [];
  const runtime = createWasiRuntime({
    stdin,
    onStdout: (text) => writes.push(['stdout', text]),
    onStderr: (text) => writes.push(['stderr', text]),
  });

  runtime.setMemory({ buffer: new ArrayBuffer(1024) });
  return { runtime, writes };
}

function configureRead(memory, spans, iovsPtr = 16, nreadPtr = 8) {
  const dv = new DataView(memory.buffer);
  spans.forEach(({ base, len }, index) => {
    dv.setUint32(iovsPtr + (index * 8), base, true);
    dv.setUint32(iovsPtr + (index * 8) + 4, len, true);
  });
  return { iovsPtr, nreadPtr, iovsLen: spans.length };
}

function readStdin(runtime, spans) {
  const memory = runtime.getMemoryForTesting();
  const request = configureRead(memory, spans);
  const errno = runtime.wasi.fd_read(0, request.iovsPtr, request.iovsLen, request.nreadPtr);
  const nread = new DataView(memory.buffer).getUint32(request.nreadPtr, true);
  return { errno, nread, bytes: new Uint8Array(memory.buffer) };
}

async function readStdinAsync(runtime, spans) {
  const memory = runtime.getMemoryForTesting();
  const request = configureRead(memory, spans);
  const errno = await runtime.wasi.fd_read(
    0,
    request.iovsPtr,
    request.iovsLen,
    request.nreadPtr
  );
  const nread = new DataView(memory.buffer).getUint32(request.nreadPtr, true);
  return { errno, nread, bytes: new Uint8Array(memory.buffer) };
}

function writeString(memory, ptr, text) {
  const bytes = new TextEncoder().encode(text);
  new Uint8Array(memory.buffer).set(bytes, ptr);
  return bytes.length;
}

test('e2e: wasi shim drains buffered stdin across iovecs and repeated reads', () => {
  const input = new TextEncoder().encode('Ada\n41');
  const { runtime } = makeRuntime({ mode: 'buffered', bytes: input });

  const first = readStdin(runtime, [
    { base: 128, len: 2 },
    { base: 160, len: 3 },
  ]);
  assert.equal(first.errno, 0);
  assert.equal(first.nread, 5);
  assert.equal(new TextDecoder().decode(first.bytes.subarray(128, 130)), 'Ad');
  assert.equal(new TextDecoder().decode(first.bytes.subarray(160, 163)), 'a\n4');

  const second = readStdin(runtime, [{ base: 192, len: 8 }]);
  assert.equal(second.errno, 0);
  assert.equal(second.nread, 1);
  assert.equal(new TextDecoder().decode(second.bytes.subarray(192, 193)), '1');

  const eof = readStdin(runtime, [{ base: 224, len: 8 }]);
  assert.equal(eof.errno, 0);
  assert.equal(eof.nread, 0);
});

test('e2e: wasi shim preserves UTF-8 bytes and input without a trailing newline', () => {
  const input = new TextEncoder().encode('Grüße');
  const { runtime } = makeRuntime({ mode: 'buffered', bytes: input });

  const result = readStdin(runtime, [{ base: 128, len: 32 }]);

  assert.equal(result.errno, 0);
  assert.equal(result.nread, input.length);
  assert.deepEqual(
    [...result.bytes.subarray(128, 128 + result.nread)],
    [...input]
  );
});

test('e2e: wasi shim returns immediate EOF for empty buffered and none stdin', () => {
  for (const stdin of [
    { mode: 'buffered', bytes: new Uint8Array() },
    { mode: 'none' },
  ]) {
    const { runtime } = makeRuntime(stdin);
    const result = readStdin(runtime, [{ base: 128, len: 8 }]);
    assert.equal(result.errno, 0);
    assert.equal(result.nread, 0);
  }
});

test('e2e: wasi shim suspends message stdin until data arrives', async () => {
  const { runtime } = makeRuntime({ mode: 'interactive-message' });
  const pendingRead = readStdinAsync(runtime, [
    { base: 128, len: 2 },
    { base: 160, len: 4 },
  ]);

  runtime.pushStdin(new TextEncoder().encode('Ada\n'));
  const result = await pendingRead;

  assert.equal(result.errno, 0);
  assert.equal(result.nread, 4);
  assert.equal(new TextDecoder().decode(result.bytes.subarray(128, 130)), 'Ad');
  assert.equal(new TextDecoder().decode(result.bytes.subarray(160, 162)), 'a\n');
});

test('e2e: wasi shim drains queued message stdin before reporting EOF', async () => {
  const { runtime } = makeRuntime({ mode: 'interactive-message' });
  runtime.pushStdin(new TextEncoder().encode('42'));
  runtime.endStdin();

  const data = await readStdinAsync(runtime, [{ base: 128, len: 8 }]);
  assert.equal(data.errno, 0);
  assert.equal(data.nread, 2);
  assert.equal(new TextDecoder().decode(data.bytes.subarray(128, 130)), '42');

  const eof = await readStdinAsync(runtime, [{ base: 160, len: 8 }]);
  assert.equal(eof.errno, 0);
  assert.equal(eof.nread, 0);
});

test('e2e: wasi shim returns immediately for a zero-length message stdin read', async () => {
  const { runtime } = makeRuntime({ mode: 'interactive-message' });
  const result = await readStdinAsync(runtime, [{ base: 128, len: 0 }]);

  assert.equal(result.errno, 0);
  assert.equal(result.nread, 0);
});

test('e2e: wasi shim drains long buffered input without truncation', () => {
  const input = new Uint8Array(32 * 1024);
  input.forEach((_, index) => { input[index] = index % 251; });
  const { runtime } = makeRuntime({ mode: 'buffered', bytes: input });
  const memory = { buffer: new ArrayBuffer(64 * 1024) };
  runtime.setMemory(memory);

  const result = readStdin(runtime, [{ base: 1024, len: input.length }]);

  assert.equal(result.nread, input.length);
  assert.deepEqual(
    result.bytes.subarray(1024, 1024 + input.length),
    input
  );
});

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
