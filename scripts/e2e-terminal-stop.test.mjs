import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __getTerminalStateForTesting,
  __handleTerminalKeyForTesting,
  __setTerminalTestHarness,
  clearTerminal,
  onRunStart,
  onRunResult,
  printInfo,
  showInitialPrompt,
  startRun,
  stopRun,
} from '../src/ui/terminal.js';

function setupTerminalHarness({
  supportsInteractiveStdin = true,
  requestBufferedStdin = async () => '',
  onRun,
} = {}) {
  const writes = [];
  const runStateChanges = [];
  const runPreparationChanges = [];
  const stopCalls = [];
  const runCalls = [];
  const fakeTerm = {
    clear() {},
    write(text) { writes.push(text); },
  };

  __setTerminalTestHarness({
    term: fakeTerm,
    lastBuiltArtifactPath: 'a.out',
    onRun: onRun || ((request) => runCalls.push(request)),
    onStopRun: () => stopCalls.push('stop'),
    onRunStateChange: (running) => runStateChanges.push(running),
    onRunPreparationStateChange: (preparing) => runPreparationChanges.push(preparing),
    supportsInteractiveStdin: () => supportsInteractiveStdin,
    requestBufferedStdin,
  });

  return { writes, runStateChanges, runPreparationChanges, stopCalls, runCalls };
}

function ctrlCEvent() {
  return {
    key: 'c',
    ctrlKey: true,
    altKey: false,
    preventDefault() {},
  };
}

test('e2e: compiler ready status prints before the first terminal prompt', () => {
  const ctx = setupTerminalHarness();
  const status = 'Clang WASM compiler loaded. Ready to compile C++20.';

  printInfo(status);
  showInitialPrompt();

  const output = ctx.writes.join('');
  assert.ok(output.includes(`${status}\x1b[0m\r\n`));
  assert.ok(output.includes('browser.cpp'));
  assert.ok(output.indexOf(status) < output.indexOf('browser.cpp'));
  assert.ok(!output.includes(`browser.cpp:~$ ${status}`));
});

test('e2e: initial terminal prompt is only written once', () => {
  const ctx = setupTerminalHarness();

  showInitialPrompt();
  showInitialPrompt();

  const output = ctx.writes.join('');
  assert.equal(output.match(/browser\.cpp/g)?.length, 1);
});

test('e2e: clearing during startup does not reveal the initial prompt early', () => {
  const ctx = setupTerminalHarness();

  clearTerminal();
  printInfo('Clang WASM compiler loaded. Ready to compile C++20.');
  showInitialPrompt();

  const output = ctx.writes.join('');
  assert.equal(output.match(/browser\.cpp/g)?.length, 1);
  assert.ok(output.indexOf('Clang WASM compiler loaded') < output.indexOf('browser.cpp'));
});

test('e2e: Ctrl+C while running stops the program once and restores the prompt', async () => {
  const ctx = setupTerminalHarness();

  assert.equal(await startRun(), true);
  onRunStart({ stdinMode: 'interactive' });
  __handleTerminalKeyForTesting('', ctrlCEvent());
  __handleTerminalKeyForTesting('', ctrlCEvent());

  assert.equal(ctx.runCalls.length, 1);
  assert.deepEqual(ctx.stopCalls, ['stop']);
  assert.deepEqual(ctx.runStateChanges, [true, false]);
  assert.equal(__getTerminalStateForTesting().running, false);
  assert.ok(ctx.writes.join('').includes('^C'));
  assert.ok(ctx.writes.join('').includes('Process interrupted.'));
});

test('e2e: stopRun is idempotent for repeated button presses during one run', async () => {
  const ctx = setupTerminalHarness();

  assert.equal(await startRun(), true);
  onRunStart({ stdinMode: 'interactive' });
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
  assert.deepEqual(ctx.runPreparationChanges, []);
  assert.equal(__getTerminalStateForTesting().running, false);
  assert.ok(ctx.writes.join('').includes('^C'));
});

test('e2e: normal run completion reports not-running state', async () => {
  const ctx = setupTerminalHarness();

  assert.equal(await startRun(), true);
  onRunStart({ stdinMode: 'interactive' });
  onRunResult({ exitCode: 0 });

  assert.deepEqual(ctx.runStateChanges, [true, false]);
  assert.equal(__getTerminalStateForTesting().running, false);
});

test('e2e: non-SAB run posts UTF-8 buffered stdin before entering running state', async () => {
  const ctx = setupTerminalHarness({
    supportsInteractiveStdin: false,
    requestBufferedStdin: async () => 'Grüße\n',
  });

  assert.equal(await startRun(), true);

  assert.equal(ctx.runCalls.length, 1);
  assert.equal(ctx.runCalls[0].stdinMode, 'buffered');
  assert.deepEqual(
    [...ctx.runCalls[0].stdinBuffer],
    [...new TextEncoder().encode('Grüße\n')]
  );
  assert.deepEqual(ctx.runStateChanges, []);
  assert.deepEqual(ctx.runPreparationChanges, [true]);
  assert.equal(__getTerminalStateForTesting().preparingRun, true);

  onRunStart({ stdinMode: 'buffered' });
  assert.deepEqual(ctx.runStateChanges, [true]);
  assert.deepEqual(ctx.runPreparationChanges, [true, false]);
  assert.equal(__getTerminalStateForTesting().preparingRun, false);
});

test('e2e: canceling buffered stdin restores idle state and posts no run request', async () => {
  const ctx = setupTerminalHarness({
    supportsInteractiveStdin: false,
    requestBufferedStdin: async () => null,
  });

  assert.equal(await startRun(), false);

  assert.deepEqual(ctx.runCalls, []);
  assert.deepEqual(ctx.runPreparationChanges, [true, false]);
  assert.equal(__getTerminalStateForTesting().preparingRun, false);
  assert.equal(__getTerminalStateForTesting().running, false);
});

test('e2e: duplicate run while buffered input is pending posts only one request', async () => {
  let resolveInput;
  const pendingInput = new Promise((resolve) => { resolveInput = resolve; });
  const ctx = setupTerminalHarness({
    supportsInteractiveStdin: false,
    requestBufferedStdin: () => pendingInput,
  });

  const firstRun = startRun();
  assert.equal(await startRun(), false);
  resolveInput('Ada\n');
  assert.equal(await firstRun, true);

  assert.equal(ctx.runCalls.length, 1);
  assert.equal(ctx.runCalls[0].stdinMode, 'buffered');
});

test('e2e: run callback failure restores idle state without run-start', async () => {
  const writes = [];
  __setTerminalTestHarness({
    term: { clear() {}, write(text) { writes.push(text); } },
    lastBuiltArtifactPath: 'a.out',
    onRun: async () => { throw new Error('worker unavailable'); },
    supportsInteractiveStdin: () => true,
  });

  assert.equal(await startRun(), false);

  const state = __getTerminalStateForTesting();
  assert.equal(state.preparingRun, false);
  assert.equal(state.running, false);
  assert.ok(writes.join('').includes('Could not start program'));
});

test('e2e: oversized buffered stdin restores idle state and posts no run request', async () => {
  const ctx = setupTerminalHarness({
    supportsInteractiveStdin: false,
    requestBufferedStdin: async () => 'x'.repeat((256 * 1024) + 1),
  });

  assert.equal(await startRun(), false);

  assert.deepEqual(ctx.runCalls, []);
  assert.deepEqual(ctx.runPreparationChanges, [true, false]);
  assert.equal(__getTerminalStateForTesting().preparingRun, false);
  assert.ok(ctx.writes.join('').includes('256 KiB'));
});
