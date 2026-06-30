/**
 * src/workers/compiler.worker.js
 *
 * Web Worker that hosts the Emscripten-compiled Clang + LLD WASM binaries
 * (from the browsercc package).  It exposes a simple message-passing API
 * consumed by toolbar.js:
 *
 *  Inbound messages (from main thread):
 *    { type: 'compile', sourcePaths: string[], files: Array<{path,content}>,
 *                       std: string, flags: string[], primarySourcePath, outputName }
 *    { type: 'run',     sharedBuffer: SharedArrayBuffer, vfsFiles,
 *                       binaryBytes?: Uint8Array }
 *    { type: 'status'  }
 *
 *  Outbound messages (to main thread):
 *    { type: 'compiler-loading',  progress: 0-100 }
 *    { type: 'compiler-ready'   }
 *    { type: 'compiler-error',   message: string }
 *    { type: 'compile-start'    }
 *    { type: 'compile-result',   success: bool, diagnostics: string,
 *                                outputPath: string|null, outputBytes: Uint8Array|null,
 *                                diagnosticsByPath: object }
 *    { type: 'run-start'        }
 *    { type: 'stdout',           data: string }
 *    { type: 'stderr',           data: string }
 *    { type: 'run-result',       exitCode: number,
 *                                vfsChanges: Array<{path,bytes}>,
 *                                vfsDeletes: string[] }
 *    { type: 'status-reply',     state: string }
 *
 * Compilation pipeline (multi-translation-unit project build):
 *   1. Fresh Clang instance  – run `clang++ -###` to get the full compile plan
 *                              (one `-cc1` step per source + one `wasm-ld` step)
 *   2. Fresh Clang instance per source – run `clang++ -cc1 …` → one object each
 *   3. Fresh LLD  instance   – run `wasm-ld …` to link all objects into a binary
 *
 * A fresh instance is required for each step because the binaries are built
 * with `-s EXIT_RUNTIME`, which tears down the Emscripten runtime after
 * callMain() returns and makes the instance unusable for a second call.
 */

'use strict';

import { parseCompilePlan } from './compile-plan.mjs';
import { parseDiagnostics } from '../ui/diagnostics.mjs';
import { createWasiRuntime } from './wasi-shim.mjs';

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
 * Ask the Clang driver for the full multi-translation-unit build plan, without
 * actually compiling anything.  Uses the `-###` flag which prints every `-cc1`
 * and `wasm-ld` subcommand to stderr and exits 0.
 *
 * @param {string[]} sources – workspace-relative source paths (one per TU)
 * @param {Array<{path:string, content:string|Uint8Array}>} files – overlay
 * @param {string[]} flags   – user flags (e.g. ['-std=c++20', '-Wall'])
 * @param {string|null} outputName – optional `-o` artifact name
 * @returns {ReturnType<typeof parseCompilePlan>}
 */
async function getCompilePlan(sources, files, flags, outputName) {
  let stderr = '';
  const clang = await clangFactory({
    thisProgram: 'clang++',
    locateFile:  (f) => workerRelativeUrl(`clang/${f}`),
    print:    () => {},
    printErr: (s) => { stderr += s + '\n'; },
  });

  // Mount the project overlay so the driver can see every input source.
  populateCompileFs(clang.FS, files);

  // Minimal stub sysroot so the driver can resolve library/include paths
  clang.FS.mkdirTree('/lib/wasm32-wasi');
  clang.FS.mkdirTree('/include/c++/v1');
  clang.FS.writeFile('/lib/wasm32-wasi/crt1-command.o', new Uint8Array(0));
  clang.FS.writeFile('/lib/wasm32-wasi/crt1-reactor.o', new Uint8Array(0));

  const driverArgs = [...sources, ...flags];
  if (outputName) driverArgs.push('-o', outputName);
  driverArgs.push('-###');

  const ret = callMainSafe(clang, driverArgs);
  if (ret !== 0) {
    throw new Error(`Clang driver failed (exit ${ret}):\n${stderr}`);
  }

  return parseCompilePlan(stderr);
}

function normalizeCompilePath(path) {
  const value = String(path || 'input.cpp').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
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

/** Ensure the parent directory of an (absolute or relative) FS path exists. */
function ensureParentDir(moduleFs, path) {
  const value = String(path || '');
  const lastSlash = value.lastIndexOf('/');
  if (lastSlash > 0) {
    try { moduleFs.mkdirTree(value.slice(0, lastSlash)); } catch (_) { /* exists */ }
  }
}

/** Write every overlay file ({path, content}) into a module's virtual FS. */
function populateCompileFs(moduleFs, files) {
  for (const file of (files || [])) {
    if (!file?.path || file.content == null) continue;
    writeCompileFile(moduleFs, file.path, file.content);
  }
}

// ── Compile ──────────────────────────────────────────────────────────────────

/**
 * Compile a workspace project (one or more translation units) to a WASM binary:
 *   1. Fresh Clang instance  →  `-###` to get the full multi-TU build plan
 *   2. Fresh Clang instance *per source*  →  `-cc1 …` producing one object each
 *   3. Fresh LLD instance    →  `wasm-ld …` linking all objects into one binary
 *
 * A fresh instance is required for each step because browsercc is built with
 * `-s EXIT_RUNTIME`, which destroys the Emscripten runtime after callMain()
 * completes; reusing an instance for a second callMain() fails.
 *
 * @param {{
 *   sourcePaths: string[],
 *   files: Array<{path:string, content:string|Uint8Array}>,
 *   std?: string, flags?: string[],
 *   primarySourcePath?: string, outputName?: string|null,
 * }} request
 * @returns {Promise<{success:boolean, diagnostics:string, outputPath:(string|null),
 *                    diagnosticsByPath:object}>}
 */
async function compile(request) {
  const fail = (diagnostics) => ({ success: false, diagnostics, outputPath: null, diagnosticsByPath: {} });

  if (!await ensureReady()) return fail('Compiler not ready.');

  compiledBinary = null;

  const std       = request.std || 'c++20';
  const flags     = request.flags || [];
  const files     = request.files || [];
  const outputName = request.outputName || null;
  const sources = [...new Set((request.sourcePaths || []).map(normalizeCompilePath))];

  if (sources.length === 0) return fail('No source files to compile.');

  const userFlags = [`-std=${std}`, '-Wall', '-Wextra', ...flags];

  // ── Step 1: Build-plan discovery ─────────────────────────────────────────
  let plan;
  try {
    plan = await getCompilePlan(sources, files, userFlags, outputName);
  } catch (err) {
    return fail(`Driver error: ${err.message}`);
  }

  let allOutput = '';
  const capture = (s) => { allOutput += s + '\n'; };
  const diagnosticsByPath = () => groupDiagnostics(allOutput);

  // ── Step 2: Compile each translation unit ────────────────────────────────
  const objects = new Map();
  for (const step of plan.compileSteps) {
    let clang;
    try {
      clang = await clangFactory({
        thisProgram: 'clang++',
        locateFile:  (f) => workerRelativeUrl(`clang/${f}`),
        print:    capture,
        printErr: capture,
      });
    } catch (err) {
      return fail(`Clang init failed: ${err.message}`);
    }

    populateCompileFs(clang.FS, files);
    setUpSysroot(clang, sysrootBuffer);
    ensureParentDir(clang.FS, step.objectPath);

    let exitCode;
    try {
      exitCode = callMainSafe(clang, step.args);
    } catch (err) {
      return { success: false, diagnostics: `Compiler crashed: ${err.message}\n${allOutput}`.trim(), outputPath: null, diagnosticsByPath: diagnosticsByPath() };
    }

    if (exitCode !== 0) {
      return { success: false, diagnostics: allOutput.trim(), outputPath: null, diagnosticsByPath: diagnosticsByPath() };
    }

    try {
      objects.set(step.objectPath, clang.FS.readFile(step.objectPath));
    } catch (_) {
      return { success: false, diagnostics: allOutput.trim() || 'Compiler produced no object file.', outputPath: null, diagnosticsByPath: diagnosticsByPath() };
    }
  }

  // ── Step 3: Link all objects into one binary ─────────────────────────────
  let lld;
  try {
    lld = await lldFactory({
      thisProgram: 'wasm-ld',
      locateFile:  (f) => workerRelativeUrl(`clang/${f}`),
      print:    capture,
      printErr: capture,
    });
  } catch (err) {
    return fail(`LLD init failed: ${err.message}`);
  }

  for (const [path, bytes] of objects) {
    ensureParentDir(lld.FS, path);
    lld.FS.writeFile(path, bytes);
  }
  setUpSysroot(lld, sysrootBuffer);
  ensureParentDir(lld.FS, plan.linkStep.outputPath);

  let exitCode;
  try {
    exitCode = callMainSafe(lld, plan.linkStep.args);
  } catch (err) {
    return { success: false, diagnostics: `Linker crashed: ${err.message}\n${allOutput}`.trim(), outputPath: null, diagnosticsByPath: diagnosticsByPath() };
  }

  if (exitCode !== 0) {
    return { success: false, diagnostics: allOutput.trim(), outputPath: null, diagnosticsByPath: diagnosticsByPath() };
  }

  try {
    compiledBinary = lld.FS.readFile(plan.linkStep.outputPath);
  } catch (_) {
    return { success: false, diagnostics: allOutput.trim() || 'Linker produced no output binary.', outputPath: null, diagnosticsByPath: diagnosticsByPath() };
  }

  const outputPath = normalizeCompilePath(outputName || plan.linkStep.outputPath);
  return {
    success: true,
    diagnostics: allOutput.trim(),
    outputPath,
    outputBytes: compiledBinary,
    diagnosticsByPath: diagnosticsByPath(),
  };
}

/** Group parsed diagnostics by normalised source path for the UI. */
function groupDiagnostics(text) {
  const byPath = {};
  for (const d of parseDiagnostics(text)) {
    (byPath[d.path] ||= []).push(d);
  }
  return byPath;
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
async function run(sharedBuffer, vfsFiles = [], binaryBytes = null) {
  if (binaryBytes) {
    compiledBinary = binaryBytes instanceof Uint8Array
      ? new Uint8Array(binaryBytes)
      : new Uint8Array(binaryBytes);
  }

  if (!compiledBinary) {
    send({ type: 'stderr', data: 'No compiled binary. Please compile first.\n' });
    send({ type: 'run-result', exitCode: 1, vfsChanges: [], vfsDeletes: [] });
    return;
  }

  const wasiRuntime = createWasiRuntime({
    sharedBuffer,
    onStdout: (text) => send({ type: 'stdout', data: text }),
    onStderr: (text) => send({ type: 'stderr', data: text }),
  });
  wasiRuntime.initRunVfs(vfsFiles);
  let exitCode = 0;

  try {
    const { instance } = await WebAssembly.instantiate(compiledBinary, {
      wasi_snapshot_preview1: wasiRuntime.wasi,
    });

    // Give the WASI shim access to the module's memory
    wasiRuntime.setMemory(instance.exports.memory);

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
  wasiRuntime.flushRunFds();
  const vfsChanges = wasiRuntime.getDirtyVfsFiles();
  const vfsDeletes = wasiRuntime.getDeletedVfsFiles();

  send({ type: 'run-result', exitCode, vfsChanges, vfsDeletes });
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
        const result = await compile({
          sourcePaths:       data.sourcePaths || [],
          files:             data.files || [],
          std:               data.std || 'c++20',
          flags:             data.flags || [],
          primarySourcePath: data.primarySourcePath || null,
          outputName:        data.outputName || null,
        });
        send({ type: 'compile-result', primarySourcePath: data.primarySourcePath || null, ...result });
      } catch (err) {
        send({ type: 'compile-result', success: false, diagnostics: String(err), outputPath: null, diagnosticsByPath: {} });
      }
      break;

    case 'run':
      send({ type: 'run-start' });
      await run(data.sharedBuffer, data.vfsFiles || [], data.binaryBytes || null);
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
