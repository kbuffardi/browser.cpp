# Feature: Relaunch project restore prompt for persisted workspace state

## Feature Description
When the extension is reopened after the user previously had a workspace folder open and one or more editor tabs active, the next launch should preserve that prior state. If restoring the prior project requires a user gesture or renewed File System Access permission, the UI should first ask whether to reload the previous project or start a new project. Choosing **Reload previous project** should begin the write-permission flow and then restore the Explorer and editor tabs. Choosing **Start new project** should abandon the prior workspace session and open the same default state as the current **New** action: no workspace connected, a `main.cpp` tab open, and `editorAPI.DEFAULT_SOURCE` loaded.

## User Story
As a browser.cpp user
I want to choose whether a previous project is restored when I relaunch the extension
So that I can resume work intentionally and grant folder permissions only when I want to

## Problem Statement
The current startup flow restores persisted state automatically. `app.js` calls `restoreSession()` immediately on launch, and `session-persistence.mjs` attempts `queryPermission()` / `requestPermission({ mode: 'readwrite' })` before silently falling back to serialized workspace and tab snapshots when handle-based restore cannot complete. That behavior does preserve state, but it does not give the user the required reload-vs-new-project choice and it cannot reliably complete the permission path when a user gesture is needed. The branch therefore misses the explicit relaunch UX and the intentional abandonment path for starting fresh.

## Solution Statement
Introduce an explicit relaunch decision flow that separates **discovering saved session state** from **executing a restore**. Startup should first detect whether a persisted workspace session exists. If so, present an in-app modal prompting the user to reload the previous project or start a new project. The reload action should run under the button click gesture so `requestPermission({ mode: 'readwrite' })` can succeed, then restore the workspace handle, Explorer tree, and editor tabs. If permission is denied or cancelled after the user chose reload, return to the same reload-or-new prompt. If the user dismisses the prompt without choosing reload, treat that as starting fresh and load the default new-project state. If the user chooses start new, clear persisted session state, stored handle references, and in-memory filesystem workspace state before initializing the default editor state so the old workspace is not restored later by accident. Source-only sessions without a persisted workspace should continue to auto-restore and should not show this prompt.

## Relevant Files
Use these files to implement the feature:

- `README.md`
  - Confirms the extension architecture, File System Access usage, and the user-facing expectation that opened folders are read/write capable.
- `package.json`
  - Defines the current lint/build/test entry points and will likely need a small update if the new E2E coverage is split into a second test file.
- `.github/workflows/ci.yml`
  - CI currently runs lint and build only; this should be updated so the relaunch/session test suite runs automatically.
- `src/ui/app.js`
  - Owns startup ordering (`restoreSession()` + persistence gate enablement) and is the right place to orchestrate prompt-first relaunch behavior.
- `src/ui/session-persistence.mjs`
  - Owns storage access, handle persistence, restore logic, and is the main module that should be refactored from “auto-restore” into “inspect session / restore on demand / clear abandoned session”.
- `src/ui/toolbar.js`
  - Provides `actionNew()`, `restoreWorkspace()`, workspace tab state helpers, and the current default-state behavior needed for the “start new project” path.
- `src/ui/filesystem.js`
  - Encapsulates folder open/reopen, live directory-handle state, and workspace snapshots; it is a required touchpoint for clearing in-memory workspace state when the user chooses start new.
- `src/ui/index.html`
  - Needs the prompt/modal container and accessible controls for reload vs start new.
- `src/ui/styles.css`
  - Needs styling for the relaunch prompt so it matches the existing VS Code–inspired UI.
- `scripts/e2e-session-persistence.test.mjs`
  - Existing persistence suite already covers handle restore, snapshot fallback, reconnect, and gate timing; it should either be extended carefully or split so shared helpers remain reusable.

### New Files
- `scripts/e2e-session-restore-choice.test.mjs`
  - Dedicated node:test coverage for the new relaunch prompt and explicit user-choice branches, kept separate from the existing persistence mechanics suite.

## Implementation Plan
### Phase 1: Foundation
Refactor session persistence so startup can inspect saved state without immediately restoring it. Define a small session-restore state model that answers: whether a prior workspace exists, whether a handle is available, whether a snapshot fallback exists, and what actions are available (`reload`, `startNew`, `rePrompt`). Add the relaunch prompt UI shell and accessible button wiring without yet changing the underlying restore mechanics.

### Phase 2: Core Implementation
Move restore execution behind explicit user intent. The reload path should run under the prompt button click, request `readwrite` permission, reopen the saved directory handle when possible, and restore Explorer + tabs. If reload is chosen but permission is denied/cancelled, return to the prompt. If the handle cannot be reloaded but a persisted workspace snapshot exists, restore from the snapshot only after the explicit reload choice. Implement a clear “abandon previous session” path that removes stored session metadata, stored handles, and in-memory filesystem workspace state before initializing the default new-project state (`main.cpp` + `editorAPI.DEFAULT_SOURCE`, no active workspace).

### Phase 3: Integration
Integrate the new flow with the startup persistence gate, toolbar default-state behavior, and automated validation. Ensure opening a new folder after choosing start new persists the new workspace normally, and ensure CI runs the session persistence/relaunch tests so this branch cannot regress silently.

### Startup state machine
1. Inspect persisted session state before mutating the UI.
2. If no persisted workspace session exists, continue normal startup.
3. If only source content exists with no persisted workspace, auto-restore that source and do not show the prompt.
4. If a persisted workspace session exists, show the reload-or-start-new prompt and keep the persistence gate disabled.
5. If the user clicks **Reload previous project**, request `readwrite` permission inside that click handler and attempt restore.
6. If reload succeeds, restore the workspace/tabs and then enable the persistence gate.
7. If reload permission is denied or cancelled, re-show the prompt and keep startup unresolved.
8. If the user clicks **Start new project** or dismisses the prompt, clear persisted state plus live filesystem workspace state, initialize the default new-project editor state, then enable the persistence gate.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### Audit and codify the startup decision contract
- Refactor `src/ui/session-persistence.mjs` so session discovery is separate from session restoration.
- Introduce explicit methods for:
  - loading saved session metadata without mutating the UI,
  - restoring a saved session only after user confirmation,
  - clearing abandoned session state when the user starts fresh.
- Preserve the existing persistence gate semantics so startup persistence cannot overwrite a saved session before the prompt is resolved.
- Make the contract explicit that source-only sessions still auto-restore and only persisted workspace sessions trigger the prompt.

### Create a dedicated E2E test file for the new relaunch-choice UX
- Add `scripts/e2e-session-restore-choice.test.mjs`.
- Reuse or extract shared fake storage/handle/document helpers from `scripts/e2e-session-persistence.test.mjs` as needed to avoid duplicating the test harness.
- Cover the prompt-state contract first so implementation can target concrete behavior.

### Add the relaunch prompt UI
- Add prompt/modal markup to `src/ui/index.html` with clear actions for **Reload previous project** and **Start new project**.
- Add styling in `src/ui/styles.css` for modal layout, focus states, button hierarchy, and disabled/loading states that fit the current UI theme.
- Keep the prompt non-destructive and accessible: focus management, `aria-modal`, clear copy, and keyboard-safe controls.
- Make dismissal behavior explicit: dismissing the prompt should leave the extension in the same default state as **Start new project**.

### Wire startup orchestration in `src/ui/app.js`
- Replace unconditional `await restoreSession()` with a startup controller that:
  - detects whether a prior session exists,
  - shows the prompt only when needed,
  - leaves first-run/default launches unchanged,
  - enables persistence only after the startup branch resolves.
- Ensure the reload action is invoked directly from the button click handler so permission requests occur inside a valid user gesture.

### Implement reload behavior in `src/ui/session-persistence.mjs`
- On reload choice, request `readwrite` permission from the stored directory handle.
- If permission is granted and the handle reopens successfully, call `restoreWorkspace(...)` with the saved tab order, active tab, and tab-content snapshot fallback.
- If the user cancels or denies the permission request after choosing reload, return to the reload-or-new prompt instead of falling through silently.
- If handle-based restore fails but persisted workspace metadata/tab snapshots exist, restore that snapshot only after the user explicitly chose reload.
- Keep plain source-only session restore behavior unchanged: if no persisted workspace exists but saved editor content does, auto-restore the source without showing the prompt.

### Implement the start-new-project path
- Add or expose a toolbar-level reset path that matches `actionNew()` behavior without requiring manual user interaction.
- Clear persisted session storage, the stored directory handle, and live in-memory filesystem workspace state before loading the default editor state so the old project is fully abandoned.
- Verify that after choosing start new, the next unload persists the new default/current state rather than rehydrating the abandoned workspace.

### Update automated coverage and CI
- Add tests for:
  - first launch / no saved session -> no prompt,
  - prior session detected -> prompt shown,
  - reload chosen -> permission requested under user action -> workspace/tabs restored,
  - reload chosen -> permission denied/cancelled -> prompt shown again,
  - prompt dismissed -> same outcome as start new,
  - start new chosen -> saved session cleared -> default state loaded,
  - start new clears persisted state, handle store, and live filesystem workspace state,
  - immediate unload after start new persists the fresh state rather than the abandoned workspace,
  - snapshot-only restore occurs only after explicit reload choice,
  - repeated denied reload attempts remain retryable without wedging startup.
- Explicitly replace or rewrite existing tests that currently assert the old silent auto-restore behavior, especially denied-permission snapshot restore cases in `scripts/e2e-session-persistence.test.mjs`.
- Update `package.json` if needed so `npm run test:e2e` runs both session-persistence test files.
- Update `.github/workflows/ci.yml` to run `npm run test:e2e` in addition to lint and build.

### Run validation commands
- Execute every command in the Validation Commands section and resolve all failures before considering the feature complete.

## Testing Strategy
### Unit Tests
- Extend the existing `node:test` harness around `createSessionPersistence(...)` to cover the new discovery/restore/clear APIs independently from DOM concerns.
- Test startup gate behavior so unresolved prompts cannot overwrite a previously saved session.
- Test the clear-session path to confirm storage metadata, the persisted directory handle, and live filesystem workspace state are all removed.
- Test prompt re-entry after denied/cancelled reload permission.

### Edge Cases
- Saved workspace exists but no stored handle is available.
- Stored handle exists but `requestPermission({ mode: 'readwrite' })` is denied or throws due to gesture/permission constraints.
- Stored handle reload succeeds but one or more saved tab files are missing; the remaining tabs should still restore deterministically.
- User chooses start new after a snapshot-only session exists.
- Source-only session exists with no workspace; relaunch should auto-restore old content without showing the prompt.
- Startup persistence fires before the prompt resolves.
- Reload is attempted repeatedly after prior denial; the prompt should remain usable and not wedge the app.
- User dismisses the prompt without choosing reload or start new.

## Acceptance Criteria
- On relaunch with a previously persisted workspace session, the extension does not auto-restore immediately; it first prompts the user to reload the previous project or start a new project.
- Choosing **Reload previous project** initiates the folder write-permission path from the user interaction and restores the saved Explorer folder, open tabs, and active tab when permission is granted.
- If reload is chosen but the permission request is cancelled or denied, the extension returns to the same reload-or-new prompt.
- Choosing **Start new project** or dismissing the prompt clears the previous saved session, stored handle, and in-memory workspace state and loads the default new-project/editor state (`main.cpp` with `editorAPI.DEFAULT_SOURCE`, no connected workspace).
- Snapshot-based workspace/tab restoration remains available when handle reload is unavailable, but only after the user explicitly chooses reload.
- Source-only sessions without a persisted workspace continue to auto-restore and do not show the prompt.
- Existing session persistence behaviors that are not being intentionally changed continue to work, including startup gating and post-restore workspace reconnect.
- `npm run lint`, `npm run build`, and `npm run test:e2e` all pass, and CI runs the E2E session tests automatically.

## Validation Commands
Execute every command to validate the feature works correctly with zero regressions.

- `npm run lint`
- `npm run build`
- `npm run test:e2e`

## Notes
- Current code already persists enough data to satisfy the feature (`workspace`, `openTabPaths`, `activeTabPath`, and tab-content snapshots); the main gap is startup orchestration and explicit UX, not raw persistence coverage.
- The existing memory that claimed this prompt already existed is outdated; implementation should be based on the current code, which still auto-restores.
- Some existing tests currently assert the old silent snapshot-restore behavior after denied permission; those expectations must be updated rather than preserved.
- Keep the implementation simple and local to the existing UI modules unless the prompt logic becomes large enough to justify a small dedicated helper module.
