# Feature: Workspace project builds, named file creation, and live Explorer sync

## Feature Description
Extend browser.cpp's workspace flow so project builds, user-created files, and program-created files all stay visible and actionable in the Explorer. The existing multi-file compile pipeline should continue to build whole workspaces and honor explicit terminal file lists, but the workspace UI also needs first-class file creation: clicking **New file** should require an opened folder, show an inline Explorer naming control similar to VS Code/Monaco's default file-creation UX, accept relative nested paths, create the new file in the workspace root when no subfolder is provided, and immediately open the created file in the editor. In addition, files produced by successful builds (for example `a.out` or a custom `-o` output) and files created at runtime through `fstream` should be added to the Explorer immediately so the workspace view never lags behind the actual workspace contents.

## User Story
As a browser.cpp user working in an opened folder
I want to create files from the Explorer and immediately see files produced by builds or program output
So that the workspace view behaves like a real IDE and always reflects the files I can edit, compile, and inspect

## Problem Statement
The current branch already implements most of the multi-file build pipeline, but the workspace file-tracking experience is still incomplete:

- `src/ui/toolbar.js` still wires the Explorer **New file** button to `actionNew()`, which resets the editor to a fresh unsaved project instead of creating a file inside the opened workspace.
- `src/ui/index.html` renders a static Explorer tree with no inline creation affordance, so there is no VS Code-style "type the new filename here" flow.
- `src/ui/filesystem.js` can create missing parent directories during `writeWorkspaceFile(...)`, but it only updates `workspaceFiles`; it does not add missing directory/file entries to `workspaceEntries` or publish an updated workspace snapshot back to the UI.
- Because `workspaceEntries` stays stale after writes, the Explorer in `toolbar.js` and the terminal workspace metadata in `terminal.js` do not immediately reflect files created through `fstream` output or any other workspace write path.
- Successful compilation currently returns `outputPath`, but the built artifact lives only as `compiledBinary` inside `src/workers/compiler.worker.js`; it is not materialized back into the workspace, so outputs such as `a.out` never appear in the Explorer.
- When no folder is open, there is no guided "open a folder first" flow for managed workspace file creation.

Because of those gaps, browser.cpp can compile and run richer workspaces, but users still cannot create workspace files from the Explorer and cannot trust the Explorer to show newly created output artifacts immediately.

## Solution Statement
Treat the Explorer as a live view over a mutable workspace index rather than a one-time folder snapshot. Add an explicit workspace file-creation flow for the Explorer and a shared workspace-mutation contract for all code paths that create files:

1. **Explorer-driven file creation** under the **New file** button, with inline naming in the Explorer pane and support for nested relative paths such as `src/lib/util.hpp`.
2. **Folder-first gating** so clicking **New file** with no opened folder first prompts the user to open a folder; file creation does not proceed until a workspace exists.
3. **Shared workspace mutation helpers** in `filesystem.js` that create files/directories, update the in-memory workspace index (`workspaceEntries`, `workspaceFiles`), and return or emit the refreshed workspace snapshot for the UI and terminal.
4. **Output artifact synchronization** so successful compile outputs and runtime `fstream` writes flow through the same workspace-mutation path and immediately refresh the Explorer and terminal-visible file list.
5. **Behavior-safe validation** so failed builds do not create phantom output files, invalid creation paths are rejected clearly, and active-editor behavior remains deterministic after file creation.

This keeps the existing workspace-aware compile architecture, but finishes the missing UX and state-management pieces so workspace files are created and tracked consistently regardless of whether they originate from the user, the compiler, or a running C++ program.

## Relevant Files
Use these files to implement the feature:

- `README.md`
  - Update the documented Explorer/file workflow so it explains the folder-first new-file flow and immediate visibility of build/runtime-created files.
- `package.json`
  - Add the new E2E suite to `npm run test:e2e`.
- `src/ui/index.html`
  - Add the inline Explorer creation row/container and any accessibility hooks needed for the naming input.
- `src/ui/styles.css`
  - Style the inline Explorer input so it feels native to the current VS Code-inspired UI.
- `src/ui/app.js`
  - Keep the compile bridge aligned if compile success starts returning/exporting artifact bytes for workspace persistence.
- `src/ui/toolbar.js`
  - Replace the current reset-style **New file** behavior with workspace-aware creation, handle the folder-open prerequisite, open the newly created file in the editor, and refresh Explorer/terminal state after workspace mutations.
- `src/ui/filesystem.js`
  - Add the canonical helpers for creating workspace files, creating missing parent directories, updating `workspaceEntries`, and returning refreshed workspace snapshots after writes.
- `src/ui/terminal.js`
  - Consume refreshed workspace metadata so commands such as `ls`, `cd`, and `cat` immediately reflect created files and directories.
- `src/ui/diagnostics.mjs`
  - Keep active-file diagnostics scoped by exact normalized path as workspace file creation increases the chance of duplicate basenames in different directories.
- `src/workers/compiler.worker.js`
  - Expose successful compile output in a form the main thread can persist into the opened workspace when required.
- `scripts/e2e-multifile-build.test.mjs`
  - Reference for the current project-build coverage and a likely place to keep compile-output visibility assertions aligned.

### New Files
- `scripts/e2e-workspace-file-tracking.test.mjs`
  - Dedicated E2E coverage for Explorer new-file creation, folder-open gating, nested path handling, compile output visibility, and runtime-created file refresh behavior.

## Implementation Plan
### Phase 1: Workspace mutation contract
Define one canonical workspace-mutation path in `filesystem.js` that every file-creation scenario uses. The contract should create any missing parent directories, update both `workspaceFiles` and `workspaceEntries`, and return a refreshed serializable workspace snapshot so `toolbar.js` and `terminal.js` can re-render immediately without re-walking the entire directory.

### Phase 2: Explorer new-file UX
Replace the current **New file** reset action with an inline Explorer naming flow. If no folder is open, require the user to open one first; once a workspace exists, show a VS Code-style inline input in the Explorer, accept a relative nested path, create the file in the workspace root when only a basename is given, and open the created file in the editor.

### Phase 3: Build/runtime file visibility
Route compile outputs and runtime `fstream` writes through the same workspace-mutation flow so new files such as `a.out`, custom `-o` targets, and program-generated files appear in the Explorer and terminal workspace state immediately after creation.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### Create dedicated E2E coverage first
- Add `scripts/e2e-workspace-file-tracking.test.mjs`.
- Cover these scenarios with injected fakes around the existing UI/filesystem modules:
  - clicking **New file** with no workspace open first triggers the folder-open flow
  - cancelling the folder-open flow leaves the current UI/editor state unchanged
  - clicking **New file** with a workspace open shows an inline Explorer naming input
  - entering `main.cpp` creates the file at the workspace root
  - entering `src/main.cpp` creates any missing parent directories and the file beneath them
  - submitting the new filename opens the created file in the editor and selects it in the Explorer
  - cancelling inline creation removes the temporary input row cleanly
  - absolute paths, empty names, duplicate paths, and `..` traversal inputs are rejected clearly
  - successful compile output (default `a.out` and custom `-o`) appears in the Explorer immediately when a workspace is open
  - runtime-created files returned through `vfsChanges` appear in the Explorer immediately, including nested output paths
  - failed builds do not create phantom output files in the Explorer
  - terminal workspace commands see the refreshed file list after creation

### Define the workspace mutation model
- Add or expose filesystem helpers with responsibilities such as:
  - normalize and validate a workspace-relative target path
  - create missing parent directories in both the real folder handle and the in-memory index
  - add new `workspaceEntries` for directories/files without duplicating existing entries
  - write file content and retain a reusable file handle when available
  - return the refreshed workspace snapshot after each mutation
- Keep this as the single source of truth for:
  - Explorer-created files
  - compile-output artifact persistence
  - runtime `fstream` write-back handling
- Avoid a full directory re-scan after every write unless a specific browser API limitation makes incremental updates impossible.

### Add the Explorer inline new-file UX
- Update `src/ui/index.html` and `src/ui/styles.css` to support an inline naming row in the Explorer pane that visually matches the current UI.
- Replace the current `btn-new -> actionNew()` mapping in `toolbar.js` with a workspace creation controller.
- Make the controller:
  - require an opened folder before entering file-creation mode
  - open the folder picker first when no workspace exists
  - render the inline input in the Explorer once a workspace is available
  - place root-level filenames in the workspace root by default
  - accept nested relative paths such as `src/lib/file.hpp`
  - reject invalid or unsafe inputs before mutating the workspace
- Keep the interaction keyboard-friendly:
  - Enter confirms creation
  - Escape cancels creation
  - focus moves to the created file/editor after success

### Open the created file in the editor
- After a successful creation, immediately:
  - refresh the workspace snapshot in `toolbar.js`
  - re-render the Explorer and terminal workspace state
  - create/open a tab for the new file
  - seed the new editor buffer with empty content
  - make the new tab active and selected in the Explorer
- Ensure this works whether the file is created at the root or inside a newly created nested directory.

### Synchronize compile outputs into the workspace
- Decide the compile-output persistence contract explicitly:
  - when a workspace is open, a successful compile should materialize the built artifact at `outputPath` inside that workspace
  - when no workspace is open, compile success should continue to behave as an in-memory build only
- Update `compiler.worker.js` and the compile bridge so the main thread can persist the successful output artifact bytes, not just the artifact path.
- Route artifact persistence through the shared filesystem mutation helper so:
  - `a.out` appears immediately after default builds
  - custom `-o build/app` outputs create intermediate directories when needed
  - repeated builds overwrite the existing artifact cleanly without duplicating Explorer entries
  - failed builds leave the prior Explorer state unchanged

### Synchronize runtime-created files into the workspace
- Replace the current bare `writeWorkspaceFile(...)` loop in the `run-result` handling path with the shared workspace-mutation flow.
- After applying `vfsChanges`, refresh:
  - the Explorer tree
  - the terminal workspace snapshot
  - any relevant active-file selection if the currently viewed file was newly created or overwritten
- Preserve the existing behavior that no workspace write-back happens when no folder is open.

### Tighten diagnostics scoping for expanding workspaces
- Update `src/ui/diagnostics.mjs` so active-file matching is based on exact normalized workspace-relative paths, not basename fallback.
- Add coverage for duplicate basenames in different directories (for example `src/main.cpp` and `tests/main.cpp`) so editor markers cannot attach to the wrong file after nested file creation expands the workspace.

### Update documentation and test entrypoints
- Revise `README.md` to explain:
  - **New file** now requires an opened folder
  - the Explorer uses inline naming and accepts nested relative paths
  - build outputs and runtime-created files appear in the Explorer immediately
- Add `scripts/e2e-workspace-file-tracking.test.mjs` to `package.json` so it runs via `npm run test:e2e`.

### Run full validation
- Execute the repository validation commands listed below after implementation and after adding the new E2E coverage.

## Testing Strategy
### Unit Tests
- Add focused coverage for path normalization/validation used by workspace file creation.
- Add coverage for incremental workspace-index updates:
  - adding a root file
  - adding nested directories plus a file
  - overwriting an existing file without duplicating entries
- Add focused coverage for compile-output persistence when a workspace is open versus absent.
- Add focused coverage for diagnostics path matching with duplicate basenames.

### Edge Cases
- User clicks **New file** with no workspace open and then cancels the folder picker.
- User enters a nested path whose parent directories do not yet exist.
- User enters `./file.cpp`, `../file.cpp`, `/absolute.cpp`, or an empty path.
- User creates a file whose path already exists as a file or directory.
- A successful build writes `a.out` repeatedly.
- A successful build writes to a nested custom output path such as `build/bin/app`.
- Runtime `fstream` output creates a previously unseen nested path.
- Runtime output overwrites an existing open file.
- Duplicate basenames exist in different directories and diagnostics must stay scoped to the exact active path.
- No folder is open during compile/run, so no Explorer sync should be attempted.

## Acceptance Criteria
- Clicking **New file** with no folder open first prompts the user to open a folder; file creation does not proceed until a workspace exists.
- With a workspace open, clicking **New file** shows an inline Explorer naming input rather than resetting the editor.
- Entering `name.cpp` creates the file at the workspace root; entering `dir/name.cpp` creates the file inside that relative nested path.
- After a file is created, it appears immediately in the Explorer and opens in the editor as the active tab.
- Invalid file paths are rejected without mutating the workspace.
- When a workspace is open, successful compile outputs such as `a.out` or custom `-o` targets appear in the Explorer immediately.
- When a workspace is open, files created by the running program through `fstream` appear in the Explorer immediately after the run completes.
- Failed builds do not create phantom output artifacts in the Explorer.
- Terminal workspace commands reflect newly created files without requiring the user to reopen the folder.
- Multi-file build behavior, dirty-tab overlays, and existing no-workspace compile/run behavior continue to work.
- Active-file diagnostics remain scoped to the exact file path even when multiple files share the same basename.

## Validation Commands
Execute every command to validate the feature works correctly with zero regressions.

```bash
npm run lint
npm run build
node --experimental-detect-module --test scripts/e2e-multifile-build.test.mjs
node --experimental-detect-module --test scripts/e2e-workspace-file-tracking.test.mjs
npm run test:e2e
```

## Notes
- This revision assumes the current multi-file compile pipeline remains in place; the work here is primarily about finishing workspace mutation UX/state management around it.
- The current code already has most of the plumbing needed for runtime write-back (`vfsChanges` and `writeWorkspaceFile(...)`), but not the Explorer/terminal refresh path or compile-artifact persistence.
- Persisting compile outputs into the workspace is a product behavior change from "runnable in-memory artifact only" to "workspace-visible artifact when a folder is open"; the implementation should make that transition explicit and well tested.
