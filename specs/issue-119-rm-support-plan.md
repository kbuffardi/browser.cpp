# Implementation Plan: Issue #119 — `rm` support

## Overview

Expose deletion of workspace files and directories through the terminal, plus
selected-file deletion through the Explorer. Preserve the File System Access
API boundary: every deletion target must resolve inside the opened workspace.
The implementation must never delete the workspace root or anything outside it.

## Current state

- `filesystem.js` already has `deleteWorkspaceFile(path)` for runtime VFS
  deletions. It removes a file through the directory handle, refreshes the
  workspace snapshot, and is covered by filesystem tests.
- The terminal has established `mkdir` and `touch` callback/error conventions
  but no `rm` command or deletion callback.
- The Explorer renders each file as a clickable tree item; it has no action
  menu. The toolbar owns snapshots, open tabs, persistence, and Explorer
  rendering.

## Architecture decisions

- Terminal `rm` accepts multiple operands. Files need no flag; directory
  targets require explicit recursive intent (`-r` or `-R`). The Explorer delete
  button is file-only.
- Process terminal operands independently in order, reporting each failure and
  reflecting successful deletions; multi-target deletion is not transactional.
- Resolve terminal paths relative to the current directory, including `..` when
  the resolved target remains inside the workspace. Reject absolute, empty,
  root-equivalent, and root-escaping paths before filesystem mutation.
- Consolidate user-driven deletion behind a result-shaped filesystem API (for
  example `{ ok, path, snapshot }` / `{ ok: false, error, path }`) rather than
  treating a missing file as a successful UI mutation. Keep the existing
  runtime file-cleanup wrapper unchanged for compatibility.
- Render one accessible Explorer delete icon button that is enabled only when a
  file is selected. Require confirmation before it deletes that selected file.
- Use native browser dialogs for deletion and dirty-tab discard confirmation;
  a custom in-app modal system is out of scope.
- If a requested deletion includes dirty open tabs, require an explicit discard
  confirmation before any filesystem mutation. On success, close affected tabs,
  choose a deterministic remaining-tab/editor fallback, update the
  terminal/Explorer snapshot, and persist. Cancellation or failure changes
  nothing.

## Task list

### Task 1: Define safe, user-facing workspace deletion semantics

**Description:** Add pure path validation and filesystem deletion behavior for
user-requested files and recursively requested directories, reusing the
existing workspace index and directory-handle traversal.

**Acceptance criteria:**

- [ ] Root and nested files can be deleted; directories require an explicit
      recursive request and disappear with their descendants from the snapshot.
- [ ] Empty, absolute, root-escaping, root-equivalent, missing, unwritable,
      no-workspace, and directory-without-recursion targets have deterministic
      result/error values and do not mutate unrelated entries.
- [ ] No operation can target a parent of the opened workspace.

**Verification:**

- [ ] Extend `scripts/e2e-workspace-file-tracking.test.mjs` fake-handle tests
      for nested files, recursive/non-recursive directories, root confinement,
      permission failures, missing targets, and runtime-wrapper compatibility.

**Dependencies:** None.

**Files likely touched:** `src/ui/workspace-fs.mjs`, `src/ui/filesystem.js`,
`scripts/e2e-workspace-file-tracking.test.mjs`.

### Task 2: Add terminal `rm`

**Description:** Wire a terminal callback through `app.js` to the filesystem
deletion contract and refresh/persist the workspace only after success.

**Acceptance criteria:**

- [ ] `rm <file> ...` deletes one or more workspace-relative files from root
      or the current terminal directory; `rm -r <directory> ...` deletes
      directories recursively.
- [ ] Help and tab completion advertise `rm`; zero operands and unsupported
      options render shell-style usage errors.
- [ ] `..` navigation inside the workspace succeeds, while root escape, missing
      targets, directories without `-r`, and permission failures produce clear
      errors without unreported UI-state changes.
- [ ] A failed target does not roll back earlier successful targets or prevent
      later valid targets from being processed; the final snapshot is
      authoritative and each failure is reported.

**Verification:**

- [ ] Add `scripts/e2e-terminal-rm.test.mjs`, modeled on the touch/mkdir
      harnesses, covering multi-target/recursive dispatch, current-directory
      resolution, root confinement, completion, help, and formatted errors.
- [ ] Register the new test file in `package.json`'s explicit `test:e2e`
      command.
- [ ] Run the focused Node tests, then `npm run lint` and `npm run test:e2e`.

**Dependencies:** Task 1.

**Files likely touched:** `src/ui/terminal.js`, `src/ui/app.js`,
`scripts/e2e-terminal-rm.test.mjs`.

### Task 3: Add a confirmed Explorer file-delete action

**Description:** Add an accessible delete icon button for the selected Explorer
file. Confirm its irreversible deletion, then apply the returned workspace
snapshot and reconcile the affected tab.

**Acceptance criteria:**

- [ ] A keyboard-accessible delete icon button is disabled without a selected
      file and enabled only for the selected file; folders and the workspace
      root cannot be deleted through this control.
- [ ] Confirmation cancellation and API failure leave the Explorer, editor,
      terminal, and session unchanged.
- [ ] If the selected file is dirty, a separate discard confirmation is
      required before filesystem mutation.
- [ ] On success the file vanishes from the Explorer and terminal; its open tab
      is closed with a deterministic replacement; session state is persisted.

**Verification:**

- [ ] Extend toolbar DOM-harness coverage in
      `scripts/e2e-workspace-file-tracking.test.mjs` for button selection
      state, confirmation, dirty-tab discard confirmation, success,
      cancellation, failure, tab reconciliation, and persistence.
- [ ] Manually verify Explorer deletion in a Chromium workspace with nested
      files, then run `npm run build`.

**Dependencies:** Task 1.

**Files likely touched:** `src/ui/toolbar.js`, `src/ui/styles.css`,
`scripts/e2e-workspace-file-tracking.test.mjs`.

## Checkpoint: Before review

- [ ] `npm run lint` passes.
- [ ] `npm run build` passes.
- [ ] `npm run test:e2e` passes.
- [ ] Manual deletion is confirmed to remain inside the selected workspace.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Deletion is irreversible | Require Explorer confirmation; make terminal errors explicit. |
| Workspace-root escape | Resolve `..` before handle lookup and reject targets outside the root. |
| Stale active tab/session after deletion | Require discard confirmation for dirty tabs; reconcile affected tabs only after success, then persist. |
| Runtime deletion semantics regress | Preserve its existing entry point and cover it alongside the new result contract. |
