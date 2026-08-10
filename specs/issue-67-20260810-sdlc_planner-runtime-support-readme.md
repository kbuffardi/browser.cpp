# Feature: README Runtime Support Summary

## Feature Description
Update `README.md` to concisely summarize which C++ language, STL, standard-library-adjacent, and runtime features are supported in browser.cpp and which are unsupported or limited by the browser/WASI runtime. The documentation should help users set expectations before writing programs in the in-browser IDE without implying that the project maintains an exhaustive STL compatibility matrix.

## User Story
As a browser.cpp user
I want a concise README summary of supported and unsupported C++/STL/runtime features
So that I can quickly tell whether my program is likely to compile and run correctly in the browser sandbox.

## Problem Statement
The README currently states that C++14/C++17/C++20 are selectable, documents `fstream` support, and lists a few known limitations. It does not provide a single compact compatibility summary that answers common user questions about STL support, filesystem behavior, networking, threads, environment variables, process APIs, stdin, and other WASI-dependent runtime features. This leaves users guessing which failures are bugs versus expected limitations of the in-browser WASI/WebAssembly execution model.

## Solution Statement
Add a concise `README.md` section near the existing runtime/File I/O documentation or Known limitations that summarizes compatibility in two small lists or a compact table:

- Supported: C++14/C++17/C++20 compilation, common in-memory libc++/STL facilities from the bundled sysroot, stdout/stderr, live line-buffered stdin where browser support exists, random, wall-clock time, and workspace-backed `fstream`/`ifstream`/`ofstream`.
- Unsupported or limited: no networking/sockets, no subprocesses or shell/process control, no real environment variables, fixed argv, no reliable thread support, no OS-level filesystem behavior beyond the VFS/workspace write-back model, no raw POSIX PTY, no full locale database guarantee, and no exhaustive STL guarantee beyond the bundled WASI libc/libc++ sysroot.

Keep the wording factual and grounded in the current shim implementation (`src/workers/wasi-shim.mjs`) and existing browser compatibility notes. Do not change runtime behavior, dependencies, build scripts, release automation, or version numbers.

## Relevant Files
Use these files to implement the feature:

- `README.md`
  - Primary documentation target. Already documents standards, `fstream`/File I/O, terminal behavior, browser compatibility, release checks, and Known limitations.
- `src/workers/wasi-shim.mjs`
  - Source of truth for currently implemented WASI runtime calls: stdio, stdin modes, `args_*`, `environ_*`, file open/read/write/seek/stat/unlink, directory creation stub, clock, and random.
- `src/workers/compiler.worker.js`
  - Confirms the compile/run pipeline, default `-std=c++20`, bundled sysroot loading, and WASI runtime instantiation.
- `src/ui/terminal.js`
  - Confirms terminal-facing stdin behavior and that browser.cpp is not a real shell or PTY.
- `src/ui/browser-capabilities.mjs`
  - Confirms Chromium SharedArrayBuffer stdin support and Firefox JSPI gating.
- `scripts/e2e-wasi-shim.test.mjs`
  - Existing test coverage for WASI stdin and `fstream`-style runtime behavior; useful for validating documentation claims against behavior.
- `scripts/e2e-firefox-jspi-stdin.test.mjs`
  - Existing coverage for Firefox JSPI stdin behavior and unsupported stdin states.
- `package.json`
  - Source for project validation commands: lint, build, and E2E.

## Implementation Plan
### Phase 1: Foundation
Review the current README sections for overlap, especially `fstream / File I/O`, `Browser compatibility and releases`, and `Known limitations`. Confirm every new compatibility claim against `src/workers/wasi-shim.mjs`, the compiler worker, terminal stdin code, and existing tests.

### Phase 2: Core Implementation
Edit only `README.md` to add a short support summary section. Prefer a concise table or two short bullet groups. Avoid long lists of individual STL headers. Explicitly state that browser.cpp does not publish an exhaustive STL support matrix and that availability depends on the bundled WASI libc/libc++ sysroot plus the narrow runtime shim.

### Phase 3: Integration
Place the new summary where users will find it before or around runtime details. Cross-check for duplicated or conflicting Known limitations text. Keep existing File I/O details intact, but make sure the new section points users to the `fstream / File I/O` section for workspace write-back details.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. Verify Existing Issue and Branch Context
- Confirm GitHub issue #67 exists and describes the README support-summary request.
- Create or use a feature branch dedicated to the issue.
- Preserve unrelated untracked or modified files; do not revert user or previous-agent changes.

### 2. Re-read Documentation and Runtime Sources
- Read `README.md` from top to bottom.
- Read `src/workers/wasi-shim.mjs` and note the exact WASI imports implemented.
- Skim `src/workers/compiler.worker.js`, `src/ui/terminal.js`, and `src/ui/browser-capabilities.mjs` for compile standard, sysroot, stdin, and browser-capability details.

### 3. Draft the README Summary
- Add a section with a title like `## C++ and runtime support` or `## Supported and unsupported C++ runtime features`.
- Keep the section concise enough to scan in under a minute.
- Include supported items:
  - selectable C++14, C++17, and C++20 compilation via WASM Clang
  - common in-memory libc++/STL facilities available from the bundled sysroot
  - stdout/stderr
  - live line-buffered stdin on supported Chromium and Firefox JSPI runtimes
  - workspace-backed `fstream`, `ifstream`, `ofstream`, and `getline` file reads/writes
  - wall-clock time and random bytes
- Include unsupported or limited items:
  - no sockets/networking
  - no subprocesses, shell execution, `system`, `fork`, or `exec`
  - no real environment variables; `getenv`/environment enumeration should be documented as empty
  - fixed program arguments, currently only `./a.out`
  - no reliable `std::thread`/thread-backed concurrency support
  - no full OS filesystem; directory iteration, symlinks, permissions, and other host filesystem semantics should not be promised
  - no raw POSIX PTY
  - locale database and platform-specific facilities are not guaranteed
- State that this is not an exhaustive STL matrix.

### 4. Reconcile Existing README Sections
- Remove or tighten duplicated Known limitations bullets only if they become redundant.
- Keep the detailed `fstream / File I/O` section as the canonical explanation for VFS write-back.
- Keep browser compatibility notes intact, especially Firefox JSPI stdin limitations.
- Ensure there are no contradictory statements about filesystem support or standard library support.

### 5. Review the Documentation Diff
- Run `git diff -- README.md` and inspect the exact wording.
- Check that the change is README-only except for this plan file if the plan is still in the branch.
- Verify the issue is referenced in the PR body rather than adding issue-management text into the README.

### 6. Run Validation Commands
- Execute every command listed in the `Validation Commands` section.
- If any validation fails, fix only documentation-related issues or report unrelated failures clearly.

### 7. Commit, Push, and Open the PR
- Commit the README update with a focused message.
- Push the feature branch.
- Open a pull request against `main`.
- Link the PR to issue #67 with `Closes #67`.
- In the PR body, summarize that the change documents supported and unsupported C++/STL/runtime behavior without changing runtime code.

## Testing Strategy
### Unit Tests
No new unit tests are required because this is a documentation-only README update. Existing runtime tests are used as source-backed validation that the documented behavior still matches implementation.

### Edge Cases
- The README must not imply that every C++20 library facility works.
- The README must not imply that unsupported OS features are bugs.
- The README must not overstate `std::filesystem` support; path manipulation may compile through libc++, but host directory and metadata semantics are runtime-limited.
- The README must distinguish workspace-backed file streams from general host filesystem access.
- The README must not conflict with Firefox stdin support notes.
- The README must not claim thread support unless the runtime implementation and browser support prove it.

## Acceptance Criteria
- `README.md` includes a concise, easy-to-scan summary of supported and unsupported C++/STL/runtime features.
- The summary explicitly says compatibility is not exhaustive and depends on the bundled WASI libc/libc++ sysroot plus browser.cpp's runtime shim.
- The summary documents support for common in-memory STL use, workspace-backed file streams, stdout/stderr, supported live stdin, wall-clock time, and random bytes.
- The summary documents limitations for networking, subprocesses, environment variables, program arguments, threads, host filesystem semantics, raw PTY behavior, and locale/platform-specific behavior.
- No runtime code, dependency, release, manifest, or version changes are included.
- A PR is opened and linked to issue #67 with `Closes #67`.

## Validation Commands
Execute every command to validate the feature works correctly with zero regressions.

```bash
git diff -- README.md
npm run lint
npm run build
npm run test:e2e
```

For final PR sanity:

```bash
git status --short
gh pr view --json number,title,state,isDraft,headRefName,baseRefName,url,body
```

## Notes
- Keep the README wording deliberately conservative. The most important user-facing point is that browser.cpp supports ordinary in-memory C++20 patterns and workspace-backed file streams, while OS-dependent behavior is constrained by a narrow WASI shim.
- This issue should not bump the extension version to v0.4.4 unless a separate release/version issue explicitly asks for it. The user wording "open a pr as v0.4.4" should be interpreted in the PR title/body as documentation for the current v0.4.4 work only if the repository is already on that release track; do not edit `manifest.json` or `package.json` for this README-only task.
