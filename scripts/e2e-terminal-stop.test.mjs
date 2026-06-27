import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __getTerminalStateForTesting,
  __handleTerminalKeyForTesting,
  __setTerminalTestHarness,
  onRunResult,
  startRun,
  stopRun,
} from '../src/ui/terminal.js';

function setupTerminalHarness() {
  const writes = [];
  const runStateChanges = [];
  const stopCalls = [];
  const runCalls = [];
  const fakeTerm = {
    clear() {},
    write(text) { writes.push(text); },
  };

  __setTerminalTestHarness({
    term: fakeTerm,
    lastBuiltArtifactPath: 'a.out',
    onRun: (sharedBuffer) => runCalls.push(sharedBuffer),
    onStopRun: () => stopCalls.push('stop'),
    onRunStateChange: (running) => runStateChanges.push(running),
  });

  return { writes, runStateChanges, stopCalls, runCalls };
}

function ctrlCEvent() {
  return {
    key: 'c',
    ctrlKey: true,
    altKey: false,
    preventDefault() {},
  };
}

test('e2e: Ctrl+C while running stops the program once and restores the prompt', () => {
  const ctx = setupTerminalHarness();

  startRun();
  __handleTerminalKeyForTesting('', ctrlCEvent());
  __handleTerminalKeyForTesting('', ctrlCEvent());

  assert.equal(ctx.runCalls.length, 1);
  assert.deepEqual(ctx.stopCalls, ['stop']);
  assert.deepEqual(ctx.runStateChanges, [true, false]);
  assert.equal(__getTerminalStateForTesting().running, false);
  assert.ok(ctx.writes.join('').includes('^C'));
  assert.ok(ctx.writes.join('').includes('Process interrupted.'));
});

test('e2e: stopRun is idempotent for repeated button presses during one run', () => {
  const ctx = setupTerminalHarness();

  startRun();
  assert.equal(stopRun(), true);
  assert.equal(stopRun(), false);

  assert.deepEqual(ctx.stopCalls, ['stop']);
  assert.deepEqual(ctx.runStateChanges, [true, false]);
});

test('e2e: Ctrl+C while idle keeps shell-line interrupt behavior', () => {
  const ctx = setupTerminalHarness();

  __handleTerminalKeyForTesting('', ctrlCEvent());

  assert.deepEqual(ctx.stopCalls, []);
  assert.deepEqual(ctx.runStateChanges, []);
  assert.equal(__getTerminalStateForTesting().running, false);
  assert.ok(ctx.writes.join('').includes('^C'));
});

test('e2e: normal run completion reports not-running state', () => {
  const ctx = setupTerminalHarness();

  startRun();
  onRunResult({ exitCode: 0 });

  assert.deepEqual(ctx.runStateChanges, [true, false]);
  assert.equal(__getTerminalStateForTesting().running, false);
});
