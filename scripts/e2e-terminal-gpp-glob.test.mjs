import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __executeTerminalCommandForTesting,
  __setTerminalTestHarness,
  setWorkspace,
} from '../src/ui/terminal.js';

function setupTerminalHarness(entries) {
  const compileCalls = [];
  __setTerminalTestHarness({
    term: { clear() {}, write() {} },
    onCompile(request) { compileCalls.push(request); },
  });
  setWorkspace({ name: 'project', entries });
  return { compileCalls };
}

test('e2e: g++ expands workspace globs and preserves compiler options', async () => {
  const ctx = setupTerminalHarness([
    { path: 'zeta.cpp', kind: 'file' },
    { path: 'alpha.cpp', kind: 'file' },
    { path: 'notes.txt', kind: 'file' },
  ]);

  await __executeTerminalCommandForTesting('g++ -Wall *.cpp -o app');

  assert.equal(ctx.compileCalls.length, 1);
  assert.deepEqual(ctx.compileCalls[0].sourcePaths, ['alpha.cpp', 'zeta.cpp']);
  assert.deepEqual(ctx.compileCalls[0].flags, ['-Wall']);
  assert.equal(ctx.compileCalls[0].outputName, 'app');
});

test('e2e: g++ expands globs relative to the terminal cwd', async () => {
  const ctx = setupTerminalHarness([
    { path: 'src', kind: 'directory' },
    { path: 'src/main.cpp', kind: 'file' },
    { path: 'src/util.cpp', kind: 'file' },
  ]);

  await __executeTerminalCommandForTesting('cd src');
  await __executeTerminalCommandForTesting('g++ *.cpp');

  assert.deepEqual(ctx.compileCalls[0].sourcePaths, ['src/main.cpp', 'src/util.cpp']);
});

test('e2e: clang++ keeps wildcard arguments literal', async () => {
  const ctx = setupTerminalHarness([{ path: 'main.cpp', kind: 'file' }]);

  await __executeTerminalCommandForTesting('clang++ *.cpp');

  assert.deepEqual(ctx.compileCalls[0].sourcePaths, ['*.cpp']);
});

test('e2e: g++ preserves an unmatched wildcard argument', async () => {
  const ctx = setupTerminalHarness([{ path: 'main.cpp', kind: 'file' }]);

  await __executeTerminalCommandForTesting('g++ missing*.cpp');

  assert.deepEqual(ctx.compileCalls[0].sourcePaths, ['missing*.cpp']);
});
