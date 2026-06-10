/**
 * src/workers/compiler.worker.js
 *
 * Web Worker that hosts the Emscripten-compiled Clang + LLD WASM binaries
 * (from the browsercc package).  It exposes a simple message-passing API
 * consumed by toolbar.js:
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
 *
 * Compilation pipeline (mirrors browsercc's index.ts):
 *   1. Fresh Clang instance  – run `clang++ -###` to get the exact -cc1 and
 *                              wasm-ld argument lists from the driver
 *   2. Fresh Clang instance  – run `clang++ -cc1 …` to compile to object file
 *   3. Fresh LLD  instance   – run `wasm-ld …` to link to a WASM binary
 *
 * A fresh instance is required for each step because the binaries are built
 * with `-s EXIT_RUNTIME`, which tears down the Emscripten runtime after
 * callMain() returns and makes the instance unusable for a second call.
 */

'use strict';

// ── State ────────────────────────────────────────────────────────────────────

/** @type {'unloaded'|'loading'|'ready'|'error'} */
let compilerState = 'unloaded';

/**
 * Factory function for the Clang Emscripten module (set after importScripts).
 * @type {Function|null}
 */
let clangFactory = null;

/**
 * Factory function for the LLD Emscripten module (set after importScripts).
 * @type {Function|null}
 */
let lldFactory = null;

/**
 * Contents of sysroot.tar (C/C++ stdlib headers + libraries), cached once.
 * @type {ArrayBuffer|null}
 */
let sysrootBuffer = null;

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
 * Load both Emscripten module factories (Clang + LLD) and fetch the sysroot.
 * This does NOT instantiate any module; fresh instances are created per compile.
 * Expects dist/clang/{clang.js,clang.wasm,lld.js,lld.wasm,sysroot.tar}.
 * Run  npm run fetch-clang  once to download those files.
 */
async function loadCompiler() {
  if (compilerState === 'ready') return true;
  if (compilerState === 'loading') return false; // already in progress

  compilerState = 'loading';
  send({ type: 'compiler-loading', progress: 0 });

  // Probe that all required runtime files are present
  const requiredFiles = ['clang/clang.wasm', 'clang/lld.wasm', 'clang/sysroot.tar'];
  for (const rel of requiredFiles) {
    const url = workerRelativeUrl(rel);
    try {
    const probe = await fetch(url, { method: 'HEAD' });
    if (!probe.ok) {
      throw new Error(
        `${rel} not found (HTTP ${probe.status}) at ${url}.\n` +
        'Run:  npm run fetch-clang  then rebuild the extension.'
      );
    }
    } catch (err) {
    compilerState = 'error';
    send({ type: 'compiler-error', message: err.message });
    return false;
    }
  }

  send({ type: 'compiler-loading', progress: 10 });

  // Load the Emscripten JS glue for both Clang and LLD via importScripts().
  // fetch-clang-wasm.js patches both files so they set self.createClangModule
  // and self.createLLDModule (respectively) instead of using ES6 export syntax.
  try {
    importScripts(
    workerRelativeUrl('clang/clang.js'),
    workerRelativeUrl('clang/lld.js'),
    );
  } catch (err) {
    compilerState = 'error';
    send({
    type: 'compiler-error',
    message:
      `Failed to load compiler scripts: ${err.message}\n` +
      'Run:  npm run fetch-clang  then reload the extension.',
    });
    return false;
  }

  send({ type: 'compiler-loading', progress: 30 });

  // Resolve factory functions injected by the patched scripts
  clangFactory = typeof self['createClangModule'] === 'function' ? self['createClangModule'] : null;
  lldFactory   = typeof self['createLLDModule']   === 'function' ? self['createLLDModule']   : null;

  if (!clangFactory || !lldFactory) {
    compilerState = 'error';
    send({
    type: 'compiler-error',
    message:
      'Compiler factory functions not found after loading clang.js / lld.js.\n' +
      'Re-run:  npm run fetch-clang  then  npm run build',
    });
    return false;
  }

  send({ type: 'compiler-loading', progress: 40 });

  // Fetch the sysroot (C/C++ standard library headers + libraries, ~29 MB).
  // Cached as an ArrayBuffer and extracted into each fresh module's virtual FS
  // at compile time.
  const sysrootUrl = workerRelativeUrl('clang/sysroot.tar');
  try {
    const resp = await fetch(sysrootUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    sysrootBuffer = await resp.arrayBuffer();
  } catch (err) {
    compilerState = 'error';
    send({ type: 'compiler-error', message: `Failed to load sysroot.tar: ${err.message}` });
    return false;
  }

  compilerState = 'ready';
  send({ type: 'compiler-loading', progress: 100 });
  send({ type: 'compiler-ready' });
  return true;
}

// ── TAR / sysroot utilities ───────────────────────────────────────────────────

/**
 * Yield every file entry in a POSIX ustar/GNU tar archive.
 * Ported from browsercc/index.ts (BertalanD/browsercc, MIT licence).
 *
 * @param {ArrayBuffer} buffer
 * @yields {{ name: string, content: Uint8Array }}
 */
function* tarContents(buffer) {
  const data = new Uint8Array(buffer);
  const dec  = new TextDecoder('utf-8');
  let offset = 0;

  while (offset + 512 <= data.length) {
    const header = data.slice(offset, offset + 512);
    const name   = dec.decode(header.slice(0, 100)).replace(/\0.*$/, '');
    if (!name) break; // two empty blocks signal end of archive

    const sizeStr = dec.decode(header.slice(124, 136)).replace(/\0.*$/, '').trim();
    const size    = parseInt(sizeStr, 8) || 0;

    const content = data.slice(offset + 512, offset + 512 + size);
    yield { name, content };

    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

/**
 * Extract the sysroot archive into an Emscripten module's virtual filesystem.
 * Ported from browsercc/index.ts.
 *
 * @param {object}      module    – Emscripten module instance
 * @param {ArrayBuffer} tarBuffer – contents of sysroot.tar
 */
function setUpSysroot(module, tarBuffer) {
  for (const { name, content } of tarContents(tarBuffer)) {
    if (name.endsWith('/')) continue; // directory entry – skip
    const dir = name.split('/').slice(0, -1).join('/');
    if (dir && !module.FS.analyzePath(dir).exists) {
    module.FS.mkdirTree(dir);
    }
    module.FS.writeFile(name, content);
  }
}

// ── callMain helper ───────────────────────────────────────────────────────────

/**
 * Invoke callMain and normalise the result.
 * Emscripten throws ExitStatus when the program calls exit(); we catch it and
 * return the numeric code so callers don't have to special-case it.
 *
 * @param {object}   module
 * @param {string[]} args
 * @returns {number} exit code
 */
function callMainSafe(module, args) {
  try {
    return module.callMain(args);
  } catch (e) {
    if (e && e.name === 'ExitStatus') return e.status;
    throw e;
  }
}

// ── Compiler invocation discovery ─────────────────────────────────────────────

/**
 * Ask the Clang driver which exact -cc1 and wasm-ld arguments it would use,
 * without actually compiling anything.  Uses the `-###` flag which prints the
 * subcommands to stderr and exits 0.
 *
 * Ported from browsercc/index.ts (getCompilerInvocation).
 *
 * @param {string}   fileName  – source file name as it appears in the FS
 * @param {string}   source    – source text
 * @param {string[]} flags     – user flags (e.g. ['-std=c++20', '-Wall'])
 * @returns {{ compilerArgs: string[], compilerArtifact: string,
 *             linkerArgs: string[],   linkerArtifact: string }}
 */
async function getCompilerInvocation(fileName, source, flags) {
  let stderr = '';
  const clang = await clangFactory({
    thisProgram: 'clang++',
    locateFile:  (f) => workerRelativeUrl(`clang/${f}`),
    print:    () => {},
    printErr: (s) => { stderr += s + '\n'; },
  });

  clang.FS.writeFile(fileName, source);

  // Minimal stub sysroot so the driver can resolve library/include paths
  clang.FS.mkdirTree('/lib/wasm32-wasi');
  clang.FS.mkdirTree('/include/c++/v1');
  clang.FS.writeFile('/lib/wasm32-wasi/crt1-command.o', new Uint8Array(0));
  clang.FS.writeFile('/lib/wasm32-wasi/crt1-reactor.o', new Uint8Array(0));

  const ret = callMainSafe(clang, [fileName, ...flags, '-###']);
  if (ret !== 0) {
    throw new Error(`Clang driver failed (exit ${ret}):\n${stderr}`);
  }

  const lines = stderr.split('\n');

  function extractArgs(key) {
    const line = lines.find((l) => l.includes(key)) ?? '';
    const matches = line.match(/"([^"]*)"/g);
    if (!matches || matches.length < 2) {
    throw new Error(`Could not find '${key}' subcommand in driver output:\n${stderr}`);
    }
    const args = matches.map((s) => s.slice(1, -1)).slice(1); // skip argv[0]
    const oIndex = args.findIndex((a) => a === '-o');
    return { args, outputFileName: args[oIndex + 1] };
  }

  const cc1    = extractArgs('-cc1');
  const linker = extractArgs('wasm-ld');

  return {
    compilerArgs:     cc1.args,
    compilerArtifact: cc1.outputFileName,
    linkerArgs:       linker.args,
    linkerArtifact:   linker.outputFileName,
  };
}

// ── Compile ──────────────────────────────────────────────────────────────────

/**
 * Compile C++ source to a WASM binary using the browsercc toolchain pipeline:
 *   1. Fresh Clang instance  →  -### to get exact driver args
 *   2. Fresh Clang instance  →  -cc1 … to produce an object file
 *   3. Fresh LLD   instance  →  wasm-ld … to link into a final WASM binary
 *
 * A fresh instance is required for each step because browsercc is built with
 * -s EXIT_RUNTIME, which destroys the Emscripten runtime after callMain()
 * completes.  Reusing the same instance for a second callMain() call would
 * fail with "RuntimeError: null function".
 *
 * @param {string}   source  – C++ source text
 * @param {string[]} flags   – extra compiler flags (e.g. ['-O2'])
 * @param {string}   std     – C++ standard (e.g. 'c++20')
 * @returns {{ success: boolean, diagnostics: string }}
 */
async function compile(source, flags = [], std = 'c++20') {
  if (!await ensureReady()) return { success: false, diagnostics: 'Compiler not ready.' };

  compiledBinary = null;

  const userFlags = [`-std=${std}`, '-Wall', '-Wextra', ...flags];

  // ── Step 1: Invocation discovery ─────────────────────────────────────────

  let invocation;
  try {
    invocation = await getCompilerInvocation('input.cpp', source, userFlags);
  } catch (err) {
    return { success: false, diagnostics: `Driver error: ${err.message}` };
  }

  let allOutput = '';
  const capture = (s) => { allOutput += s + '\n'; };

  // ── Step 2: Compile (clang++ -cc1 …) ─────────────────────────────────────

  let clang;
  try {
    clang = await clangFactory({
    thisProgram: 'clang++',
    locateFile:  (f) => workerRelativeUrl(`clang/${f}`),
    print:    capture,
    printErr: capture,
    });
  } catch (err) {
    return { success: false, diagnostics: `Clang init failed: ${err.message}` };
  }

  clang.FS.writeFile('input.cpp', source);
  setUpSysroot(clang, sysrootBuffer);

  let exitCode;
  try {
    exitCode = callMainSafe(clang, invocation.compilerArgs);
  } catch (err) {
    return { success: false, diagnostics: `Compiler crashed: ${err.message}\n${allOutput}`.trim() };
  }

  if (exitCode !== 0) {
    return { success: false, diagnostics: allOutput.trim() };
  }

  let objectBinary;
  try {
    objectBinary = clang.FS.readFile(invocation.compilerArtifact);
  } catch (_) {
    return { success: false, diagnostics: allOutput.trim() || 'Compiler produced no object file.' };
  }

  // ── Step 3: Link (wasm-ld …) ─────────────────────────────────────────────

  let lld;
  try {
    lld = await lldFactory({
    thisProgram: 'wasm-ld',
    locateFile:  (f) => workerRelativeUrl(`clang/${f}`),
    print:    capture,
    printErr: capture,
    });
  } catch (err) {
    return { success: false, diagnostics: `LLD init failed: ${err.message}` };
  }

  lld.FS.writeFile(invocation.compilerArtifact, objectBinary);
  setUpSysroot(lld, sysrootBuffer);

  try {
    exitCode = callMainSafe(lld, invocation.linkerArgs);
  } catch (err) {
    return { success: false, diagnostics: `Linker crashed: ${err.message}\n${allOutput}`.trim() };
  }

  if (exitCode !== 0) {
    return { success: false, diagnostics: allOutput.trim() };
  }

  try {
    compiledBinary = lld.FS.readFile(invocation.linkerArtifact);
  } catch (_) {
    return { success: false, diagnostics: allOutput.trim() || 'Linker produced no output binary.' };
  }

  return { success: true, diagnostics: allOutput.trim() };
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
