# Implementation Plan

## Status
Relaunch project restore prompt — **implemented** (spec:
`specs/issue-session-restore-20260614t130429-sdlc_planner-relaunch-project-prompt.md`).

The core reload-vs-start-new prompt landed in commit `f950b2c` (uses a
`confirmReload` callback injected into `createSessionPersistence`). This follow-up
closed the remaining acceptance-criteria gaps and fixed the test tooling.

## Completed in this increment
- `src/ui/session-persistence.mjs`: added a `startNewProject` callback and made
  the abandon path (`abandonForNewProject`) clear persisted storage, the stored
  handle, **and live in-memory filesystem workspace state**, then load the
  default new-project state. Both "start new" branches (handle present but
  permission needed, and snapshot-only) now go through it.
- `src/ui/filesystem.js`: `resetWorkspace()` export clears in-memory workspace
  state so the abandoned folder cannot be re-persisted/restored by accident.
- `src/ui/toolbar.js`: `resetToNewProject()` export (the `actionNew` body without
  the unsaved-changes confirm) loads `main.cpp` + `editorAPI.DEFAULT_SOURCE`.
- `src/ui/app.js`: wires `startNewProject: resetToNewProject`.
- Tooling: `package.json` `test:e2e` now runs both suites with
  `--experimental-detect-module` (previously broken on Node < 22.7 and only ran
  one file); `.github/workflows/ci.yml` runs `test:e2e`.
- Tests: added `scripts/e2e-session-restore-choice.test.mjs` (spec-required
  dedicated file) covering reload-chosen restore, start-new clearing
  session+handle+live-fs and loading default, fresh-state persist after
  start-new, snapshot-only confirm, source-only no-prompt, and
  already-granted no-prompt.

## Why
Auto-restore could not reliably complete `requestPermission({mode:'readwrite'})`
without a user gesture. The reload runs inside the prompt button click; start-new
fully abandons the prior workspace (storage + handle + live fs) and resets to the
default editor state so the old project cannot reappear.

## Validation
`npm run lint`, `npm run build`, `npm run test:e2e` (17 tests) all pass.

## Notes / follow-ups
- `bundle.js` exceeds webpack's 244 KiB advisory (pre-existing warning, not a
  regression).
