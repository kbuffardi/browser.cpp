import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __executeTerminalCommandForTesting,
  __handleTerminalKeyForTesting,
  __setTerminalTestHarness,
  setWorkspace,
} from '../src/ui/terminal.js';

function setupTerminalHarness(onRemove = async () => ({ ok: true })) {
  const writes = [];
  const removeCalls = [];
  __setTerminalTestHarness({
    term: { clear() {}, write(text) { writes.push(text); } },
    onRemove: async (request) => {
      removeCalls.push(request);
      return onRemove(request);
    },
  });
  setWorkspace(null);
  return { writes, removeCalls };
}

function keyEvent(key) {
  return { key, ctrlKey: false, altKey: false, preventDefault() {} };
}

test('e2e: help and completion advertise rm', async () => {
  const ctx = setupTerminalHarness();
  await __executeTerminalCommandForTesting('help');
  __handleTerminalKeyForTesting('r', keyEvent('r'));
  __handleTerminalKeyForTesting('', keyEvent('Tab'));

  assert.ok(ctx.writes.join('').includes('rm [-r] <path>...'));
  assert.ok(ctx.writes.join('').includes('m '));
});

test('e2e: rm sends multiple files and recursive directories to the callback', async () => {
  const ctx = setupTerminalHarness();
  setWorkspace({
    name: 'project',
    entries: [
      { path: 'src', kind: 'directory' },
      { path: 'src/old.cpp', kind: 'file' },
      { path: 'README.md', kind: 'file' },
      { path: 'build', kind: 'directory' },
    ],
  });

  await __executeTerminalCommandForTesting('cd src');
  await __executeTerminalCommandForTesting('rm old.cpp ../README.md');
  await __executeTerminalCommandForTesting('rm -r ../build');

  assert.deepEqual(ctx.removeCalls, [
    { paths: ['src/old.cpp', 'README.md'], recursive: false },
    { paths: ['build'], recursive: true },
  ]);
});

test('e2e: rm rejects root escape, no operands, and unsupported options', async () => {
  const ctx = setupTerminalHarness();
  setWorkspace({ name: 'project', entries: [{ path: 'src', kind: 'directory' }] });
  await __executeTerminalCommandForTesting('cd src');
  await __executeTerminalCommandForTesting('rm ../../outside.cpp');
  await __executeTerminalCommandForTesting('rm');
  await __executeTerminalCommandForTesting('rm -f file.cpp');

  const output = ctx.writes.join('');
  assert.ok(output.includes("rm: cannot remove '../../outside.cpp': Invalid path"));
  assert.equal((output.match(/Usage: rm \[-r\] <path>\.\.\./g) || []).length, 2);
  assert.deepEqual(ctx.removeCalls, []);
});

test('e2e: rm formats filesystem errors for each failed target', async () => {
  const ctx = setupTerminalHarness(async () => ({
    results: [
      { ok: false, error: 'not-found', path: 'missing.cpp' },
      { ok: false, error: 'is-directory', path: 'build' },
    ],
  }));
  setWorkspace({ name: 'project', entries: [] });

  await __executeTerminalCommandForTesting('rm missing.cpp build');

  const output = ctx.writes.join('');
  assert.ok(output.includes("rm: cannot remove 'missing.cpp': No such file or directory"));
  assert.ok(output.includes("rm: cannot remove 'build': Is a directory"));
});
