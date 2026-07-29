import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __executeTerminalCommandForTesting,
  __handleTerminalKeyForTesting,
  __setTerminalTestHarness,
  setWorkspace,
} from '../src/ui/terminal.js';

function setupTerminalHarness(onTouch = async () => ({ ok: true })) {
  const writes = [];
  const touchCalls = [];
  const fakeTerm = {
    clear() {},
    write(text) { writes.push(text); },
  };

  __setTerminalTestHarness({
    term: fakeTerm,
    onTouch: async (request) => {
      touchCalls.push(request);
      return onTouch(request);
    },
  });
  setWorkspace(null);

  return { writes, touchCalls };
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

test('e2e: help output lists mkdir and touch', async () => {
  const ctx = setupTerminalHarness();

  await __executeTerminalCommandForTesting('help');

  const output = ctx.writes.join('');
  assert.ok(output.includes('mkdir [-p] <dir>'));
  assert.ok(output.includes('touch <file>'));
});

test('e2e: tab completion expands to to touch', () => {
  const ctx = setupTerminalHarness();

  __handleTerminalKeyForTesting('t', keyEvent('t'));
  __handleTerminalKeyForTesting('o', keyEvent('o'));
  __handleTerminalKeyForTesting('', keyEvent('Tab'));

  assert.ok(ctx.writes.join('').includes('uch '));
});

test('e2e: touch creates a file relative to the workspace root', async () => {
  const ctx = setupTerminalHarness();
  setWorkspace({ name: 'project', entries: [] });

  await __executeTerminalCommandForTesting('touch notes.txt');

  assert.deepEqual(ctx.touchCalls, [{ path: 'notes.txt' }]);
});

test('e2e: touch resolves paths from the current working directory', async () => {
  const ctx = setupTerminalHarness();
  setWorkspace({
    name: 'project',
    entries: [{ path: 'src', kind: 'directory' }],
  });

  await __executeTerminalCommandForTesting('cd src');
  await __executeTerminalCommandForTesting('touch notes.txt');

  assert.deepEqual(ctx.touchCalls, [{ path: 'src/notes.txt' }]);
});

test('e2e: touch reports usage errors for missing, multiple, and option operands', async () => {
  const ctx = setupTerminalHarness();
  setWorkspace({ name: 'project', entries: [] });

  await __executeTerminalCommandForTesting('touch');
  await __executeTerminalCommandForTesting('touch one two');
  await __executeTerminalCommandForTesting('touch -p');

  const output = ctx.writes.join('');
  assert.equal((output.match(/Usage: touch <file>/g) || []).length, 3);
  assert.deepEqual(ctx.touchCalls, []);
});

test('e2e: touch reports an unopened workspace', async () => {
  const ctx = setupTerminalHarness();

  await __executeTerminalCommandForTesting('touch notes.txt');

  assert.ok(ctx.writes.join('').includes('touch: no folder opened'));
  assert.deepEqual(ctx.touchCalls, []);
});

test('e2e: touch formats filesystem errors without overwriting', async () => {
  const ctx = setupTerminalHarness(async () => ({
    ok: false,
    error: 'exists',
    path: 'notes.txt',
  }));
  setWorkspace({ name: 'project', entries: [] });

  await __executeTerminalCommandForTesting('touch notes.txt');

  assert.ok(ctx.writes.join('').includes("touch: cannot touch 'notes.txt': File exists"));
});
