# Issue #63: Status Bar Version and Unsaved File Tab

## Feature Description
Display the installed browser.cpp extension version in the bottom status bar at the bottom-right as `browser.cpp vx.x.x`, label the default unsaved Hello World tab as `unsaved file`, and bump the extension patch version from `0.4.2` to `0.4.3`.

The version shown in the UI must come from the installed extension metadata when the extension runtime is available, so users can verify the exact build they are running. The default starter buffer should communicate that it has not been saved to disk yet without implying a real `main.cpp` file already exists.

## User Story
As a browser.cpp user
I want the IDE to show the running extension version and clearly label the default unsaved starter tab
So that I can verify the installed build and understand whether the starter Hello World exists on disk

## Problem Statement
The bottom status bar currently shows compiler status, current file, and cursor position, but it does not expose the installed extension version. The default no-workspace editor state opens `editorAPI.DEFAULT_SOURCE` in a tab labeled `main.cpp`, which can imply a saved file exists even before the user has saved anything. The requested UI change is release-visible, so the extension version must be patch-bumped and kept in sync across manifest and package metadata.

## Solution Statement
Add a right-aligned status bar item whose text is populated from extension metadata as `browser.cpp v<version>`. Use `chrome.runtime.getManifest()` / `browser.runtime.getManifest()` through the existing extension API boundary or a tiny UI helper, with a safe fallback to package/build-time metadata only if the extension runtime is unavailable in tests or non-extension contexts.

Change the default new-project/no-workspace tab identity from `main.cpp` to an internal unsaved tab path while rendering its tab label as `unsaved file`. Preserve compile behavior by mapping no-workspace unsaved buffers to a valid C++ source path such as `input.cpp` or `main.cpp` in `assembleCompilePayload()`, and preserve save behavior so saving the starter buffer still offers a sensible `.cpp` filename.

Bump `manifest.json` from `0.4.2` to `0.4.3`, then run the existing manifest-driven sync script so `package.json` and `package-lock.json` match. Because release automation detects manifest version changes, the eventual PR will trigger the release candidate workflow.

## Relevant Files
Use these files to implement the feature:

- `README.md`
  - Documents the current extension architecture, default usage, and required commands.
- `manifest.json`
  - Source of truth for the installed extension version and the file that release automation watches for version changes.
- `package.json`
  - Must stay version-synchronized with `manifest.json`; also defines validation commands.
- `package-lock.json`
  - Must stay version-synchronized with the root package version.
- `src/extension-api.mjs`
  - Existing abstraction for Chromium `chrome` and Firefox `browser` extension namespaces; use or extend it to avoid hardcoding one runtime namespace in UI code.
- `src/ui/index.html`
  - Contains the bottom status bar markup where a new version item should be added.
- `src/ui/styles.css`
  - Contains `#statusbar` styling; update layout so the version item remains bottom-right without overlapping compiler/file/cursor items.
- `src/ui/app.js`
  - Main boot orchestration; initialize version display after DOM ready.
- `src/ui/toolbar.js`
  - Owns default tab setup, tab rendering, file naming, dirty state, save behavior, and no-workspace compile payload assembly.
- `src/ui/session-persistence.mjs`
  - References the default no-workspace state and may need expectation updates if persisted default state semantics depend on `main.cpp`.
- `scripts/e2e-session-persistence.test.mjs`
  - Existing DOM-fake tests cover toolbar tab state and session behavior; extend for default unsaved tab semantics.
- `scripts/e2e-release-packaging.test.mjs`
  - Existing release/version tests should continue to pass after version bump.
- `scripts/sync-version-from-manifest.js`
  - Existing script to propagate manifest version to package metadata.
- `.github/workflows/ci.yml`
  - Confirms PR validation includes version sync, lint, build, E2E, and Firefox packaging smoke.
- `.github/workflows/release-on-version-change.yml`
  - Confirms a manifest patch bump triggers release candidate packaging in same-repo PRs.

### New Files

No new test file is required. Add the focused coverage to the existing `scripts/e2e-session-persistence.test.mjs`, which is already included by `npm run test:e2e` and therefore CI.

## Implementation Plan
### Phase 1: Foundation
GitHub Issue [#63](https://github.com/kbuffardi/browser.cpp/issues/63) tracks this feature. Branch from `main` into `feature/63-statusbar-version-unsaved-tab`. Confirm the worktree state and avoid modifying existing untracked spec files. Add a small, pure version-display helper at the existing `src/extension-api.mjs` boundary so runtime metadata access works in Chrome/Chromium and Firefox without importing the complete DOM-heavy `app.js` module in Node tests.

### Phase 2: Core Implementation
Add status bar markup and CSS that places a version item at the far right. Populate it on startup with `browser.cpp v0.4.3` from installed extension metadata. Refactor toolbar default state so new unsaved starter buffers use a stable internal unsaved tab key but render as `unsaved file`. Ensure dirty state is visible for the starter tab once edited, and ensure Save/Save As update the tab label to the saved filename.

### Phase 3: Integration
Keep no-workspace compile/run behavior stable by producing a valid C++ source filename in compile payloads even when the visible tab label is `unsaved file`. Restore source-only sessions through a toolbar-level no-workspace restore API that creates the unsaved tab and applies the restored source, rather than directly calling `editorAPI.setValue()`. Bump `manifest.json` to `0.4.3` and run version sync so package metadata follows. Add tests before or alongside implementation, then run the full validation commands.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. Link the GitHub Issue
- Use [#63](https://github.com/kbuffardi/browser.cpp/issues/63), `Show extension version and unsaved starter tab state`.
- The issue body contains this reviewed plan.
- Use `63` in the branch name, commits, and PR body.

### 2. Create the Feature Branch
- Start from a clean `main` baseline after preserving existing untracked spec files.
- Create the branch `feature/63-statusbar-version-unsaved-tab`.
- Do not edit or delete unrelated untracked files currently in `specs/`.

### 3. Extend Focused E2E Coverage
- Extend `scripts/e2e-session-persistence.test.mjs`, which already runs under `npm run test:e2e`; do not create an unregistered test file.
- Build a minimal fake DOM similar to `scripts/e2e-session-persistence.test.mjs`.
- Test a pure extension-API version-label helper that formats `browser.cpp v0.4.3` when runtime metadata reports version `0.4.3`; avoid importing `src/ui/app.js` in Node tests.
- Test that `resetToNewProject()` opens exactly one tab whose visible `.tab-name` text is `unsaved file`.
- Test that saving the no-workspace starter buffer updates the visible tab label to the saved filename returned by `fsAPI.saveFile()`.
- Test that compiling an unsaved starter buffer still emits a valid source path ending in `.cpp` in `assembleCompilePayload()`.

### 4. Add Version Status Bar Markup
- In `src/ui/index.html`, add a new status item at the end of `#statusbar`, for example `<span id="status-version" class="status-item status-version"></span>`.
- Keep compiler, file, and cursor status elements unchanged for compatibility with existing code and tests.

### 5. Implement Runtime Version Display
- Use `src/extension-api.mjs` or a small helper imported by `src/ui/app.js` to read `runtime.getManifest().version`.
- Set `#status-version` to `browser.cpp v<version>` after `DOMContentLoaded`.
- If runtime metadata is unavailable, leave the item empty or use a clearly testable fallback. Do not hardcode `0.4.3` in UI source except through test fixtures or build metadata.
- Ensure the helper handles both `chrome.runtime` and `browser.runtime`.

### 6. Align Status Bar Layout
- Update `src/ui/styles.css` so `.status-version` is pushed to the far right, likely with `margin-left: auto`.
- Keep `white-space: nowrap` and verify narrow viewports do not overlap. If needed, allow the file status to truncate before version/cursor text.

### 7. Introduce Unsaved Starter Tab Semantics
- In `src/ui/toolbar.js`, define constants for the internal unsaved tab key and visible label, such as `UNSAVED_TAB_PATH = 'unsaved.cpp'` and `UNSAVED_TAB_LABEL = 'unsaved file'`. The internal key must retain a `.cpp` suffix so language inference continues to select C++.
- Update `resetToNewProject()` to open the default Hello World source under the unsaved tab key instead of `main.cpp`.
- Update initial no-workspace startup/new-file paths consistently if any path still creates the starter buffer as `main.cpp`.
- Update `renderTabBar()`, `switchToTab()`, `setFileName()`, and `updateSidebar()` as needed so the visible tab/sidebar/status label is `unsaved file` while internal compile/save behavior remains deterministic.

### 8. Preserve Save and Compile Behavior
- Ensure `actionSave()` passes a sensible suggested filename, such as `main.cpp`, when the active tab is the unsaved starter tab.
- After Save or Save As returns a filename, use a dedicated `renameActiveTabPath(nextPath)` helper. It must preserve content and dirty state, remove the unsaved key, update `_activeTabPath` and `_fileName`, refresh sidebar/status/tab rendering, and persist the changed tab snapshot. The tab label must become the saved filename and dirty state must clear only after a successful save.
- In `assembleCompilePayload()`, map the unsaved tab key to a valid source path such as `main.cpp` or `input.cpp`, not `unsaved file`.
- Verify the terminal and toolbar compile flows continue to compile the current buffer with no folder open.

### 9. Update Session and Restore Expectations
- Replace the source-only session restore path in `src/ui/session-persistence.mjs` with a toolbar-level no-workspace restore/reset API that creates the unsaved tab before applying restored source. Direct `editorAPI.setValue(session.source)` is insufficient because it restores a tabless buffer.
- Review comments and any assumptions that the default new-project state is a `main.cpp` tab.
- Update tests that assert default tab names or open tab paths to account for the unsaved starter tab.
- Ensure persisted real workspace file tabs are unaffected.

### 10. Bump Patch Version
- Change `manifest.json` version from `0.4.2` to `0.4.3`.
- Run `npm run version:sync` to update `package.json`, `package-lock.json`, and `package-lock.json packages[""].version`.
- Do not manually edit generated `dist/` manifests unless the build command updates them as part of validation.

### 11. Run Validation Commands
- Execute every command listed in the Validation Commands section.
- Fix any regression before opening the PR.
- In the PR body, include `Closes #<issue-number>` and note that the manifest patch bump intentionally triggers release-candidate automation.

## Testing Strategy
### Unit Tests
- Add focused Node E2E-style coverage in the existing registered E2E suite for runtime version label formatting.
- Add toolbar tests for default unsaved tab rendering, save transition to a real filename, and no-workspace compile payload source path.
- Keep existing session persistence tests passing after the default tab identity change.
- Keep release/version sync tests passing after the patch bump.

### Edge Cases
- `chrome.runtime` exists but `getManifest()` is unavailable.
- Firefox-style `browser.runtime.getManifest()` is available instead of `chrome.runtime`.
- Runtime version is missing or malformed; the UI should not throw during startup.
- Very narrow status bar width; version must remain right-aligned and non-overlapping.
- User edits the unsaved Hello World buffer before saving; dirty dot should appear on the `unsaved file` tab.
- User saves the starter buffer; tab, sidebar, and status file should update to the saved filename.
- User compiles/runs before saving; compile payload should use a valid `.cpp` source filename.
- Restored workspace tabs must still show real filenames, not `unsaved file`.
- Existing persisted sessions that contain `main.cpp` should still restore as `main.cpp`.
- A source-only persisted session restores with one visible `unsaved file` tab containing the saved source.

## Acceptance Criteria
- Bottom status bar shows `browser.cpp v0.4.3` at the bottom-right when running as an installed extension version `0.4.3`.
- The version display is sourced from extension runtime metadata, not from a duplicated hardcoded string in UI logic.
- Default no-workspace Hello World startup shows a file tab labeled `unsaved file`.
- The default starter tab clearly indicates unsaved state after edits using the existing dirty-tab affordance.
- Saving the starter buffer changes the visible tab label to the saved filename and clears dirty state.
- Compile and Compile & Run continue to work from the unsaved starter buffer before saving.
- `manifest.json`, `package.json`, and both root version locations in `package-lock.json` are all `0.4.3`.
- Existing CI commands pass.
- The new focused tests are executed by both `npm run test:e2e` and CI.
- GitHub Issue [#63](https://github.com/kbuffardi/browser.cpp/issues/63) exists before implementation, and the PR closes it.

## Validation Commands
Execute every command to validate the feature works correctly with zero regressions.

```bash
git status --short
npm run version:sync
npm run version:check
npm run lint
npm run build
npm run release:check-version
node --experimental-detect-module --test scripts/e2e-statusbar-version-unsaved-tab.test.mjs
npm run test:e2e
npm run test:browser:firefox
```

Optional browser smoke validation when a local Chromium-family browser is available:

```bash
npm run test:browser:chrome
```

## Notes
- Current branch during planning was `main`.
- Current source version during planning was `0.4.2`; requested patch bump target is `0.4.3`.
- Existing untracked files were present under `specs/`; implementation should leave them alone unless the maintainer explicitly asks otherwise.
- GitHub Issue [#63](https://github.com/kbuffardi/browser.cpp/issues/63) is the single source of truth for this plan. The implementation PR must include `Closes #63`.
- The manifest version bump will cause `.github/workflows/release-on-version-change.yml` to run release-candidate packaging for same-repository PRs.
- Avoid decorators and new runtime dependencies; this feature should be implemented with existing JavaScript modules and DOM APIs.
