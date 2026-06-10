/**
 * src/workers/compiler.worker.js
 *
 * Web Worker that hosts the Emscripten-compiled Clang WASM binary.
 * It exposes a simple message-passing API consumed by toolbar.js:
 *
 *  Inbound messages (from main thread):
 *    { type: 'compile', source: string, flags: string[] }
 *    { type: 'run',     stdin:  string }
 *    { type: 'status'  }
 *
 *  Outbound messages (to main thread):
 *    { type: 'compiler-loading',  progress: 0-100 }
 *    { type: 'compiler-ready'   }
 *    { type: 'compiler-error',   message: string }
 *    { type: 'compile-start'    }
 *    { type: 'compile-result',   success: bool, diagnostics: string }
 *    { type: 'run-start'        }
 *    { type: 'stdout',           data: string }
 *    { type: 'stderr',           data: string }
 *    { type: 'run-result',       exitCode: number }
 *    { type: 'status-reply',     state: string }
 */

'use strict';

// ── State ────────────────────────────────────────────────────────────────────

/** @type {'unloaded'|'loading'|'ready'|'error'} */
let compilerState = 'unloaded';

/**
 * The Emscripten Module object once loaded.
 * @type {object|null}
 */
let ClangModule = null;

/**
 * Raw bytes of the last successfully compiled WASM binary.
 * @type {Uint8Array|null}
 */
let compiledBinary = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function send(msg) {
  self.postMessage(msg);
}

/**
 * Resolve a URL relative to this worker script's location.
 * Works whether the script is served from an extension URL or localhost.
 */
function workerRelativeUrl(file) {
  const base = self.location.href.replace(/\/[^/]+$/, '/');
  return base + file;
}

// ── Compiler loader ──────────────────────────────────────────────────────────

/**
 * Load the Emscripten-compiled Clang into this worker.
 * Expects dist/clang/clang.js and dist/clang/clang.wasm to be present.
 * Call npm run fetch-clang once to download those files.
 */
async function loadCompiler() {
  if (compilerState === 'ready') return true;
  if (compilerState === 'loading') return false; // already in progress

  compilerState = 'loading';
  send({ type: 'compiler-loading', progress: 0 });

  const jsUrl   = workerRelativeUrl('clang/clang.js');
  const wasmUrl = workerRelativeUrl('clang/clang.wasm');

  // Quick probe to give a clear error if the binary is missing
  try {
    const probe = await fetch(wasmUrl, { method: 'HEAD' });
    if (!probe.ok) {
      throw new Error(
        `clang.wasm not found at ${wasmUrl}.\n` +
        'Run:  npm run fetch-clang  then rebuild the extension.'
      );
    }
  } catch (err) {
    compilerState = 'error';
    send({ type: 'compiler-error', message: err.message });
    return false;
  }

  send({ type: 'compiler-loading', progress: 10 });

  // Load the Emscripten JS glue.  Two formats exist in the wild:
  //
  //   Classic (importScripts-compatible):
  //     Built without -s EXPORT_ES6.  Sets a global (e.g. self.Module or
  //     self.createClangModule) when the script runs.
  //
  //   ES6 module (built with -s EXPORT_ES6 -s MODULARIZE):
  //     Exports a default factory function.  Requires dynamic import().
  //     Example: the "browsercc" NPM package (LLVM 20).
  //
  // We try importScripts first and fall back to dynamic import so that either
  // format works without any manual configuration.

  let es6Factory = null;

  try {
    importScripts(jsUrl);
  } catch (classicErr) {
    // importScripts throws for ES6 modules — try dynamic import instead.
    try {
      const mod = await import(jsUrl);
      if (typeof mod.default === 'function') {
        es6Factory = mod.default;
      } else if (mod.default && typeof mod.default === 'object') {
        // Pre-initialized ES6 module object — use directly.
        ClangModule = mod.default;
      } else {
        throw new Error(`Unexpected default export in clang.js: ${typeof mod.default}`);
      }
    } catch (esErr) {
      compilerState = 'error';
      send({
        type: 'compiler-error',
        message: `Failed to load clang.js: ${classicErr.message} / ${esErr.message}`,
      });
      return false;
    }
  }

  send({ type: 'compiler-loading', progress: 30 });

  // Resolve which factory / module object to use.
  //
  // Priority:
  //  1. ES6 default export factory  (dynamic import path above, EXPORT_ES6)
  //  2. self.createClangModule       (classic, -s EXPORT_NAME=createClangModule)
  //  3. self.Module as a function    (classic, -s MODULARIZE=1, default name)
  //  4. ClangModule already set      (ES6 default export was a plain object)
  //  5. self.Module as plain object  (classic, no MODULARIZE — already live)

  if (!ClangModule) {
    const factory =
      es6Factory ||
      (typeof self['createClangModule'] === 'function' ? self['createClangModule'] : null) ||
      (typeof self['Module'] === 'function'            ? self['Module']            : null);

    const preInit =
      !factory && typeof self['Module'] === 'object' && self['Module'] !== null
        ? self['Module']
        : null;

    if (!factory && !preInit) {
      compilerState = 'error';
      send({
        type: 'compiler-error',
        message:
          'Emscripten module not found in clang.js. ' +
          'Build clang.js with -s MODULARIZE=1 -s EXPORT_NAME=createClangModule ' +
          '(see README § "Building Clang WASM from source").',
      });
      return false;
    }

    try {
      if (preInit) {
        // Non-modularized build: Module is already the live Emscripten object.
        ClangModule = preInit;
      } else {
        ClangModule = await factory({
          locateFile: (file) => workerRelativeUrl(`clang/${file}`),
          onRuntimeInitialized() {
            send({ type: 'compiler-loading', progress: 90 });
          },
          // Suppress Emscripten's default console output; we capture it per-call
          print:    () => {},
          printErr: () => {},
        });
      }
    } catch (err) {
      compilerState = 'error';
      send({ type: 'compiler-error', message: `Clang init failed: ${err.message}` });
      return false;
    }
  }

  compilerState = 'ready';
  send({ type: 'compiler-loading', progress: 100 });
  send({ type: 'compiler-ready' });
  return true;
}

// ── Compile ──────────────────────────────────────────────────────────────────

/**
 * Compile C++ source using the in-WASM Clang.
 *
 * @param {string}   source  – C++ source text
 * @param {string[]} flags   – extra compiler flags (e.g. ['-O2'])
 * @param {string}   std     – C++ standard (e.g. 'c++20')
 * @returns {{ success: boolean, diagnostics: string }}
 */
async function compile(source, flags = [], std = 'c++20') {
  if (!await ensureReady()) return { success: false, diagnostics: 'Compiler not ready.' };

  const FS = ClangModule.FS;

  // Write the source file to the virtual filesystem
  FS.writeFile('/input.cpp', source);
  compiledBinary = null;

  // Remove any stale output
  try { FS.unlink('/output.wasm'); } catch (_) {}

  // Build the Clang invocation
  const args = [
    `-std=${std}`,
    '-Wall',
    '-Wextra',
    '--target=wasm32-wasi',
    '-nostartfiles',
    ...flags,
    '-o', '/output.wasm',
    '/input.cpp',
  ];

  let stdout = '';
  let stderr = '';
  const savedPrint    = ClangModule.print;
  const savedPrintErr = ClangModule.printErr;
  ClangModule.print    = (s) => { stdout += s + '\n'; };
  ClangModule.printErr = (s) => { stderr += s + '\n'; };

  let exitCode = 0;
  try {
    // callMain(args) – note: Emscripten takes args WITHOUT argv[0]
    exitCode = ClangModule.callMain(args);
  } catch (e) {
    if (e && e.name === 'ExitStatus') {
      exitCode = e.status;
    } else {
      throw e;
    }
  } finally {
    ClangModule.print    = savedPrint;
    ClangModule.printErr = savedPrintErr;
  }

  const diagnostics = (stdout + stderr).trim();

  if (exitCode !== 0) {
    return { success: false, diagnostics };
  }

  // Read the compiled WASM binary from the virtual FS
  try {
    compiledBinary = FS.readFile('/output.wasm');
  } catch (_) {
    return {
      success: false,
      diagnostics: diagnostics || 'Compiler produced no output binary.',
    };
  }

  return { success: true, diagnostics };
}

// ── WASI shim ─────────────────────────────────────────────────────────────────

/**
 * Minimal WASI "snapshot_preview1" implementation sufficient for running
 * C++ programs that use cout/cin/cerr, command-line args, and proc_exit.
 *
 * Reference: https://github.com/WebAssembly/WASI/blob/main/phases/snapshot/docs.md
 */
function createWASIImports({ stdinBytes, onStdout, onStderr }) {
  // We capture the memory reference after instantiation via a closure cell
  let memory = null;
  const setMemory = (m) => { memory = m; };

  const view = () => new DataView(memory.buffer);
  const u8   = () => new Uint8Array(memory.buffer);

  let stdinPos = 0;

  // Decode iovs (iov_base, iov_len) pairs from memory
  function iovSpans(iovsPtr, iovsLen) {
    const spans = [];
    const dv = view();
    for (let i = 0; i < iovsLen; i++) {
      const base = dv.getUint32(iovsPtr + i * 8,     true);
      const len  = dv.getUint32(iovsPtr + i * 8 + 4, true);
      spans.push({ base, len });
    }
    return spans;
  }

  const wasi = {
    // Called by the module to pass its memory reference to us
    _setMemory: setMemory,

    // fd_write(fd, iovs_ptr, iovs_len, nwritten_ptr) → errno
    fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
      const spans = iovSpans(iovsPtr, iovsLen);
      let total = 0;
      for (const { base, len } of spans) {
        const bytes = u8().subarray(base, base + len);
        const text  = new TextDecoder().decode(bytes);
        if (fd === 1) onStdout(text);
        else if (fd === 2) onStderr(text);
        total += len;
      }
      view().setUint32(nwrittenPtr, total, true);
      return 0; // __WASI_ERRNO_SUCCESS
    },

    // fd_read(fd, iovs_ptr, iovs_len, nread_ptr) → errno
    fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
      if (fd !== 0) {
        view().setUint32(nreadPtr, 0, true);
        return 8; // __WASI_ERRNO_BADF
      }
      const spans = iovSpans(iovsPtr, iovsLen);
      let total = 0;
      for (const { base, len } of spans) {
        const available = stdinBytes.length - stdinPos;
        const toRead    = Math.min(len, available);
        if (toRead === 0) break;
        u8().set(stdinBytes.subarray(stdinPos, stdinPos + toRead), base);
        stdinPos += toRead;
        total    += toRead;
      }
      view().setUint32(nreadPtr, total, true);
      return 0;
    },

    // proc_exit(code) → never
    proc_exit(code) {
      throw { __wasi_exit__: true, code };
    },

    // environ_sizes_get(count_ptr, buf_size_ptr) → errno
    environ_sizes_get(countPtr, bufSizePtr) {
      view().setUint32(countPtr, 0, true);
      view().setUint32(bufSizePtr, 0, true);
      return 0;
    },

    // environ_get(environ_ptr, environ_buf_ptr) → errno
    environ_get() { return 0; },

    // args_sizes_get(argc_ptr, argv_buf_size_ptr) → errno
    args_sizes_get(argcPtr, argvBufSizePtr) {
      // Expose a single argv[0] = "./a.out"
      const arg0 = './a.out\0';
      view().setUint32(argcPtr, 1, true);
      view().setUint32(argvBufSizePtr, arg0.length, true);
      return 0;
    },

    // args_get(argv_ptr, argv_buf_ptr) → errno
    args_get(argvPtr, argvBufPtr) {
      const enc = new TextEncoder();
      const arg0 = enc.encode('./a.out\0');
      u8().set(arg0, argvBufPtr);
      view().setUint32(argvPtr, argvBufPtr, true);
      return 0;
    },

    // fd_close(fd) → errno
    fd_close() { return 0; },

    // fd_seek(fd, offset_lo, offset_hi, whence, newoffset_ptr) → errno
    fd_seek() { return 70; }, // __WASI_ERRNO_SPIPE

    // fd_fdstat_get(fd, stat_ptr) → errno
    fd_fdstat_get(fd, statPtr) {
      // Return a minimal fdstat for fd 0/1/2
      if (fd > 2) return 8; // BADF
      const dv = view();
      dv.setUint8(statPtr,   2);   // filetype = CHARACTER_DEVICE
      dv.setUint8(statPtr+1, 0);
      dv.setUint32(statPtr+2, 0, true); // fdflags
      // rights fields (8 bytes each) – grant all
      dv.setBigUint64(statPtr+8,  0xFFFFFFFFFFFFFFFFn, true);
      dv.setBigUint64(statPtr+16, 0xFFFFFFFFFFFFFFFFn, true);
      return 0;
    },

    // clock_time_get(id, precision, time_ptr) → errno
    // Note: Date.now() has millisecond resolution; WASI expects nanoseconds.
    // The multiplication gives correct units but not sub-millisecond precision,
    // which is acceptable for typical C++ programs using std::chrono.
    clock_time_get(_id, _prec, timePtr) {
      const ns = BigInt(Date.now()) * BigInt(1000000);
      view().setBigUint64(timePtr, ns, true);
      return 0;
    },

    // random_get(buf_ptr, buf_len) → errno
    random_get(bufPtr, bufLen) {
      const buf = u8().subarray(bufPtr, bufPtr + bufLen);
      self.crypto.getRandomValues(buf);
      return 0;
    },
  };

  return { wasi, setMemory };
}

// ── Run ──────────────────────────────────────────────────────────────────────

/**
 * Instantiate and execute the compiled WASM binary with a minimal WASI shim.
 *
 * @param {string} stdinText  – text piped to stdin
 */
async function run(stdinText = '') {
  if (!compiledBinary) {
    send({ type: 'stderr', data: 'No compiled binary. Please compile first.\n' });
    send({ type: 'run-result', exitCode: 1 });
    return;
  }

  const stdinBytes = new TextEncoder().encode(stdinText);

  let exitCode = 0;

  const { wasi, setMemory } = createWASIImports({
    stdinBytes,
    onStdout: (text) => send({ type: 'stdout', data: text }),
    onStderr: (text) => send({ type: 'stderr', data: text }),
  });

  try {
    const { instance } = await WebAssembly.instantiate(compiledBinary, {
      wasi_snapshot_preview1: wasi,
    });

    // Give the WASI shim access to the module's memory
    setMemory(instance.exports.memory);

    // WASI entry point
    instance.exports._start();
  } catch (e) {
    if (e && e.__wasi_exit__) {
      exitCode = e.code;
    } else if (e instanceof WebAssembly.RuntimeError) {
      send({ type: 'stderr', data: `Runtime error: ${e.message}\n` });
      exitCode = 134; // SIGABRT equivalent
    } else {
      send({ type: 'stderr', data: `Unexpected error: ${String(e)}\n` });
      exitCode = 1;
    }
  }

  send({ type: 'run-result', exitCode });
}

// ── ensure ready helper ───────────────────────────────────────────────────────

async function ensureReady() {
  if (compilerState === 'ready') return true;
  if (compilerState === 'unloaded') return loadCompiler();
  return false;
}

// ── Message handler ──────────────────────────────────────────────────────────

self.onmessage = async ({ data }) => {
  switch (data.type) {
    case 'load':
      await loadCompiler();
      break;

    case 'compile':
      send({ type: 'compile-start' });
      try {
        const result = await compile(data.source, data.flags || [], data.std || 'c++20');
        send({ type: 'compile-result', ...result });
      } catch (err) {
        send({ type: 'compile-result', success: false, diagnostics: String(err) });
      }
      break;

    case 'run':
      send({ type: 'run-start' });
      await run(data.stdin || '');
      break;

    case 'status':
      send({ type: 'status-reply', state: compilerState });
      break;

    default:
      console.warn('[compiler.worker] Unknown message type:', data.type);
  }
};

// Kick off loading immediately so the compiler is warm by the time the user clicks Run
loadCompiler();
