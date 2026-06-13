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

// ── Per-run virtual filesystem (VFS) ──────────────────────────────────────────

/**
 * Map from normalised workspace-relative path to the file's current content.
 * Populated from the workspace before each run and updated as the program
 * writes files.
 * @type {Map<string, Uint8Array>}
 */
let runVfs = new Map();

/**
 * Set of paths that the WASM program wrote to during the current run.
 * These are sent back to the main thread as `vfsChanges` in `run-result`.
 * @type {Set<string>}
 */
let runVfsDirty = new Set();

/**
 * Open file-descriptor table.  Keys 0–2 are stdin/stdout/stderr (handled
 * directly in the WASI shim); key 3 is the pre-opened root directory.
 * Keys 4+ are file descriptors opened via path_open.
 *
 * Each entry has shape:
 *   { type: 'preopen' }
 *   { type: 'file', path: string, data: Uint8Array, cursor: number, dirty: boolean }
 *
 * @type {Map<number, object>}
 */
let runFds = new Map();

/** Next file-descriptor number to allocate (starts at 4). */
let runNextFd = 4;

/** fd number for the single pre-opened root directory exposed to the program. */
const VFS_PREOPEN_FD = 3;

/**
 * Normalise a path for VFS lookup.
 * Strips leading "./" and "/" sequences and resolves "." / ".." components.
 * ".." at the root is silently ignored to prevent escaping the workspace.
 * @param {string} p
 * @returns {string}
 */
function normVfsPath(p) {
  const parts = [];
  for (const seg of String(p || '').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0) parts.pop(); // ignore '..' at root (can't escape workspace)
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Initialise the per-run VFS state before each `run()` call.
 * @param {Array<{path: string, bytes: Uint8Array}>} vfsFiles
 */
function initRunVfs(vfsFiles) {
  runVfs       = new Map();
  runVfsDirty  = new Set();
  runFds       = new Map();
  runNextFd    = 4;
  runFds.set(VFS_PREOPEN_FD, { type: 'preopen' });
  for (const { path, bytes } of (vfsFiles || [])) {
    const key = normVfsPath(path);
    if (key) runVfs.set(key, new Uint8Array(bytes));
  }
}

/**
 * Flush all still-open writable file descriptors back into `runVfs` and mark
 * them dirty.  Called after the WASM program exits (even abnormally) so that
 * files the program didn't explicitly close are still saved.
 */
function flushRunFds() {
  for (const file of runFds.values()) {
    if (file.type === 'file' && file.dirty) {
      runVfs.set(file.path, file.data);
      runVfsDirty.add(file.path);
    }
  }
}

/**
 * Collect all VFS entries that were written to during this run.
 * @returns {Array<{path: string, bytes: Uint8Array}>}
 */
function getDirtyVfsFiles() {
  const result = [];
  for (const path of runVfsDirty) {
    if (runVfs.has(path)) {
      result.push({ path, bytes: runVfs.get(path) });
    }
  }
  return result;
}

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

function normalizeCompilePath(path) {
  const value = String(path || 'input.cpp').replace(/^\/+/, '');
  return value || 'input.cpp';
}

function writeCompileFile(moduleFs, path, content) {
  const normalized = normalizeCompilePath(path);
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash > 0) {
    moduleFs.mkdirTree(normalized.slice(0, lastSlash));
  }
  moduleFs.writeFile(normalized, content);
}

function populateCompileFs(moduleFs, sourcePath, source, vfsFiles) {
  for (const file of (vfsFiles || [])) {
    if (!file?.path || !file.bytes) continue;
    writeCompileFile(moduleFs, file.path, file.bytes);
  }
  writeCompileFile(moduleFs, sourcePath, source);
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
 * @param {string[]} flags      – extra compiler flags (e.g. ['-O2'])
 * @param {string}   std        – C++ standard (e.g. 'c++20')
 * @param {string}   sourcePath – workspace-relative source path
 * @param {Array<{path: string, bytes: Uint8Array}>} vfsFiles – workspace files
 * @returns {{ success: boolean, diagnostics: string }}
 */
async function compile(source, flags = [], std = 'c++20', sourcePath = 'input.cpp', vfsFiles = []) {
  if (!await ensureReady()) return { success: false, diagnostics: 'Compiler not ready.' };

  compiledBinary = null;
  const normalizedSourcePath = normalizeCompilePath(sourcePath);

  const userFlags = [`-std=${std}`, '-Wall', '-Wextra', ...flags];

  // ── Step 1: Invocation discovery ─────────────────────────────────────────

  let invocation;
  try {
    invocation = await getCompilerInvocation(normalizedSourcePath, source, userFlags);
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

  populateCompileFs(clang.FS, normalizedSourcePath, source, vfsFiles);
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
 * SharedArrayBuffer layout used for interactive stdin:
 *   Int32[0]  – state:  0 = waiting for input, 1 = data ready, -1 = EOF
 *   Int32[1]  – length: number of bytes in the data section
 *   Uint8[8…] – data:   up to 4096 bytes of stdin content
 */
const SAB_HEADER_BYTES = 8;

/**
 * Minimal WASI "snapshot_preview1" implementation sufficient for running
 * C++ programs that use cout/cin/cerr, command-line args, and proc_exit.
 *
 * @param {SharedArrayBuffer} sharedBuffer – SAB created by the terminal for
 *   interactive stdin.  The terminal writes lines into it; fd_read blocks with
 *   Atomics.wait() until a line (or EOF) is available.
 *
 * Reference: https://github.com/WebAssembly/WASI/blob/main/phases/snapshot/docs.md
 */
function createWASIImports({ sharedBuffer, onStdout, onStderr }) {
  // We capture the memory reference after instantiation via a closure cell
  let memory = null;
  const setMemory = (m) => { memory = m; };

  const view = () => new DataView(memory.buffer);
  const u8   = () => new Uint8Array(memory.buffer);

  // Int32 view of the SAB header: [state, dataLen]
  const sabControl = new Int32Array(sharedBuffer);

  // Internal byte queue: filled from the SAB one chunk at a time, then served
  // to the WASM module across potentially multiple fd_read calls.
  const stdinQueue = [];

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
        if (fd === 1 || fd === 2) {
          const text = new TextDecoder().decode(u8().subarray(base, base + len));
          if (fd === 1) onStdout(text);
          else onStderr(text);
        } else {
          // File fd: write raw bytes into the open file's buffer
          const file = runFds.get(fd);
          if (!file || file.type !== 'file') {
            view().setUint32(nwrittenPtr, total, true);
            return 8; // __WASI_ERRNO_BADF
          }
          const needed = file.cursor + len;
          if (needed > file.data.length) {
            const grown = new Uint8Array(needed);
            grown.set(file.data);
            file.data = grown;
          }
          file.data.set(u8().subarray(base, base + len), file.cursor);
          file.cursor += len;
          file.dirty   = true;
        }
        total += len;
      }
      view().setUint32(nwrittenPtr, total, true);
      return 0; // __WASI_ERRNO_SUCCESS
    },

    // fd_read(fd, iovs_ptr, iovs_len, nread_ptr) → errno
    //
    // For fd 0 (stdin): blocks (via Atomics.wait) until the terminal writes a
    // line into the SAB, then drains bytes from an internal queue into WASM memory.
    // For file fds: reads sequentially from the open file's in-memory buffer.
    fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
      // ── File fds ──────────────────────────────────────────────────────────
      if (fd > 2) {
        const file = runFds.get(fd);
        if (!file || file.type !== 'file') {
          view().setUint32(nreadPtr, 0, true);
          return 8; // __WASI_ERRNO_BADF
        }
        const spans = iovSpans(iovsPtr, iovsLen);
        let total = 0;
        for (const { base, len } of spans) {
          const avail = file.data.length - file.cursor;
          if (avail <= 0) break; // EOF
          const toRead = Math.min(len, avail);
          u8().set(file.data.subarray(file.cursor, file.cursor + toRead), base);
          file.cursor += toRead;
          total += toRead;
        }
        view().setUint32(nreadPtr, total, true);
        return 0;
      }

      if (fd !== 0) {
        view().setUint32(nreadPtr, 0, true);
        return 8; // __WASI_ERRNO_BADF
      }

      // ── stdin (fd 0): SAB + Atomics blocking read ──────────────────────
      const spans = iovSpans(iovsPtr, iovsLen);
      let total = 0;

      for (const { base, len } of spans) {
        // Refill internal queue from the SAB when it runs dry
        if (stdinQueue.length === 0) {
          // Block until the terminal signals data or EOF (state != 0)
          if (Atomics.load(sabControl, 0) === 0) {
            Atomics.wait(sabControl, 0, 0);
          }

          const state = Atomics.load(sabControl, 0);
          if (state === -1) {
            // EOF – reset so a potential second run in the same session works
            Atomics.store(sabControl, 0, 0);
            Atomics.notify(sabControl, 0);
            break;
          }

          // state === 1: copy the chunk into the internal queue
          const dataLen = Atomics.load(sabControl, 1);
          const chunk   = new Uint8Array(sharedBuffer, SAB_HEADER_BYTES, dataLen).slice();
          Array.prototype.push.apply(stdinQueue, chunk);

          // Reset state to 0 so the terminal knows it can send the next chunk
          Atomics.store(sabControl, 0, 0);
          Atomics.notify(sabControl, 0); // wake any Atomics.waitAsync on main thread
        }

        if (stdinQueue.length === 0) break; // EOF was reached above

        const toRead = Math.min(len, stdinQueue.length);
        for (let i = 0; i < toRead; i++) u8()[base + i] = stdinQueue.shift();
        total += toRead;
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
    fd_close(fd) {
      if (fd <= 2) return 0; // stdin/stdout/stderr: no-op
      const file = runFds.get(fd);
      if (!file) return 8; // __WASI_ERRNO_BADF
      if (file.type === 'file' && file.dirty) {
        runVfs.set(file.path, file.data);
        runVfsDirty.add(file.path);
      }
      runFds.delete(fd);
      return 0;
    },

    // fd_seek(fd, offset, whence, newoffset_ptr) → errno
    // offset is i64 (BigInt in JS).
    fd_seek(fd, offset, whence, newoffsetPtr) {
      const file = runFds.get(fd);
      if (!file || file.type !== 'file') return 70; // __WASI_ERRNO_SPIPE
      const SEEK_SET = 0, SEEK_CUR = 1, SEEK_END = 2;
      const off = Number(offset); // safe for files well under 2^53 bytes
      let newPos;
      if (whence === SEEK_SET)      newPos = off;
      else if (whence === SEEK_CUR) newPos = file.cursor + off;
      else if (whence === SEEK_END) newPos = file.data.length + off;
      else                          return 28; // __WASI_ERRNO_INVAL
      if (newPos < 0) return 28; // __WASI_ERRNO_INVAL
      file.cursor = newPos;
      view().setBigUint64(newoffsetPtr, BigInt(newPos), true);
      return 0;
    },

    // fd_fdstat_get(fd, stat_ptr) → errno
    fd_fdstat_get(fd, statPtr) {
      // __wasi_fdstat_t layout (24 bytes):
      //   filetype(1) pad(1) fs_flags(2) pad(4) rights_base(8) rights_inheriting(8)
      const dv = view();
      let filetype;
      if (fd <= 2) {
        filetype = 2; // __WASI_FILETYPE_CHARACTER_DEVICE
      } else {
        const file = runFds.get(fd);
        if (!file) return 8; // __WASI_ERRNO_BADF
        filetype = file.type === 'preopen' ? 3 : 4; // DIRECTORY or REGULAR_FILE
      }
      dv.setUint8(statPtr,     filetype);
      dv.setUint8(statPtr + 1, 0);
      dv.setUint32(statPtr + 2, 0, true); // fdflags
      // rights: grant all
      dv.setBigUint64(statPtr +  8, 0xFFFFFFFFFFFFFFFFn, true);
      dv.setBigUint64(statPtr + 16, 0xFFFFFFFFFFFFFFFFn, true);
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

    // fd_prestat_get(fd, buf_ptr) → errno
    // Returns the pre-open descriptor for fd 3 (the workspace root ".").
    // libc iterates fd 3, 4, ... until it gets EBADF to discover pre-opens.
    fd_prestat_get(fd, bufPtr) {
      if (fd === VFS_PREOPEN_FD) {
        // __WASI_PREOPENTYPE_DIR = 0; pr_name_len = 1 (for ".")
        view().setUint8(bufPtr, 0);
        view().setUint32(bufPtr + 4, 1, true);
        return 0;
      }
      return 8; // __WASI_ERRNO_BADF
    },

    // fd_prestat_dir_name(fd, path_ptr, path_len) → errno
    fd_prestat_dir_name(fd, pathPtr) {
      if (fd === VFS_PREOPEN_FD) {
        u8()[pathPtr] = 46; // '.'
        return 0;
      }
      return 8; // __WASI_ERRNO_BADF
    },

    // path_open(dirfd, dirflags, path_ptr, path_len, oflags,
    //           fs_rights_base, fs_rights_inheriting, fdflags,
    //           opened_fd_ptr) → errno
    // fs_rights_base and fs_rights_inheriting are i64 (BigInt in JS).
    // We ignore rights – all opened fds are readable and writable.
    path_open(dirFd, _dirflags, pathPtr, pathLen, oflags,
              _fsRightsBase, _fsRightsInheriting, _fdflags, openedFdPtr) {
      if (dirFd !== VFS_PREOPEN_FD && !runFds.has(dirFd)) return 8; // EBADF

      const rawPath = new TextDecoder().decode(u8().subarray(pathPtr, pathPtr + pathLen));
      const path = normVfsPath(rawPath);

      const OFLAGS_CREAT = 0x0001;
      const OFLAGS_EXCL  = 0x0004;
      const OFLAGS_TRUNC = 0x0008;

      const creat = !!(oflags & OFLAGS_CREAT);
      const excl  = !!(oflags & OFLAGS_EXCL);
      const trunc = !!(oflags & OFLAGS_TRUNC);

      if (excl && runVfs.has(path)) return 20; // __WASI_ERRNO_EXIST

      let initialData;
      if (runVfs.has(path)) {
        // Defensive copy: prevents the open fd's buffer from aliasing the VFS
        // entry, so writes to the fd don't corrupt the stored original until
        // the fd is explicitly closed (or flushed at program exit).
        initialData = trunc ? new Uint8Array(0) : new Uint8Array(runVfs.get(path));
      } else if (creat) {
        initialData = new Uint8Array(0);
      } else {
        return 44; // __WASI_ERRNO_NOENT
      }

      const newFd = runNextFd++;
      runFds.set(newFd, { type: 'file', path, data: initialData, cursor: 0, dirty: false });
      view().setUint32(openedFdPtr, newFd, true);
      return 0;
    },

    // path_create_directory(fd, path_ptr, path_len) → errno
    // Directories are implicit in the VFS; always succeed.
    path_create_directory() {
      return 0;
    },

    // path_filestat_get(fd, flags, path_ptr, path_len, stat_ptr) → errno
    // Returns a minimal filestat for files that exist in the VFS.
    path_filestat_get(_fd, _flags, pathPtr, pathLen, statPtr) {
      const rawPath = new TextDecoder().decode(u8().subarray(pathPtr, pathPtr + pathLen));
      const path = normVfsPath(rawPath);
      if (!runVfs.has(path)) return 44; // __WASI_ERRNO_NOENT
      const fileData = runVfs.get(path);
      const dv = view();
      // __wasi_filestat_t layout (64 bytes):
      //   dev(8) ino(8) filetype(1)+pad(7) nlink(8) size(8) atim(8) mtim(8) ctim(8)
      dv.setBigUint64(statPtr,      0n, true); // dev
      dv.setBigUint64(statPtr +  8, 0n, true); // ino
      dv.setUint8(statPtr + 16, 4);            // filetype = __WASI_FILETYPE_REGULAR_FILE
      dv.setBigUint64(statPtr + 24, 1n, true); // nlink
      dv.setBigUint64(statPtr + 32, BigInt(fileData.length), true); // size
      dv.setBigUint64(statPtr + 40, 0n, true); // atim
      dv.setBigUint64(statPtr + 48, 0n, true); // mtim
      dv.setBigUint64(statPtr + 56, 0n, true); // ctim
      return 0;
    },
  };

  return { wasi, setMemory };
}

// ── Run ──────────────────────────────────────────────────────────────────────

/**
 * Instantiate and execute the compiled WASM binary with a minimal WASI shim.
 *
 * @param {SharedArrayBuffer} sharedBuffer – SAB created by the terminal that
 *   provides interactive stdin via Atomics.  The SAB must be pre-zeroed (state
 *   = 0) so that fd_read blocks immediately when no input is ready.
 * @param {Array<{path:string, bytes:Uint8Array}>} vfsFiles – workspace files
 *   to expose to the program via fstream.  Written/created files are collected
 *   and returned in the `run-result` message as `vfsChanges`.
 */
async function run(sharedBuffer, vfsFiles = []) {
  if (!compiledBinary) {
    send({ type: 'stderr', data: 'No compiled binary. Please compile first.\n' });
    send({ type: 'run-result', exitCode: 1, vfsChanges: [] });
    return;
  }

  initRunVfs(vfsFiles);
  let exitCode = 0;

  const { wasi, setMemory } = createWASIImports({
    sharedBuffer,
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

  // Flush any still-open writable file descriptors so their content is saved
  // even if the program exited without explicitly calling fclose / fstream dtor.
  flushRunFds();
  const vfsChanges = getDirtyVfsFiles();

  send({ type: 'run-result', exitCode, vfsChanges });
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
        const result = await compile(
          data.source,
          data.flags || [],
          data.std || 'c++20',
          data.fileName || 'input.cpp',
          data.vfsFiles || []
        );
        send({ type: 'compile-result', ...result });
      } catch (err) {
        send({ type: 'compile-result', success: false, diagnostics: String(err) });
      }
      break;

    case 'run':
      send({ type: 'run-start' });
      await run(data.sharedBuffer, data.vfsFiles || []);
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
