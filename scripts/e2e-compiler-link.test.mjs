import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseCompilePlan } from '../src/workers/compile-plan.mjs';
import { createWasiRuntime } from '../src/workers/wasi-shim.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clangDir = path.join(repoRoot, 'dist', 'clang');

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

const sysroot = fs.readFileSync(path.join(clangDir, 'sysroot.tar'));

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

async function compileAndLink(source) {
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
  assert.equal(callMain(driver, ['main.cpp', '-std=c++20', '-Wall', '-Wextra', '-fno-exceptions', '-###']), 0);

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

async function run(binary) {
  let stdout = '';
  const runtime = createWasiRuntime({
    stdin: { mode: 'none' },
    onStdout: (text) => { stdout += text; },
  });
  runtime.initRunVfs();
  const { instance } = await WebAssembly.instantiate(binary, {
    wasi_snapshot_preview1: runtime.wasi,
  });
  runtime.setMemory(instance.exports.memory);
  try {
    instance.exports._start();
  } catch (error) {
    if (!error?.__wasi_exit__) throw error;
    assert.equal(error.code, 0);
  }
  return stdout;
}

test('e2e: stream insertion of defined int and string return values links without C++ exception symbols', async () => {
  const result = await compileAndLink(`#include <iostream>
#include <string>

int val() { return 5; }
std::string label() { return "stream"; }

int main() {
  std::cout << val() << ' ' << label() << std::endl;
}
`);

  assert.equal(result.status, 0, result.diagnostics);
  assert.doesNotMatch(result.diagnostics, /undefined symbol: __cxa_/);
  assert.match(await run(result.output), /5 stream/);
});

test('e2e: an undefined streamed function reports the user symbol at link time', async () => {
  const result = await compileAndLink(`#include <iostream>

int missing();

int main() {
  std::cout << missing() << std::endl;
}
`);

  assert.notEqual(result.status, 0);
  assert.match(result.diagnostics, /undefined symbol: .*missing/);
  assert.doesNotMatch(result.diagnostics, /undefined symbol: __cxa_/);
});
