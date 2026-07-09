import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __handleTerminalKeyForTesting,
  __setTerminalTestHarness,
  setWorkspace,
} from '../src/ui/terminal.js';

function setupTerminalHarness() {
  const writes = [];
  const fakeTerm = {
    clear() {},
    write(text) { writes.push(text); },
  };

  setWorkspace(null);
  __setTerminalTestHarness({
    term: fakeTerm,
    lastBuiltArtifactPath: 'a.out',
  });

  return { writes };
}

function keyEvent(key, overrides = {}) {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    preventDefault() {},
    ...overrides,
  };
}

function typeText(text) {
  for (const ch of text) {
    __handleTerminalKeyForTesting(ch, keyEvent(ch));
  }
}

function pressEnter() {
  __handleTerminalKeyForTesting('', keyEvent('Enter'));
}

function pressTab() {
  __handleTerminalKeyForTesting('', keyEvent('Tab'));
}

test('e2e: help output no longer advertises git', () => {
  const ctx = setupTerminalHarness();

  typeText('help');
  pressEnter();

  const output = ctx.writes.join('');
  assert.ok(output.includes('Available commands:'));
  assert.ok(!output.includes('git <cmd>'));
});

test('e2e: tab completion no longer suggests git', () => {
  const ctx = setupTerminalHarness();

  typeText('gi');
  pressTab();

  const output = ctx.writes.join('');
  assert.equal(output, 'gi');
});

test('e2e: git commands fall back to command not found', () => {
  const ctx = setupTerminalHarness();

  typeText('git status');
  pressEnter();

  const output = ctx.writes.join('');
  assert.ok(output.includes('bash: git: command not found'));
  assert.ok(!output.includes('fatal: not a git repository'));
});

test('e2e: folders containing .git remain ordinary workspace content', () => {
  const ctx = setupTerminalHarness();
  setWorkspace({
    name: 'repo',
    entries: [
      { path: '.git', kind: 'directory' },
      { path: '.git/HEAD', kind: 'file' },
      { path: 'main.cpp', kind: 'file' },
    ],
    git: { isRepo: true, branch: 'main', remotes: ['origin'] },
  });

  typeText('ls');
  pressEnter();

  const output = ctx.writes.join('');
  assert.ok(output.includes('.git/'));
  assert.ok(output.includes('main.cpp'));
});
