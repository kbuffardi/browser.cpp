import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createStdinSessionRouter,
  createWasiImports,
  invokeWasiStart,
  supportsJspi,
} from '../src/workers/jspi-stdin.mjs';
import {
  collectBrowserCapabilities,
  createBrowserCompatibilityReport,
  selectStdinTransport,
} from '../src/ui/browser-capabilities.mjs';
import { createWasiRuntime } from '../src/workers/wasi-shim.mjs';

function jspiRoot() {
  return {
    WebAssembly: {
      Suspending: function Suspending(fn) {
        const wrapped = (...args) => fn(...args);
        wrapped.suspending = true;
        return wrapped;
      },
      promising(fn) {
        return async (...args) => fn(...args);
      },
    },
  };
}

test('e2e: JSPI support requires both WebAssembly integration functions', () => {
  assert.equal(supportsJspi(jspiRoot()), true);
  assert.equal(supportsJspi({ WebAssembly: { Suspending() {} } }), false);
  assert.equal(supportsJspi({ WebAssembly: { promising() {} } }), false);
  assert.equal(supportsJspi({}), false);
});

test('e2e: JSPI wraps only the asynchronous WASI fd_read import', async () => {
  const root = jspiRoot();
  const wasi = {
    fd_read: async () => 0,
    fd_write: () => 0,
  };

  const imports = createWasiImports(wasi, root);

  assert.notEqual(imports, wasi);
  assert.equal(imports.fd_read.suspending, true);
  assert.equal(await imports.fd_read(), 0);
  assert.equal(imports.fd_write, wasi.fd_write);
});

test('e2e: JSPI invokes the WASI entry point through WebAssembly.promising', async () => {
  const events = [];
  const root = jspiRoot();
  const instance = {
    exports: {
      _start() {
        events.push('start');
        return 42;
      },
    },
  };

  const result = await invokeWasiStart(instance, root);

  assert.equal(result, 42);
  assert.deepEqual(events, ['start']);
});

test('e2e: JSPI helpers reject use when the runtime capability is absent', async () => {
  const unsupportedRoot = { WebAssembly: {} };
  assert.throws(
    () => createWasiImports({ fd_read() {} }, unsupportedRoot),
    /JSPI is unavailable/
  );
  await assert.rejects(
    () => invokeWasiStart({ exports: { _start() {} } }, unsupportedRoot),
    /JSPI is unavailable/
  );
});

test('e2e: Firefox 153 reports JSPI potential but waits for worker confirmation', () => {
  const capabilities = collectBrowserCapabilities({
    navigator: { userAgent: 'Mozilla/5.0 Firefox/153.0' },
    browser: { runtime: { getURL() {} }, storage: { local: {} } },
    Worker() {},
    WebAssembly: {
      instantiate() {},
      Suspending() {},
      promising() {},
    },
    Atomics: {},
    crossOriginIsolated: false,
  });

  assert.equal(capabilities.jspi, true);
  assert.equal(capabilities.jspiPotentialInteractiveStdin, true);
  assert.equal(capabilities.interactiveStdin, false);
  assert.equal(capabilities.stdinMode, 'unsupported');
  assert.equal(selectStdinTransport(capabilities, { jspi: false }), 'unsupported');
  assert.equal(selectStdinTransport(capabilities, { jspi: true }), 'message-jspi');

  const negotiatedReport = createBrowserCompatibilityReport({
    navigator: { userAgent: 'Mozilla/5.0 Firefox/153.0' },
    browser: { runtime: { getURL() {} }, storage: { local: {} } },
    Worker() {},
    WebAssembly: { instantiate() {}, Suspending() {}, promising() {} },
    Atomics: {},
    crossOriginIsolated: false,
  }, { jspi: true });
  assert.equal(negotiatedReport.capabilities.interactiveStdin, true);
  assert.equal(negotiatedReport.capabilities.stdinMode, 'interactive-message');
  assert.equal(
    negotiatedReport.limitations.some((item) => item.key === 'limitedInteractiveStdin'),
    false
  );

  const workerOnlyReport = createBrowserCompatibilityReport({
    navigator: { userAgent: 'Mozilla/5.0 Firefox/153.0' },
    browser: { runtime: { getURL() {} }, storage: { local: {} } },
    Worker() {},
    WebAssembly: { instantiate() {} },
    Atomics: {},
    crossOriginIsolated: false,
  }, { jspi: true });
  assert.equal(workerOnlyReport.capabilities.jspi, false);
  assert.equal(workerOnlyReport.capabilities.interactiveStdin, true);
});

test('e2e: stdin selection keeps Chromium SharedArrayBuffer first and gates older Firefox', () => {
  const chromium = {
    browserFamily: 'chromium',
    firefoxMajor: null,
    sharedBufferInteractiveStdin: true,
  };
  assert.equal(selectStdinTransport(chromium, { jspi: true }), 'shared-buffer');

  const firefox152 = {
    browserFamily: 'firefox',
    firefoxMajor: 152,
    sharedBufferInteractiveStdin: false,
  };
  assert.equal(selectStdinTransport(firefox152, { jspi: true }), 'unsupported');
});

test('e2e: stdin session routing ignores late messages from previous runs', () => {
  const diagnostics = [];
  const firstCalls = [];
  const secondCalls = [];
  const router = createStdinSessionRouter((message) => diagnostics.push(message));
  const fakeRuntime = (calls) => {
    let ended = false;
    return {
      pushStdin(bytes) {
        if (ended) return false;
        calls.push(['data', ...bytes]);
        return true;
      },
      endStdin() {
        if (ended) return false;
        ended = true;
        calls.push(['eof']);
        return true;
      },
    };
  };
  const firstRuntime = fakeRuntime(firstCalls);
  const secondRuntime = fakeRuntime(secondCalls);

  router.activate('first', firstRuntime);
  assert.equal(router.route({
    type: 'stdin-data',
    sessionId: 'first',
    bytes: new Uint8Array([1]),
  }), true);
  router.activate('second', secondRuntime);
  assert.equal(router.route({ type: 'stdin-eof', sessionId: 'first' }), false);
  assert.equal(router.route({ type: 'stdin-eof', sessionId: 'second' }), true);
  assert.equal(router.route({
    type: 'stdin-data',
    sessionId: 'second',
    bytes: new Uint8Array([2]),
  }), false);
  router.clear(secondRuntime);
  assert.equal(router.route({
    type: 'stdin-data',
    sessionId: 'second',
    bytes: new Uint8Array([2]),
  }), false);

  assert.deepEqual(firstCalls, [['data', 1]]);
  assert.deepEqual(secondCalls, [['eof']]);
  assert.equal(diagnostics.length, 3);
});

test('e2e: JSPI flow prints prompts before each suspended line read and resumes on EOF', async () => {
  const root = jspiRoot();
  const runtime = createWasiRuntime({ stdin: { mode: 'interactive-message' } });
  const memory = { buffer: new ArrayBuffer(512) };
  runtime.setMemory(memory);
  const view = new DataView(memory.buffer);
  const iovsPtr = 16;
  const nreadPtr = 8;
  const inputPtr = 128;
  view.setUint32(iovsPtr, inputPtr, true);
  view.setUint32(iovsPtr + 4, 32, true);

  const imports = createWasiImports(runtime.wasi, root);
  const events = [];
  let signalSecondRead;
  const secondReadStarted = new Promise((resolve) => { signalSecondRead = resolve; });
  const instance = {
    exports: {
      async _start() {
        events.push('prompt:name');
        await imports.fd_read(0, iovsPtr, 1, nreadPtr);
        const firstLength = view.getUint32(nreadPtr, true);
        events.push(new TextDecoder().decode(
          new Uint8Array(memory.buffer, inputPtr, firstLength)
        ));

        events.push('prompt:age');
        signalSecondRead();
        await imports.fd_read(0, iovsPtr, 1, nreadPtr);
        events.push(`eof:${view.getUint32(nreadPtr, true)}`);
      },
    },
  };

  const execution = invokeWasiStart(instance, root);
  await Promise.resolve();
  assert.deepEqual(events, ['prompt:name']);

  runtime.pushStdin(new TextEncoder().encode('Ada\n'));
  await secondReadStarted;
  assert.deepEqual(events, ['prompt:name', 'Ada\n', 'prompt:age']);

  runtime.endStdin();
  await execution;
  assert.deepEqual(events, ['prompt:name', 'Ada\n', 'prompt:age', 'eof:0']);
});
