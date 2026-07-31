# Feature: Firefox 153+ live terminal stdin with WebAssembly JSPI

## Feature Description

Add live, prompt-by-prompt terminal input for C/C++ programs running in Firefox 153 and newer by using WebAssembly JavaScript Promise Integration (JSPI). A program blocked in WASI `fd_read` should suspend its WebAssembly stack, allow the compiler worker to receive terminal input messages, and resume when the user submits a line or EOF.

The existing Chromium `SharedArrayBuffer`/Atomics path must remain the first-choice path and retain its current behavior. Firefox versions or environments without JSPI must keep the existing pre-supplied buffered-stdin fallback. Persistent folder write-back is explicitly out of scope.

This issue follows merged PR #54 and supersedes only its Firefox live-stdin limitation; it does not remove the buffered fallback.

## User Story

As a Firefox 153+ user,
I want a running C++ program to display a prompt and wait for input in the terminal,
so that `std::cin`, `std::getline`, `scanf`, and similar line-oriented console workflows behave interactively without changing Chromium behavior.

## Problem Statement

The current WASI `fd_read` contract is synchronous. Chromium can block the worker with `Atomics.wait()` because extension pages opt into cross-origin isolation and can share a `SharedArrayBuffer`. Firefox extension pages cannot use that transport, so PR #54 collects all stdin before execution.

Firefox 153 enables JSPI (`WebAssembly.Suspending` and `WebAssembly.promising`), which can suspend WebAssembly while an imported JavaScript function awaits a Promise. browser.cpp does not detect or use that capability, and its UI↔worker contract has no message-based live-stdin variant.

## Solution Statement

Add an explicit, additive `interactive-message` stdin variant for Firefox JSPI runs while preserving all existing variants:

```js
// Existing Chromium path; semantics and fields remain unchanged.
{ type: 'run', stdinMode: 'interactive', sharedBuffer, ... }

// New Firefox 153+ path.
{ type: 'run', stdinMode: 'interactive-message', stdinSessionId, ... }
{ type: 'stdin-data', stdinSessionId, bytes: Uint8Array }
{ type: 'stdin-eof', stdinSessionId }

// Existing fallbacks remain unchanged.
{ type: 'run', stdinMode: 'buffered', stdinBuffer, ... }
{ type: 'run', stdinMode: 'none', ... }
```

The compiler worker will feature-detect JSPI in its own global scope and report that capability to the UI. For `interactive-message`, it will wrap the WASI `fd_read` import with `WebAssembly.Suspending`, wrap `_start` with `WebAssembly.promising`, and await terminal bytes through a per-run queue. Data arriving before a read is queued; an empty queue suspends; EOF resolves the current and all future reads with `nread = 0`.

Transport selection order is fixed:

1. Existing SAB/Atomics interactive stdin whenever the current Chromium capability gate succeeds.
2. JSPI message stdin only for Firefox when both worker-side JSPI functions are available.
3. Existing pre-supplied buffered stdin otherwise.

Use feature detection as the execution authority rather than trusting the Firefox version string alone. Firefox 153 is the documented support floor for JSPI live input, while the extension's existing Firefox 140+ buffered support remains available.

## Relevant Files

- `src/workers/run-request.mjs` — extend and validate the run/input discriminated union without changing existing variants.
- `src/workers/wasi-shim.mjs` — add the queued asynchronous stdin source and expose narrowly scoped data/EOF methods while preserving synchronous SAB, buffered, file-descriptor, and VFS behavior.
- `src/workers/compiler.worker.js` — report worker-side JSPI support, select the wrapped import/export only for `interactive-message`, route session-scoped input messages, and reject stale or malformed input.
- `src/ui/terminal.js` — choose the Firefox JSPI mode, route Enter/Ctrl+D through callbacks, preserve canonical line editing and Ctrl+C termination, and retain the SAB implementation unchanged.
- `src/ui/app.js` — forward session-scoped stdin data/EOF messages to the current worker and clear transport state when the worker is replaced.
- `src/ui/toolbar.js` — consume additive compiler capability/run-start metadata and preserve compile/run/stop state transitions.
- `src/ui/browser-capabilities.mjs` — distinguish SAB interactivity, JSPI availability, effective live stdin, transport, and buffered fallback in compatibility output.
- `scripts/e2e-run-request.test.mjs` — contract validation for the new run and input variants, including invalid and stale session data.
- `scripts/e2e-wasi-shim.test.mjs` — queued async reads, repeated reads, multiple iovecs, EOF, UTF-8, and unchanged synchronous modes.
- `scripts/e2e-terminal-stop.test.mjs` — terminal mode selection, line delivery, EOF, cancellation, and worker restart behavior.
- `scripts/e2e-browser-compatibility.test.mjs` — Chromium non-regression assertions.
- `scripts/e2e-firefox-compatibility.test.mjs` — Firefox 153+ JSPI and pre-153/no-JSPI fallback assertions.
- `scripts/smoke-browser.mjs` — keep Chromium's expected SAB transport explicit in browser smoke checks.
- `scripts/smoke-firefox.mjs` — retain package validation and report the JSPI runtime acceptance requirement.
- `README.md`, `docs/firefox-stdin-runtime-acceptance.md`, and `docs/release-playbook.md` — document the support matrix and exact real-Firefox acceptance evidence.
- `package.json` — include the new focused E2E file in `npm run test:e2e`.

### New Files

- `scripts/e2e-firefox-jspi-stdin.test.mjs` — focused integration test for capability negotiation, message routing, asynchronous WASI suspension/resumption, prompt ordering, line input, EOF, and buffered fallback.

## Implementation Plan

### Phase 1: Foundation

Define the additive worker protocol and capability handshake first. Add failing contract and runtime tests before modifying production code. Keep session identity explicit so late input from a completed run cannot feed a later process.

### Phase 2: Core Implementation

Implement an asynchronous queued stdin source in the WASI layer and use JSPI wrappers only for the new mode. Add worker routing and terminal message delivery while leaving the existing SAB code path structurally intact.

### Phase 3: Integration

Connect worker capability reporting to Firefox-only transport selection, update user-facing compatibility text, prove fallback behavior, run real Firefox acceptance, and execute explicit Chromium regressions.

## Step by Step Tasks

### 1. Define the additive stdin protocol with failing tests

- Add `interactive-message` to the validated run-request union without modifying accepted `interactive`, `buffered`, or `none` payloads.
- Require a non-empty, bounded `stdinSessionId` for the new mode and prohibit `sharedBuffer`/`stdinBuffer` on that variant.
- Define `stdin-data` and `stdin-eof` message validation: matching session ID, `Uint8Array`/`ArrayBuffer` bytes, bounded chunk size, and no bytes on EOF.
- Specify consistent invalid-message behavior: never crash the worker, never mutate another run, and emit a diagnostic suitable for tests without exposing internal state.
- Keep the run request as the only message that can create an input session.

### 2. Add the focused Firefox JSPI E2E test file

- Create `scripts/e2e-firefox-jspi-stdin.test.mjs` before implementation.
- Use controlled JSPI-compatible test doubles or a minimal Wasm fixture to demonstrate: prompt output precedes input, execution suspends at `fd_read`, a submitted line resumes execution, a second read can suspend again, and Ctrl+D produces deterministic EOF.
- Assert that absent JSPI selects buffered input and never opens a message session.
- Assert that a Chromium-like environment continues selecting the SAB request and never sends message-stdin traffic.
- Add the file to `npm run test:e2e`.

### 3. Implement the asynchronous WASI stdin source

- Add an internal byte queue with cursor-based reads; do not use repeated `Array.shift()` for byte consumption.
- Expose methods such as `pushStdin(bytes)`, `endStdin()`, and `cancelStdin()` only for `interactive-message` runtimes.
- Make async `fd_read` fill all requested iovecs in order, wait only when no data is available, and return promptly once at least one queued chunk can satisfy the read.
- Resolve EOF as `WASI_ERRNO_SUCCESS` with `nread = 0`, including repeated reads after EOF.
- Preserve synchronous SAB, buffered, `none`, and regular-file reads byte-for-byte.

### 4. Add worker-side JSPI capability negotiation and execution

- Feature-detect both `WebAssembly.Suspending` and `WebAssembly.promising` in the compiler worker.
- Add worker capability metadata to `compiler-ready` without changing existing fields or timing.
- For `interactive-message` only, wrap the `fd_read` import in `WebAssembly.Suspending` and invoke `_start` through `WebAssembly.promising`; keep direct `_start()` for every existing mode.
- Maintain one active stdin session, queue early data, route matching input, ignore/reject stale sessions, and clear state in `finally` after success, exit, or failure.
- Verify that the existing thrown `proc_exit` sentinel and runtime errors are normalized correctly through the promising export.

### 5. Route Firefox terminal input through worker messages

- Store worker-reported JSPI capability in the UI and update it whenever `setWorker()` installs a replacement worker.
- Generate a fresh session ID for each message-interactive run.
- Reuse the current terminal's canonical line editing: printable characters echo locally, Enter sends UTF-8 bytes plus `\n`, Ctrl+D on an empty line sends EOF, and Ctrl+C terminates/replaces the worker.
- Refactor delivery behind a transport-neutral helper so SAB flushing remains unchanged and message mode calls the new app callbacks.
- Ensure input before `run-start`, after completion, or for an old worker is not delivered.

### 6. Select the transport without changing Chromium behavior

- Preserve the existing SAB capability predicate and evaluate it first.
- Select message-interactive stdin only when the browser family is Firefox and the execution worker reports JSPI.
- Keep buffered collection for Firefox 140–152, Firefox 153+ with JSPI disabled/unavailable, and any other non-SAB unsupported context.
- Do not add JSPI manifest permissions, change Chromium COOP/COEP settings, or change the Firefox `strict_min_version` while buffered support remains available.

### 7. Update compatibility reporting and documentation

- Report separate fields for SAB support, JSPI support, effective live-input support, and selected transport.
- Remove the “live interactive terminal input is unavailable” limitation only when Firefox can actually negotiate worker-side JSPI.
- Document Firefox 153+ live line-buffered input, Firefox 140–152 buffered input, Chromium SAB input, and the fact that this is not a full POSIX PTY/raw terminal.
- Update the runtime acceptance guide to type input only after each prompt and record Firefox version, output ordering, Ctrl+D behavior, and console errors.
- Explicitly state that persistent folder write-back remains out of scope and retains its existing limitation.

### 8. Add regression and failure-path coverage

- Test UTF-8, empty lines, input split across chunks, multiple iovecs, multiple sequential reads, input queued before `fd_read`, EOF before/while waiting, and EOF after partial data.
- Test malformed bytes, missing/wrong session IDs, duplicate EOF, data after EOF, run completion, runtime exception, and worker replacement during a suspended read.
- Assert no buffered-input dialog appears on a JSPI-capable Firefox run.
- Assert the dialog still appears when JSPI is absent.
- Assert existing Chromium request shape, SAB synchronization, prompt behavior, Ctrl+C, compile/run flow, stdout/stderr ordering, and VFS write-back tests remain unchanged.

### 9. Perform real browser acceptance

- In Firefox 153+, load `dist-firefox`, compile a two-prompt `std::cin`/`std::getline` program, and enter each response only after its prompt appears.
- Confirm the buffered-input dialog does not appear, output ordering is correct, Ctrl+D reaches EOF, Ctrl+C stops a blocked program, and rerunning starts a clean session.
- Repeat with JSPI unavailable (an older supported Firefox or controlled capability override) and confirm the pre-supplied buffered fallback still works.
- Run the existing Chrome smoke and manually confirm its run request uses the SAB path and interactive behavior is unchanged.

### 10. Run all validation commands and prepare the PR

- Implement on `feature/firefox-jspi-stdin`, based on current `main` after merged PR #54.
- Run every command below and record results plus Firefox runtime evidence in the PR.
- Open a PR containing `Closes #55` and leave approval/merge to a human.

## Testing Strategy

### Unit and Contract Tests

- Validate every run/input message variant at the worker boundary.
- Test queued asynchronous WASI reads independently from browser UI.
- Test terminal transport selection and keystroke routing with deterministic harnesses.
- Test capability negotiation independently in window-like and worker-like contexts.

### End-to-End Tests

- Use the new focused E2E file to exercise UI-to-worker message flow and Wasm suspend/resume behavior.
- Keep the exact manual Firefox extension test because Node mocks and `web-ext lint/build` do not prove JSPI availability in a signed extension context.
- Run Chromium browser smoke as a mandatory non-regression gate.

### Edge Cases

- Firefox reports version 153+ but JSPI functions are unavailable.
- JSPI functions exist on the window but not in the execution worker.
- Input arrives before the program first calls `fd_read`.
- A read spans several iovecs or receives a line larger than one message chunk.
- EOF arrives with queued bytes, while suspended, more than once, or after completion.
- Ctrl+C terminates while `_start` is suspended.
- A stale message arrives after worker replacement or a new run starts.
- `proc_exit`, traps, rejected promises, and malformed input clean up the active session.
- Existing Chromium cross-origin-isolated execution still uses only SAB/Atomics.

## Acceptance Criteria

- Firefox 153+ with worker-side JSPI support displays program prompts before accepting terminal input and resumes correctly after each submitted line.
- `std::cin`, `std::getline`, and `scanf` line-oriented programs work through repeated reads; Ctrl+D yields EOF and Ctrl+C stops the process.
- Firefox never requires `SharedArrayBuffer`, `crossOriginIsolated`, or COOP/COEP for the JSPI path.
- Firefox without JSPI retains the current accessible pre-supplied buffered-input flow.
- Chromium-family browsers retain the existing `stdinMode: 'interactive'` plus `SharedArrayBuffer` request shape and observable behavior.
- Stale, malformed, or post-EOF input cannot cross run/session boundaries or crash the worker.
- Existing VFS, runtime file output, compiler lifecycle, stop/restart, packaging, and release behavior are unchanged.
- Compatibility text and documentation accurately describe Firefox 153+, older Firefox fallback, and the remaining filesystem limitation.
- All automated commands pass and real Firefox/Chrome evidence is attached to the PR.

## Validation Commands

Execute in order:

```bash
npm ci
npm run fetch-clang
node --experimental-detect-module --test scripts/e2e-run-request.test.mjs
node --experimental-detect-module --test scripts/e2e-wasi-shim.test.mjs
node --experimental-detect-module --test scripts/e2e-terminal-stop.test.mjs
node --experimental-detect-module --test scripts/e2e-firefox-jspi-stdin.test.mjs
node --experimental-detect-module --test scripts/e2e-browser-compatibility.test.mjs scripts/e2e-firefox-compatibility.test.mjs
npm run lint
npm run build
npm run test:e2e
npm run test:preflight-clang
npm run test:browser:firefox
npm run test:browser:chrome
npm run version:check
npm run release:check-version
```

Then complete the updated `docs/firefox-stdin-runtime-acceptance.md` procedure in Firefox 153+ and record:

- Firefox version and tested artifact path
- exact prompt/output ordering
- input entered after each prompt
- Ctrl+D and Ctrl+C results
- absence of the buffered-input dialog
- absence of `SharedArrayBuffer`, JSPI, unhandled rejection, and worker-session errors

## Notes

- Human request from @kbuffardi: “ignore the file persistence feature for now and finish the plan to only handle live cin in terminal”
- Planned by Codex plan-agent (GPT-5) using the repository's required GitHub workflow.
- JSPI is the suspension mechanism; `postMessage` is the data transport. A plain message-only implementation without JSPI cannot unblock synchronous Wasm `fd_read`.
- “Live terminal input” means canonical, line-buffered interaction. Raw-mode PTY behavior, terminal ioctls, job control, signals beyond the existing stop behavior, and character-at-a-time applications are not included.
- No new runtime dependency is expected.
- Persistent Firefox folder write-back, OPFS, downloads-based export, native messaging, and all Chromium filesystem behavior are out of scope.
- Official references:
  - Firefox 153 JSPI release notes: https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/153
  - `WebAssembly.Suspending`: https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Suspending
  - Firefox extension-page SharedArrayBuffer tracking: https://bugzilla.mozilla.org/show_bug.cgi?id=1673477
