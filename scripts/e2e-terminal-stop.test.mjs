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
  resetTerminalSession,
  showInitialPrompt,
  startRun,
  stopRun,
} from '../src/ui/terminal.js';

function setupTerminalHarness({
  supportsInteractiveStdin = true,
  supportsMessageInteractiveStdin = false,
  onRun,
} = {}) {
  const writes = [];
  const clearCalls = [];
  const runStateChanges = [];
  const runPreparationChanges = [];
  const stopCalls = [];
  const runCalls = [];
  const stdinMessages = [];
  const fakeTerm = {
    clear() { clearCalls.push(true); },
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
    supportsMessageInteractiveStdin: () => supportsMessageInteractiveStdin,
    onStdinData: (message) => stdinMessages.push(message),
    onStdinEOF: (message) => stdinMessages.push(message),
    createStdinSessionId: () => 'stdin-session-test',
  });

  return {
    writes,
    clearCalls,
    runStateChanges,
    runPreparationChanges,
    stopCalls,
    runCalls,
    stdinMessages,
  };
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

test('e2e: resetting a terminal session clears output and redraws one prompt', () => {
  const ctx = setupTerminalHarness();
  showInitialPrompt();
  printInfo('stale output');

  resetTerminalSession({ name: 'project', entries: [] });

  assert.equal(ctx.clearCalls.length, 1);
  assert.equal(ctx.writes.at(-1).match(/browser\.cpp/g)?.length, 1);
  assert.match(ctx.writes.at(-1), /browser\.cpp.*:~\$ /);
});

test('e2e: resetting before compiler readiness does not print a prompt', () => {
  const ctx = setupTerminalHarness();

  resetTerminalSession();

  assert.equal(ctx.clearCalls.length, 1);
  assert.equal(ctx.writes.length, 0);
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

test('e2e: run without a live stdin transport reports unsupported and posts no request', async () => {
  const ctx = setupTerminalHarness({
    supportsInteractiveStdin: false,
  });

  assert.equal(await startRun(), false);
  assert.deepEqual(ctx.runCalls, []);
  assert.deepEqual(ctx.runStateChanges, []);
  assert.deepEqual(ctx.runPreparationChanges, [true, false]);
  assert.equal(__getTerminalStateForTesting().preparingRun, false);
  assert.ok(ctx.writes.join('').includes('Live terminal stdin is unavailable'));
});

test('e2e: Firefox JSPI run forwards live terminal lines and EOF by session', async () => {
  const ctx = setupTerminalHarness({
    supportsInteractiveStdin: false,
    supportsMessageInteractiveStdin: true,
  });

  assert.equal(await startRun(), true);
  assert.deepEqual(ctx.runCalls[0], {
    stdinMode: 'interactive-message',
    stdinSessionId: 'stdin-session-test',
  });

  onRunStart(ctx.runCalls[0]);
  for (const character of 'Ada') {
    __handleTerminalKeyForTesting(character, {
      key: character,
      ctrlKey: false,
      altKey: false,
    });
  }
  __handleTerminalKeyForTesting('\r', {
    key: 'Enter',
    ctrlKey: false,
    altKey: false,
  });
  __handleTerminalKeyForTesting('', {
    key: 'd',
    ctrlKey: true,
    altKey: false,
  });

  assert.equal(ctx.stdinMessages.length, 2);
  assert.equal(ctx.stdinMessages[0].type, 'stdin-data');
  assert.equal(ctx.stdinMessages[0].stdinSessionId, 'stdin-session-test');
  assert.equal(new TextDecoder().decode(ctx.stdinMessages[0].bytes), 'Ada\n');
  assert.deepEqual(ctx.stdinMessages[1], {
    type: 'stdin-eof',
    stdinSessionId: 'stdin-session-test',
  });
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
