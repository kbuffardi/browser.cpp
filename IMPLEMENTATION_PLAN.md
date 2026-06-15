# Implementation Plan

## Status
Workspace project builds & multi-file C++ compilation — **implemented**
(spec: `specs/issue-multifile-build-20260614t164915-sdlc_planner-workspace-project-build.md`).

Prior increment (relaunch session-restore prompt,
`specs/issue-session-restore-...md`) remains complete; details in git history /
commit notes.

## Completed in this increment (multi-file build)
- New pure, browser-free modules (single source of truth shared by UI + worker +
  Node E2E, mirroring `session-persistence.mjs`):
  - `src/ui/build-request.mjs`: extension policy (`.cpp`/`.cxx` only, reject
    `.c`/`.cc`), `selectWorkspaceSources`, `buildCompileOverlay` (dirty tab over
    disk), `parseGxxArgs` (keeps positional sources + `-o`), `resolveWorkspacePath`,
    `resolveRunTarget`.
  - `src/workers/compile-plan.mjs`: `parseCompilePlan(stderr)` -> all `-cc1`
    compile steps + one `wasm-ld` link step.
  - `src/ui/diagnostics.mjs`: arbitrary-path diagnostic parsing + active-file
    scoping (`diagnosticsForPath`).
- `src/workers/compiler.worker.js`: replaced single-TU pipeline with
  `getCompilePlan` + per-source compile (fresh Clang each) + single LLD link;
  result now `{success, diagnostics, outputPath, diagnosticsByPath}`. New request
  shape `{sourcePaths, files, std, flags, primarySourcePath, outputName}`.
- `src/ui/toolbar.js`: `assembleCompilePayload()` snapshots active buffer, layers
  dirty tabs over disk, and picks project sources (whole workspace) or explicit
  sources; toolbar Compile/Compile&Run use it; editor markers scoped to active file.
- `src/ui/terminal.js`: `g++` honours explicit sources + `-o`, rejects `.c`/`.cc`,
  resolves paths from cwd; tracks `lastBuiltArtifactPath`; `./name` validated via
  `resolveRunTarget` (failed build never overwrites last artifact).
- `src/ui/app.js`: terminal `onCompile` bridges through `assembleCompilePayload`.
- `src/ui/editor.js`: `parseDiagnostics` delegates to shared module.
- Tests: `scripts/e2e-multifile-build.test.mjs` (16 tests) added to `test:e2e`.
- README: terminal/project-build behaviour + pipeline diagram updated.

## Why
The compiler modelled one source string + one path; explicit `g++ a.cpp b.cpp`
was ignored, no whole-project toolbar build existed, and cross-file includes
could compile stale/missing content. The new pipeline compiles the live
workspace (disk + unsaved tabs) as N translation units linked together.

## Validation
`npm run lint`, `npm run build`, `npm run test:e2e` (33 tests) all pass.

## Notes / follow-ups
- `bundle.js` exceeds webpack's 244 KiB advisory (pre-existing, not a regression).
- MVP tradeoffs (intentional): `.c`/`.cc` ignored; multiple `main()` entry points
  surface as a link error (not auto-resolved); active-file markers only (no
  cross-tab marker persistence).
- The multi-TU compile path is covered by pure-unit E2E (plan parsing, overlay,
  arg parsing, diagnostics). End-to-end WASM execution still requires the
  `npm run fetch-clang` toolchain in a browser; not exercised in CI.
