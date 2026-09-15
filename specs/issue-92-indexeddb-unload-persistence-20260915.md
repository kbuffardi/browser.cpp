# Implementation Plan: Issue #92 — move directory-handle persistence out of tab unload

## Overview

Fix the Chrome crash reported in issue #92 by preventing browser.cpp from
opening IndexedDB and storing a live `FileSystemDirectoryHandle` while the
extension page is unloading. Persist the handle when a folder is acquired or
reconnected, persist serializable workspace and tab state proactively during
normal interaction, and perform no asynchronous persistence from
`beforeunload`.

This plan supersedes the earlier output-backpressure and unload-worker plans.
No production implementation has started.

## Decision record

> @kbuffardi: "discard the previous plan and write a new plan that adopts this newly diagnosed fix"

Codex (GPT-5) replaced the prior plans with the IndexedDB/unload-persistence
plan below, based on the folder/no-folder and DevTools diagnostic results.

## Evidence and diagnosis

### Observed

- Closing the extension without opening a folder does not crash Chrome.
- Opening the original project and closing the tab crashes without rerunning
  its infinite-loop program.
- Opening a different empty folder and closing the tab also crashes.
- After opening an empty folder, replacing `IDBFactory.prototype.open` with a
  function that throws prevents the close-tab crash.
- The current `beforeunload` handler calls `worker.terminate()` and then
  `persistenceGate.persist()`.
- `persistSession()` obtains the live directory handle and calls
  `handleStore.save(dirHandle)`, which opens IndexedDB and stores that handle.

### Conclusion and confidence

The DevTools experiment is a strong discriminator: it left the live directory
handle, worker termination, page teardown, and subsequent serializable-storage
path in place, but prevented the unload-time IndexedDB open/write. The
application-controlled trigger is therefore, with high confidence, the
IndexedDB operation that stores the directory handle during page teardown.

The native `ThreadPoolForegroundWorker` crash is ultimately a Chrome defect;
the application fix is to avoid initiating this unsafe browser path. The
experiment does not identify the faulty Chrome native component or prove that
all IndexedDB directory-handle writes are unsafe outside unload.

## Architecture decisions

- Split directory-handle persistence from serializable session-state
  persistence. A normal tab/editor/workspace state save must never write or
  clear IndexedDB.
- Save the directory handle only at stable workspace lifecycle boundaries:
  successful folder open, folder reconnect, and save-to-folder acquisition.
- Clear the stored handle only during an explicit abandon/new-project flow.
- Save JSON-safe workspace, tab, and editor state proactively and with a short
  debounce during normal interaction so correctness does not depend on unload.
- `beforeunload` must start no IndexedDB or `chrome.storage` operation. Keep the
  existing synchronous `worker.terminate()` behavior unchanged: the successful
  diagnostic close still exercised it, so it is not the trigger isolated here.
- Preserve the existing IndexedDB database, object store, and key so previously
  saved sessions remain compatible.

## Scope

### In scope

- Refactor the session-persistence API into explicit handle, state, and clear
  operations.
- Update folder acquisition/reconnection paths to save the handle immediately.
- Persist current active-editor content and other serializable session state
  before unload through event-driven/debounced saves.
- Remove asynchronous persistence from `beforeunload`.
- Preserve live-handle restore, snapshot-only fallback, startup gating, and
  explicit session abandonment.
- Add focused persistence tests and real-Chrome/manual close verification.

### Out of scope

- Terminal output backpressure, run generations, xterm queues, and compiler
  worker protocol changes.
- Changes to STOP or its terminate-and-replace behavior.
- Changes to Chrome, macOS, or the Clang/WASM toolchain.

## Task 1: Classify and lock down persistence responsibilities

**Description:** Audit every current persistence caller and classify it as a
handle save, state-only save, full clear, or no persistence. Establish a clear
API contract in `createSessionPersistence()`; recommended operations are
`persistWorkspaceSession()`, `persistSessionState()`, and
`clearPersistedSession()`.

**Acceptance criteria:**

- [ ] `persistSessionState()` writes only JSON-safe data to
  `chrome.storage.local` and never calls `handleStore.save()` or
  `handleStore.clear()`.
- [ ] `persistWorkspaceSession()` stores the current directory handle and then
  persists the serializable state, even if handle storage fails.
- [ ] `clearPersistedSession()` clears both stores only for an explicit abandon
  flow.
- [ ] Restore continues to use `browser-cpp-handles` / `handles` /
  `workspace-dir` without a migration.

**Verification:**

- [ ] Focused tests distinguish handle-store calls from storage-area calls.
- [ ] Existing live-handle and snapshot-fallback restore tests pass.

**Dependencies:** None.

**Files likely touched:**

- `src/ui/session-persistence.mjs`
- `scripts/e2e-session-persistence.test.mjs`
- `scripts/e2e-session-restore-choice.test.mjs`

**Estimated scope:** Medium (3 files).

## Task 2: Make startup gating support explicit persistence intents

**Description:** Adapt `createPersistenceGate()` so calls made while startup
restore is pending retain their intent. A queued workspace save must not be
downgraded to a state-only save; when enabled, the gate should perform the
strongest pending operation once. Add a debounced state-save entry point for
frequent editor changes, while keeping workspace acquisition saves immediate.

**Acceptance criteria:**

- [ ] A folder opened before restore completes is saved to IndexedDB after the
  gate enables.
- [ ] Multiple queued state changes coalesce without losing the latest state.
- [ ] An immediate workspace save is not delayed behind the editor debounce.
- [ ] Enabling the gate with no pending work performs no storage operation.

**Verification:**

- [ ] Extend persistence-gate tests for queued state, queued workspace, and
  coalescing behavior.

**Dependencies:** Task 1.

**Files likely touched:**

- `src/ui/session-persistence.mjs`
- `scripts/e2e-session-persistence.test.mjs`

**Estimated scope:** Small (2 files).

## Task 3: Persist handles at workspace acquisition boundaries

**Description:** Wire the explicit workspace-save operation into the toolbar
paths that obtain a real directory handle. This includes `openFolderWorkspace`,
the folder acquired by `saveUntitledDocument`, and the folder reconnect path
used after snapshot-only restore. All ordinary tab, file, and workspace
mutations must use state-only persistence.

**Acceptance criteria:**

- [ ] A successfully opened or reconnected folder saves its handle immediately
  and records the corresponding serializable session state.
- [ ] Cancelling the picker or failing to open a folder writes neither store.
- [ ] Tab switches, tab closes, saves, file creation, filesystem refreshes, and
  other ordinary mutations do not touch IndexedDB.
- [ ] Explicitly abandoning a saved session clears both the handle and state.

**Verification:**

- [ ] Toolbar/session integration tests assert handle-store call counts and
  timing for open, reconnect, cancel, mutation, and abandon paths.

**Dependencies:** Tasks 1–2.

**Files likely touched:**

- `src/ui/app.js`
- `src/ui/toolbar.js`
- `scripts/e2e-session-persistence.test.mjs`
- `scripts/e2e-session-restore-choice.test.mjs`

**Estimated scope:** Medium (4 files).

## Checkpoint: persistence boundaries

- [ ] Handle writes occur only at explicit workspace acquisition boundaries.
- [ ] Existing restore and startup-race tests pass.
- [ ] Snapshot-only sessions remain restorable when IndexedDB is unavailable.

## Task 4: Preserve active editor state without unload persistence

**Description:** Make `getOpenTabsSnapshot()` include the current editor value
for the active tab instead of relying on a later tab switch. Schedule a
debounced state-only save from editor content changes after dirty state is
updated. Retain immediate state saves for lower-frequency structural changes.

**Acceptance criteria:**

- [ ] Editing the active tab and waiting for the debounce persists its latest
  content without a tab switch or unload event.
- [ ] Rapid edits coalesce instead of writing storage once per keystroke.
- [ ] Multiple tabs restore with the correct active path and latest captured
  contents.
- [ ] Editor-driven saves never open IndexedDB.

**Verification:**

- [ ] Add coverage for an edited active tab, multiple tabs, debounce
  coalescing, and state-only handle-store call counts.

**Dependencies:** Tasks 1–3.

**Files likely touched:**

- `src/ui/app.js`
- `src/ui/toolbar.js`
- `scripts/e2e-session-persistence.test.mjs`

**Estimated scope:** Medium (3 files).

## Task 5: Remove asynchronous persistence from unload

**Description:** Change the `beforeunload` handler so it performs only the
existing synchronous worker termination. Do not flush, schedule, or initiate
session persistence from unload. Update the adjacent comment to document that
all session persistence is proactive.

**Acceptance criteria:**

- [ ] Closing the extension page does not call the persistence gate.
- [ ] Page unload cannot initiate `indexedDB.open()`, `handleStore.save()`,
  `handleStore.clear()`, or `chrome.storage.local.set()` through session
  persistence.
- [ ] STOP and its worker replacement remain unchanged.

**Verification:**

- [ ] Add a small testable lifecycle helper only if needed to assert the unload
  contract without importing the full UI bootstrap.
- [ ] Otherwise, cover the contract through focused persistence tests plus the
  Chrome close-path verification in Task 6.

**Dependencies:** Task 4.

**Files likely touched:**

- `src/ui/app.js`
- Optional: `src/ui/lifecycle.mjs`
- Existing E2E test file preferred; add/register a new file only if clearer.

**Estimated scope:** Small (1–2 files).

## Task 6: Verify restore and the native close path

**Description:** Extend browser smoke coverage where it can accurately observe
the extension target closing and the Chrome process remaining alive. Do not
allow hosted-page fallback to count as issue #92 verification. Because the
automation harness may not be able to obtain a genuine
`FileSystemDirectoryHandle`, retain a required manual test on the affected
Chrome/macOS environment.

**Acceptance criteria:**

- [ ] Automated close coverage closes the extension tab, waits a bounded
  interval, and proves the controlled Chrome process/connection is still alive
  before normal cleanup.
- [ ] The issue-92 smoke path fails or reports unsupported if it cannot load the
  extension; it does not pass through hosted fallback.
- [ ] Manual testing with a real empty folder no longer crashes Chrome.
- [ ] Relaunch restores the workspace and tabs from proactively persisted
  state.

**Verification:**

- [ ] Fully quit and relaunch Chrome before the manual run.
- [ ] Test open/close with no folder.
- [ ] Open an empty folder, wait for persistence, close, relaunch, restore, and
  close again.
- [ ] Open the original project without running it and close.
- [ ] Run and STOP the original infinite-loop program, then close.
- [ ] Confirm Chrome remains alive and no new crash report is uploaded.

**Dependencies:** Task 5.

**Files likely touched:**

- `scripts/smoke-browser.mjs`

**Estimated scope:** Small (1 file).

## Final checkpoint

- [ ] `npm run test:e2e`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm run test:browser:chrome`
- [ ] Manual native-handle test matrix passes on Chrome/macOS.
- [ ] The PR documents any automation limitation and includes `Closes #92`.
- [ ] A human reviews and merges the PR; no agent merges it.

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Removing unload persistence loses a very recent edit | High | Capture the live active-editor value and debounce state-only persistence during editing; test close after the debounce settles. |
| Folder open races startup restore | High | Preserve persistence intent in the startup gate and give workspace saves priority. |
| API split misses a handle-acquisition path | High | Classify every existing caller first and test open, reconnect, and save-to-folder flows. |
| IndexedDB failure prevents all session restore | Medium | Continue serializable state persistence after handle-save failure and retain snapshot fallback. |
| Automated smoke uses a fake handle and misses the native bug | High | Require manual verification with a real `showDirectoryPicker()` handle on the affected environment. |
| Chrome still crashes after removing unload storage | Medium | Re-run the same `IDBFactory.prototype.open` discriminator, capture a new Crash Report ID, and investigate any remaining unload-time IndexedDB caller before revisiting unrelated output/worker hypotheses. |

## Plan status

This replacement plan is ready for human review. It is not approval to begin
implementation.
