import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createMemoryDebugImports,
  isMemoryDebugRuntimeError,
  memoryDebugFlags,
  unsupportedMemoryDebugImports,
} from '../src/workers/memory-debug.mjs';
import { parseCompilePlan } from '../src/workers/compile-plan.mjs';
import { createWasiRuntime } from '../src/workers/wasi-shim.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clangDir = path.join(repoRoot, 'dist', 'clang');
const sysroot = fs.readFileSync(path.join(clangDir, 'sysroot.tar'));

globalThis.self = globalThis;
let toolsReady = null;

function ensureTools() {
  toolsReady ||= (async () => {
    process.type = 'renderer';
    await import(pathToFileURL(path.join(clangDir, 'clang.js')).href);
    await import(pathToFileURL(path.join(clangDir, 'lld.js')).href);
  })();
  return toolsReady;
}

function callMain(module, args) {
  try {
    return module.callMain(args);
  } catch (error) {
    if (error?.name === 'ExitStatus') return error.status;
    throw error;
  }
}

function* tarContents(buffer) {
  const data = new Uint8Array(buffer);
  const decode = new TextDecoder();
  let offset = 0;

  while (offset + 512 <= data.length) {
    const header = data.slice(offset, offset + 512);
    const name = decode.decode(header.slice(0, 100)).replace(/\0.*$/, '');
    if (!name) return;
    const size = parseInt(decode.decode(header.slice(124, 136)).replace(/\0.*$/, '').trim(), 8) || 0;
    yield { name, content: data.slice(offset + 512, offset + 512 + size) };
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

function setUpSysroot(module) {
  for (const { name, content } of tarContents(sysroot)) {
    if (name.endsWith('/')) continue;
    const directory = name.split('/').slice(0, -1).join('/');
    if (directory && !module.FS.analyzePath(directory).exists) module.FS.mkdirTree(directory);
    module.FS.writeFile(name, content);
  }
}

async function createTool(factory, wasmName, program, capture) {
  return factory({
    thisProgram: program,
    wasmBinary: fs.readFileSync(path.join(clangDir, wasmName)),
    locateFile: (name) => path.join(clangDir, name),
    print: capture,
    printErr: capture,
  });
}

async function compileAndLink(source, flags) {
  await ensureTools();
  let driverOutput = '';
  const driver = await createTool(globalThis.createClangModule, 'clang.wasm', 'clang++', (line) => {
    driverOutput += `${line}\n`;
  });
  driver.FS.writeFile('main.cpp', source);
  driver.FS.mkdirTree('/lib/wasm32-wasi');
  driver.FS.mkdirTree('/include/c++/v1');
  driver.FS.writeFile('/lib/wasm32-wasi/crt1-command.o', new Uint8Array(0));
  driver.FS.writeFile('/lib/wasm32-wasi/crt1-reactor.o', new Uint8Array(0));
  assert.equal(callMain(driver, ['main.cpp', '-std=c++20', '-fno-exceptions', ...flags, '-###']), 0);

  const plan = parseCompilePlan(driverOutput);
  let compilerOutput = '';
  const compiler = await createTool(globalThis.createClangModule, 'clang.wasm', 'clang++', (line) => {
    compilerOutput += `${line}\n`;
  });
  compiler.FS.writeFile('main.cpp', source);
  setUpSysroot(compiler);
  compiler.FS.mkdirTree('/tmp');
  assert.equal(callMain(compiler, plan.compileSteps[0].args), 0, compilerOutput);

  let linkerOutput = '';
  const linker = await createTool(globalThis.createLLDModule, 'lld.wasm', 'wasm-ld', (line) => {
    linkerOutput += `${line}\n`;
  });
  setUpSysroot(linker);
  linker.FS.mkdirTree('/tmp');
  linker.FS.writeFile(plan.compileSteps[0].objectPath, compiler.FS.readFile(plan.compileSteps[0].objectPath));

  const status = callMain(linker, plan.linkStep.args);
  return {
    status,
    diagnostics: linkerOutput,
    output: status === 0 ? linker.FS.readFile(plan.linkStep.outputPath) : null,
  };
}

async function runMemoryDebugBinary(binary) {
  let stdout = '';
  let stderr = '';
  let instance = null;
  let exitCode = 0;
  const runtime = createWasiRuntime({
    stdin: { mode: 'none' },
    onStdout: (text) => { stdout += text; },
    onStderr: (text) => { stderr += text; },
  });
  runtime.initRunVfs();
  const module = await WebAssembly.compile(binary);
  const memoryDebugImports = createMemoryDebugImports({
    module,
    getMemory: () => instance?.exports.memory,
    onStderr: (text) => { stderr += text; },
  });
  instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: runtime.wasi,
    ...memoryDebugImports,
  });
  runtime.setMemory(instance.exports.memory);

  try {
    instance.exports._start();
  } catch (error) {
    if (error?.__wasi_exit__) exitCode = error.code;
    else if (isMemoryDebugRuntimeError(error)) exitCode = error.exitCode;
    else if (error instanceof WebAssembly.RuntimeError) exitCode = 134;
    else throw error;
  }
  return { stdout, stderr, exitCode };
}

test('memory debug profile enables fatal UBSan checks and libc++ debug hardening', () => {
  const flags = memoryDebugFlags(true);

  assert.ok(flags.includes('-fsanitize=undefined'));
  assert.ok(flags.includes('-fno-sanitize-recover=all'));
  assert.ok(flags.includes('-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_DEBUG'));
  assert.ok(flags.includes('-Wl,--allow-undefined'));
  assert.deepEqual(memoryDebugFlags(false), []);
});

test('UBSan reports a source-aware array bounds failure and exits nonzero', async () => {
  const result = await compileAndLink(`#include <iostream>

int main() {
  std::cout << "before\\n";
  int values[2] = {1, 2};
  volatile int index = 2;
  std::cout << values[index] << '\\n';
}
`, memoryDebugFlags(true));

  assert.equal(result.status, 0, result.diagnostics);
  const execution = await runMemoryDebugBinary(result.output);
  assert.match(execution.stdout, /before/);
  assert.match(execution.stderr, /main\.cpp:7:\d+: runtime error: out-of-bounds/);
  assert.notEqual(execution.exitCode, 0);
});

test('libc++ hardening reports vector subscript failures before trapping', async () => {
  const result = await compileAndLink(`#include <iostream>
#include <vector>

int main() {
  std::cout << "before\\n";
  std::vector<int> values = {1, 2};
  std::cout << values[2] << '\\n';
}
`, memoryDebugFlags(true));

  assert.equal(result.status, 0, result.diagnostics);
  const execution = await runMemoryDebugBinary(result.output);
  assert.match(execution.stdout, /before/);
  assert.match(execution.stderr, /vector\[\] index out of bounds/);
  assert.notEqual(execution.exitCode, 0);
});

test('Memory Debug Mode keeps ordinary unresolved user symbols as build failures', async () => {
  const result = await compileAndLink(`int missing();

int main() {
  return missing();
}
`, memoryDebugFlags(true));

  assert.equal(result.status, 0, result.diagnostics);
  const module = await WebAssembly.compile(result.output);
  const unsupported = unsupportedMemoryDebugImports(module);
  assert.equal(unsupported.length, 1);
  assert.match(unsupported[0].name, /missing/);
});

test('Memory Debug Mode leaves a valid program runnable', async () => {
  const result = await compileAndLink(`#include <iostream>

int main() {
  std::cout << "safe\\n";
}
`, memoryDebugFlags(true));

  assert.equal(result.status, 0, result.diagnostics);
  const module = await WebAssembly.compile(result.output);
  assert.deepEqual(unsupportedMemoryDebugImports(module), []);
  const execution = await runMemoryDebugBinary(result.output);
  assert.match(execution.stdout, /safe/);
  assert.equal(execution.stderr, '');
  assert.equal(execution.exitCode, 0);
});
