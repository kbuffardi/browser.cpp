import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __executeTerminalCommandForTesting,
  __handleTerminalKeyForTesting,
  __setTerminalTestHarness,
  setWorkspace,
} from '../src/ui/terminal.js';

function setupTerminalHarness(onMkdir = async () => ({ ok: true })) {
  const writes = [];
  const mkdirCalls = [];
  const fakeTerm = {
    clear() {},
    write(text) { writes.push(text); },
  };

  __setTerminalTestHarness({
    term: fakeTerm,
    onMkdir: async (request) => {
      mkdirCalls.push(request);
      return onMkdir(request);
    },
  });
  setWorkspace(null);

  return { writes, mkdirCalls };
}

function keyEvent(key, extra = {}) {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    preventDefault() {},
    ...extra,
  };
}

test('e2e: help output lists mkdir', async () => {
  const ctx = setupTerminalHarness();

  await __executeTerminalCommandForTesting('help');

  assert.ok(ctx.writes.join('').includes('mkdir [-p] <dir>'));
});

test('e2e: tab completion expands mk to mkdir', () => {
  const ctx = setupTerminalHarness();

  __handleTerminalKeyForTesting('m', keyEvent('m'));
  __handleTerminalKeyForTesting('k', keyEvent('k'));
  __handleTerminalKeyForTesting('', keyEvent('Tab'));

  assert.ok(ctx.writes.join('').includes('dir '));
});

test('e2e: mkdir creates a root directory relative to the workspace root', async () => {
  const ctx = setupTerminalHarness();
  setWorkspace({ name: 'project', entries: [], git: { isRepo: false, branch: null, remotes: [] } });

  await __executeTerminalCommandForTesting('mkdir include');

  assert.deepEqual(ctx.mkdirCalls, [{ path: 'include', parents: false }]);
});

test('e2e: mkdir resolves paths from the current working directory', async () => {
  const ctx = setupTerminalHarness();
  setWorkspace({
    name: 'project',
    entries: [{ path: 'src', kind: 'directory' }],
    git: { isRepo: false, branch: null, remotes: [] },
  });

  await __executeTerminalCommandForTesting('cd src');
  await __executeTerminalCommandForTesting('mkdir include');

  assert.deepEqual(ctx.mkdirCalls, [{ path: 'src/include', parents: false }]);
});

test('e2e: mkdir -p passes recursive parent creation through to the filesystem callback', async () => {
  const ctx = setupTerminalHarness();
  setWorkspace({ name: 'project', entries: [], git: { isRepo: false, branch: null, remotes: [] } });

  await __executeTerminalCommandForTesting('mkdir -p src/include/generated');

  assert.deepEqual(ctx.mkdirCalls, [{ path: 'src/include/generated', parents: true }]);
});

test('e2e: mkdir reports unsupported characters with singular and plural wording', async () => {
  const ctx = setupTerminalHarness();
  setWorkspace({ name: 'project', entries: [], git: { isRepo: false, branch: null, remotes: [] } });

  await __executeTerminalCommandForTesting('mkdir bad?');
  await __executeTerminalCommandForTesting("mkdir 'bad name!'");

  const output = ctx.writes.join('');
  assert.ok(output.includes('? is not supported in folder names. Use only letters, numbers, hyphens, and underscores.'));
  assert.ok(output.includes("' ', ! are not supported in folder names. Use only letters, numbers, hyphens, and underscores."));
  assert.deepEqual(ctx.mkdirCalls, []);
});

test('e2e: mkdir reports the 64-character truncation guidance', async () => {
  const ctx = setupTerminalHarness();
  setWorkspace({ name: 'project', entries: [], git: { isRepo: false, branch: null, remotes: [] } });
  const longName = `mkdir ${'a'.repeat(65)}`;

  await __executeTerminalCommandForTesting(longName);

  assert.ok(ctx.writes.join('').includes(`Keep folder names short, such as: ${'a'.repeat(64)}`));
  assert.deepEqual(ctx.mkdirCalls, []);
});

test('e2e: mkdir rejects multiple operands with a usage error', async () => {
  const ctx = setupTerminalHarness();
  setWorkspace({ name: 'project', entries: [], git: { isRepo: false, branch: null, remotes: [] } });

  await __executeTerminalCommandForTesting('mkdir a b');

  assert.ok(ctx.writes.join('').includes('Usage: mkdir [-p] <dir>'));
  assert.deepEqual(ctx.mkdirCalls, []);
});

test('e2e: mkdir reports filesystem errors using shell-style messages', async () => {
  const ctx = setupTerminalHarness(async () => ({ ok: false, error: 'missing-parent', path: 'src' }));
  setWorkspace({ name: 'project', entries: [], git: { isRepo: false, branch: null, remotes: [] } });

  await __executeTerminalCommandForTesting('mkdir src/include');

  assert.ok(ctx.writes.join('').includes("mkdir: cannot create directory 'src/include': No such file or directory"));
});

test('e2e: mkdir fails when no workspace folder is open', async () => {
  const ctx = setupTerminalHarness();

  await __executeTerminalCommandForTesting('mkdir include');

  assert.ok(ctx.writes.join('').includes('mkdir: no folder opened'));
  assert.deepEqual(ctx.mkdirCalls, []);
});
