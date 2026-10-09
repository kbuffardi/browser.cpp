# Feature: Issue 104 Memory Debug Mode Settings Panel

## Feature Description
Add an extension-wide Settings entry in the top-right toolbar that opens a right-side panel. The panel contains automatically saved on/off settings, beginning with **Memory Debug Mode**, which defaults to off. When Memory Debug Mode is on, every compilation path in browser.cpp is built with memory-error instrumentation so unsafe runtime memory access terminates the running program with a sanitizer-style diagnostic in the terminal while preserving any stdout/stderr already printed by the program.

This feature addresses GitHub Issue #104: runtime out-of-bounds memory errors currently continue silently in the WASI/WebAssembly runtime, including unsafe vector access patterns that users expect to fail loudly while debugging.

## User Story
As a browser.cpp user debugging C++ programs
I want an extension-wide Memory Debug Mode that instruments every compile
So that unsafe memory access terminates the program with a clear terminal diagnostic instead of silently reading invalid memory.

## Problem Statement
browser.cpp currently compiles C++ into WASI WebAssembly and runs it in a worker with a narrow WASI shim. Ordinary C++ undefined behavior such as `nums[2]` can read from valid WebAssembly linear memory and therefore will not necessarily produce a native WebAssembly bounds trap. Issue #104 asks for Linux-like runtime memory failures and terminal errors, but the current compile pipeline does not add sanitizer flags, does not package sanitizer runtime support, and only formats generic WebAssembly traps as `Runtime error: ...`.

The confirmed product decisions add a global Settings UI requirement: a top-right gear icon labelled `Settings`, a hamburger-like right-side panel, extension-wide persistence, auto-saving toggle controls, Memory Debug Mode default off, and no interruption of an already-running compile.

## Solution Statement
Implement Memory Debug Mode as a persisted extension setting loaded during app startup and passed into every compile request. When enabled, the compiler worker applies a single centrally defined instrumentation profile to both toolbar/shortcut compiles and terminal `g++`/`clang++` compiles. Toolchain validation confirmed that current `wasm32-unknown-wasi` Clang rejects `-fsanitize=address`, while `-fsanitize=undefined` successfully emits instrumentation but the sysroot lacks `__ubsan_handle_*` implementations. The selected design supplies fatal, source-aware UBSan handlers as validated WebAssembly imports from the compiler worker and enables libc++ debug hardening for checked container operations such as `std::vector::operator[]`. The finished module is inspected after linking so `--allow-undefined` cannot conceal ordinary unresolved user symbols.

Runtime diagnostics should flow through the existing worker `stderr` messages before `run-result`, preserving prior program output. If a sanitizer or WebAssembly runtime error occurs, the worker should terminate the run with a nonzero exit code, and the terminal should show the diagnostic followed by the existing `Process exited with code ...` line.

## Relevant Files
Use these files to implement the feature:

- `README.md` - Project architecture, compile/run pipeline, browser targets, release checks, and current runtime limitations that must be updated if Memory Debug Mode ships.
- `src/ui/index.html` - Toolbar markup for the top-right `Settings` button and the right-side settings panel shell.
- `src/ui/styles.css` - Existing dark-theme toolbar, panel, and dialog styling; add right drawer and toggle styling here.
- `src/ui/app.js` - Startup orchestration for loading extension settings, initializing the settings panel, and passing the latest setting into toolbar and terminal compile callbacks.
- `src/ui/toolbar.js` - Main compile actions, keyboard shortcuts, worker message handling, and toolbar compile payload assembly.
- `src/ui/terminal.js` - Terminal `g++`/`clang++` command flow and test harness; must ensure terminal compiles use the same Memory Debug Mode flag as toolbar compiles.
- `src/ui/build-request.mjs` - Shared compile request helpers; likely place to keep request shape or normalization logic browser-free for Node E2E tests.
- `src/ui/session-persistence.mjs` - Existing `chrome.storage.local` Promise/callback compatibility pattern to mirror, not extend with project-specific settings.
- `src/extension-api.mjs` - Existing extension API helper used to access `chrome`/`browser`; settings persistence should reuse this boundary.
- `src/workers/compiler.worker.js` - Central compile/link/run implementation; add instrumentation flags, toolchain capability reporting, and sanitizer/runtime diagnostic handling.
- `src/workers/compile-plan.mjs` - Driver plan parser; ensure sanitizer flags and extra link libraries survive `clang++ -###` plan parsing.
- `src/workers/wasi-shim.mjs` - WASI import layer; verify sanitizer-instrumented binaries do not need unsupported WASI imports, and add any narrow required imports only after explicit feasibility proof.
- `scripts/fetch-clang-wasm.js` - Fetches `clang`, `lld`, and `sysroot`; inspected during feasibility work, but no artifact change is required by the selected imported-handler design.
- `scripts/preflight-clang-artifacts.js` - Existing toolchain artifact validation; no sanitizer archive check is needed because the selected runtime support is implemented in JavaScript.
- `scripts/e2e-compiler-link.test.mjs` - Existing real Clang/LLD Node E2E harness; extend or model new sanitizer feasibility and runtime tests after this.
- `scripts/smoke-browser.mjs` - Browser smoke runner; add a focused smoke assertion that the Settings UI renders and can toggle Memory Debug Mode if practical.
- `.github/workflows/ci.yml` - Ensure any new E2E file is included through `npm run test:e2e` or targeted scripts.
- `package.json` - Add any new E2E test file to `test:e2e` and possibly add a dedicated sanitizer/toolchain validation script.

### New Files
- `src/ui/settings.mjs` - Encapsulate extension-wide settings load/save, DOM binding for the right-side panel, auto-saving toggles, and change notifications.
- `scripts/e2e-settings-memory-debug.test.mjs` - Separate E2E test file for the Settings UI and compile request propagation, as required for UI-affecting work.
- `scripts/e2e-memory-debug-toolchain.test.mjs` - Real toolchain/runtime validation for sanitizer-instrumented builds, including the Issue #104 out-of-bounds sample.

## Implementation Plan
### Phase 1: Foundation
Validate toolchain feasibility before UI work. Treat ASan as unavailable for the current target unless a future toolchain explicitly proves otherwise. Prove the UBSan WebAssembly-import runtime by compiling, linking, instantiating, and running both failing and valid programs with the current browsercc artifacts. Require source-aware reports and nonzero termination; generic trap-only reporting is not an accepted fallback.

Create an extension-wide settings module that mirrors the storage compatibility patterns from `session-persistence.mjs`, but stores settings under a separate key such as `browser_cpp_settings`. Keep the default object versioned and explicit, with `memoryDebugMode: false`.

### Phase 2: Core Implementation
Add the top-right `Settings` button with a gear icon and label. Add a right-side settings panel that opens/closes like a hamburger drawer and contains toggle controls that save immediately. Wire the panel to load settings on startup, update controls from persisted state, and notify compile callers when Memory Debug Mode changes. A toggle change applies to future compile requests only.

Thread `memoryDebugMode` into every compile request: toolbar Compile, Compile & Run, keyboard shortcuts, and terminal `g++`/`clang++`. Centralize the compile option so all entry paths produce identical worker requests and tests can verify there is no bypass.

In the worker, derive debug instrumentation flags from `request.memoryDebugMode`. Use fatal UBSan instrumentation, libc++ debug hardening, and WebAssembly-imported UBSan handlers because current ASan is rejected for `wasm32-unknown-wasi`. Keep the diagnostic profile centralized, validate all non-WASI imports in the finished module, and reject any import that is not a known UBSan handler.

### Phase 3: Integration
Format sanitizer and runtime failures in the terminal without clearing existing output. Existing stdout/stderr streaming already preserves prior output; the worker should emit sanitizer stderr before `run-result`, and terminal `onRunResult` should keep displaying nonzero exit codes. If sanitizer output lacks source lines or stack traces under WASI, surface the best available error type/address and document the limitation rather than inventing detail.

Update documentation to explain Memory Debug Mode, performance/size overhead, and known diagnostic limitations. Add E2E coverage for storage/UI behavior, compile-request propagation across every entry path, and real sanitizer behavior with the bundled or updated toolchain.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. Create a feature branch and confirm Issue #104 remains the source of truth
- Create a branch such as `feature/issue-104-memory-debug-mode`.
- Re-read GitHub Issue #104 and its confirmation comment before implementation.
- Plan for the implementation PR to include `Closes #104`.
- Do not update unrelated spec files or untracked work already present in the repository.

### 2. Add a memory-debug feasibility test before UI work
- Create `scripts/e2e-memory-debug-toolchain.test.mjs` from the existing `scripts/e2e-compiler-link.test.mjs` pattern.
- Compile and link small programs with the proposed instrumentation flags.
- Explicitly assert that current `-fsanitize=address` is not selected unless the toolchain supports it; local review observed `unsupported option '-fsanitize=address' for target 'wasm32-unknown-wasi'`.
- Run programs that perform raw-array and vector out-of-bounds access and assert the exact termination and diagnostic behavior the selected profile claims to support. Record arbitrary heap overruns as outside the supported UBSan/libc++ hardening scope because ASan is unavailable.
- Assert that a normal program still compiles and runs when instrumentation is enabled.
- If non-trap UBSan-style linking fails because sanitizer runtime libraries are missing, stop implementation and resolve the toolchain packaging task next, unless the issue owner has accepted a narrower trap/hardening fallback.

### 3. Supply and validate UBSan handlers as WebAssembly imports
- Inspect the exact missing UBSan symbols emitted by the current Clang/LLD toolchain.
- Implement the required fatal `__ubsan_handle_*` functions in the compiler worker's JavaScript import object.
- Decode UBSan source metadata from WebAssembly memory and print an error category plus file, line, and column before terminating nonzero.
- Link instrumented programs with unresolved imports enabled, then inspect the finished module and reject every non-WASI import that is not an explicitly supported UBSan handler. This prevents the link option from concealing ordinary unresolved user symbols.
- Re-run the feasibility test until both failing and valid instrumented programs build and run as expected.
- Keep the existing fetched toolchain and sysroot unchanged; this approach avoids shipping an unavailable compiler-rt sanitizer archive.

### 4. Add extension-wide settings persistence
- Create `src/ui/settings.mjs`.
- Implement load, current-value lookup, `setMemoryDebugMode()`, and a small subscription/change callback API.
- Use `chrome.storage.local`/`browser.storage.local` through `getExtensionAPI()`.
- Default to `{ memoryDebugMode: false }` when storage is unavailable or the setting is missing.
- Keep this storage separate from `browser_cpp_session` so it is extension-wide, not project-specific.

### 5. Add the Settings button and right-side panel UI
- Update `src/ui/index.html` with a top-right `button#btn-settings` containing a gear icon and the label `Settings`.
- Place the button after existing build/status controls so it visually sits at the far right.
- Add a `section#settings-panel` or equivalent right-side drawer with an accessible title and close behavior.
- Add the first setting row for `Memory Debug Mode` using a true toggle/checkbox semantics, not a save/apply form.
- Add a `(?)` help link to Clang's official UBSan documentation, opening with `target="_blank"` and `rel="noopener noreferrer"`.
- Ensure the panel can be opened and closed by the button, outside click or close control, and Escape.

### 6. Style the Settings drawer and toggles
- Update `src/ui/styles.css` to match the current compact VS Code-inspired dark UI.
- Keep the drawer fixed to the right side above the status bar or full height according to the existing layout constraints.
- Make the toggle state visually clear and keyboard-focusable.
- Avoid layout shifts in the toolbar when the panel opens.

### 7. Wire settings into app startup
- In `src/ui/app.js`, load settings before initializing compile controls that need them.
- Initialize `settings.mjs` with the DOM elements for the button, panel, and toggle.
- Keep an in-memory latest-settings value for compile callbacks.
- Apply toggle changes to later compiles only; do not terminate or mutate an active compile/run.

### 8. Thread Memory Debug Mode through every compile entry path
- Update toolbar compile payload assembly so `memoryDebugMode` is included in `worker.postMessage({ type: 'compile', ... })`.
- Update terminal `onCompile` in `app.js` to add the same setting to terminal `g++`/`clang++` requests.
- Verify F5, Ctrl+Shift+B, Compile, Compile and Run, terminal `g++`, and terminal `clang++` all pass the same setting.
- Keep user-supplied terminal flags intact while ensuring Memory Debug Mode cannot be bypassed accidentally when enabled.

### 9. Add worker instrumentation support
- Update `src/workers/compiler.worker.js` request handling and comments to include `memoryDebugMode`.
- Add a centralized function such as `memoryDebugFlagsFor(request)` that returns instrumentation compile/link flags only when enabled.
- Include debug-friendly flags such as debug info and frame pointers if supported by the WASI target.
- Preserve existing `-fno-exceptions` unless the selected sanitizer/runtime explicitly requires a different strategy.
- Ensure `getCompilePlan()`, per-TU compile steps, and final link all receive the instrumentation consistently.

### 10. Format runtime memory diagnostics
- Preserve raw sanitizer stderr output from the program.
- Add a small worker/terminal formatting layer only if needed to prepend a concise browser.cpp header such as `Memory Debug Mode detected a runtime memory error`.
- Keep prior stdout visible before the diagnostic.
- Ensure detected sanitizer failures result in a nonzero exit code and do not write misleading success messages.
- If only a generic WebAssembly trap is available, print the trap and nonzero exit, but treat that as insufficient for the Issue #104 acceptance test unless the issue owner accepts the limitation.

### 11. Create the separate Settings/Memory Debug E2E file
- Create `scripts/e2e-settings-memory-debug.test.mjs`.
- Test that default settings load with Memory Debug Mode off.
- Test toggling Memory Debug Mode saves immediately to fake extension storage without a Save button.
- Test the Settings gear+label button opens and closes the right-side panel.
- Test toolbar and terminal compile callbacks include `memoryDebugMode: true` after the toggle changes.
- Include a DOM-level screenshot/assertion hook if the existing browser smoke harness supports it; otherwise assert markup and state in Node harnesses.

### 12. Add worker/toolchain runtime tests
- Extend `scripts/e2e-memory-debug-toolchain.test.mjs` to cover:
  - the centrally defined debug profile contains fatal UBSan and libc++ hardening flags;
  - debug on: unsafe raw-array access terminates nonzero with source-aware output;
  - debug on: invalid `std::vector::operator[]` access terminates through libc++ hardening;
  - prior stdout is preserved before the memory diagnostic;
  - ordinary unresolved user symbols are rejected rather than accepted as imports;
  - a valid instrumented program still runs normally.
- Cover compile-payload propagation separately so toolbar, keyboard, and terminal entry points cannot bypass the setting.

### 13. Update documentation and help text
- Update `README.md` with the Settings panel and Memory Debug Mode behavior.
- Document that Memory Debug Mode increases build size and runtime overhead.
- Document known diagnostic limitations if source lines or stack traces are unavailable in the WASI/browser runtime.
- Link the Settings help icon to Clang's official UBSan documentation in a new tab.
- Update any terminal help only if users need to understand that terminal compiles also honor the setting.
- Align `manifest.json`, `package.json`, and `package-lock.json` at the requested minor version `0.5.0`.

### 14. Run the Validation Commands
- Execute every command listed below.
- Fix any failure before opening the PR.
- Confirm the PR description references `Closes #104`.

## Testing Strategy
### Unit Tests
- Storage module tests for default values, Promise-style storage, callback-style storage, failed storage fallback, and immediate save on toggle.
- Compile-request tests confirming toolbar and terminal paths include `memoryDebugMode`.
- Worker request tests confirming instrumentation flags are injected only when enabled and apply to all translation units and link steps.
- Compile-plan tests confirming sanitizer-related driver output is parsed without dropping compile or link steps.

### Edge Cases
- Storage unavailable outside an extension context: setting defaults off and UI remains usable.
- Setting changed during an active compile or run: active work continues unchanged; next compile uses the new value.
- Terminal user passes conflicting flags: Memory Debug Mode should still instrument unless explicitly documented otherwise.
- Multi-file workspace compile: every translation unit is instrumented.
- No workspace single-buffer compile: Memory Debug Mode still applies.
- Sanitizer runtime emits diagnostics on stderr before exiting: terminal preserves prior stdout/stderr ordering as much as the worker stream allows.
- Sanitizer runtime lacks source lines or stack traces: terminal shows available details without fabricating unsupported fields.
- Instrumented module references an unknown or user-defined import: post-link validation fails the build before execution.

## Acceptance Criteria
- Top-right toolbar contains a gear icon and visible `Settings` label.
- Clicking `Settings` opens a right-side settings panel; the panel can be closed and is keyboard accessible.
- Panel contains a `Memory Debug Mode` on/off toggle as the first setting.
- Memory Debug Mode defaults to off for fresh storage.
- Toggling Memory Debug Mode saves automatically to extension-wide storage with no Save or Apply button.
- The setting is not tied to a project, workspace folder, or session restore snapshot.
- The setting row includes a `(?)` link to the official Clang UBSan documentation that opens in a new tab without exposing `window.opener`.
- When enabled, toolbar Compile, Compile and Run, F5, Ctrl+Shift+B, terminal `g++`, and terminal `clang++` all produce instrumented builds.
- The setting applies to future compiles and does not interrupt currently running compiles/runs.
- Unsafe out-of-bounds memory access in the Issue #104 sample terminates nonzero when Memory Debug Mode is enabled, subject to the validated sanitizer/runtime support.
- Terminal output preserves program output printed before the memory failure.
- Terminal shows a detailed diagnostic with error type plus address/source/stack details where supported by the toolchain.
- Existing non-debug compiles, runs, file I/O, stdin, and multi-file builds continue to pass.
- Release metadata is aligned at version `0.5.0`.

## Validation Commands
Execute every command to validate the feature works correctly with zero regressions.

```bash
npm ci
npm run fetch-clang
npm run lint
npm run build
npm run test:e2e
node --experimental-detect-module --test scripts/e2e-settings-memory-debug.test.mjs
node --experimental-detect-module --test scripts/e2e-memory-debug-toolchain.test.mjs
npm run test:e2e:compiler
npm run test:browser:chrome
```

Because this is a minor-version release, also run:

```bash
npm run package:release
```

## Notes
- Inspection of `dist/clang/sysroot.tar` found `lib/clang/20/lib/wasm32-unknown-wasi/libclang_rt.builtins.a` but no obvious `libclang_rt.asan*`, `ubsan`, or sanitizer runtime archive. Feasibility testing established:
  - `-fsanitize=address` fails at driver time with `unsupported option '-fsanitize=address' for target 'wasm32-unknown-wasi'`.
  - `-fsanitize=undefined` emits calls to UBSan handler symbols such as `__ubsan_handle_out_of_bounds`; browser.cpp now fulfills the supported handler set through validated WebAssembly imports.
  - `-fsanitize=bounds -fsanitize-trap=bounds` links and terminates a local array out-of-bounds example, but produces only a generic WebAssembly trap.
  - `_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE` catches `std::vector::operator[]` in the issue sample, but also presents as a generic trap.
- WebAssembly traps alone are not enough for Issue #104 because many C++ out-of-bounds accesses stay within linear memory and will not trap.
- `std::vector::at()` behavior may depend on libc++ exception/assertion support. The project currently compiles with `-fno-exceptions` because the bundled WASI libc++abi lacks exception support, so Memory Debug Mode should focus on sanitizer/hardening behavior that is actually validated in this runtime.
- The implementation PR should be opened from `feature/issue-104-memory-debug-mode`, include `Closes #104`, and release version `0.5.0`.
