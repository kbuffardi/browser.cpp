# Feature: Workspace project builds and multi-file C++ compilation

## Feature Description
Enable browser.cpp to compile and run C++ workspaces that span multiple source files instead of treating compilation as a single-editor-buffer action. This includes supporting terminal commands like `g++ main.cpp other.cpp`, making toolbar builds compile the whole opened workspace project by default, and ensuring local includes such as `#include "other.cpp"` or `#include "other.hpp"` resolve against the opened folder even when related files have unsaved edits in open tabs. For this MVP, project discovery should compile only `.cpp` and `.cxx` files and ignore `.c` and `.cc`.

## User Story
As a browser.cpp user working in an opened folder
I want project builds to compile multiple C++ source files and resolve local cross-file includes
So that I can build realistic C++ programs without manually flattening everything into one file

## Problem Statement
The current implementation models compilation as exactly one source string plus one source path:

- `src/ui/terminal.js` ignores positional source-file arguments and always compiles the current editor buffer.
- `src/ui/toolbar.js` also posts only the active editor content plus one `fileName`.
- `src/workers/compiler.worker.js` discovers and executes only one `-cc1` compile step and one linker output, which matches a single translation unit build.
- Workspace input for compilation comes from `readAllWorkspaceFiles()`, which reads disk-backed folder contents but does not overlay dirty tab contents from the editor before compile.
- `src/ui/editor.js` only parses diagnostics that match `/input.cpp`, which is too narrow once builds can target arbitrary workspace paths and multiple files.

Because of those constraints, explicit multi-file commands do not work, project-wide toolbar builds do not exist, and cross-file references can compile against stale or missing workspace content.

## Solution Statement
Introduce a project-build pipeline that separates:

1. **Build target selection** in the UI (`all workspace source files` for toolbar builds; explicit file arguments for terminal builds).
2. **Workspace source overlay assembly** so compilation sees the opened folder plus unsaved tab content.
3. **Multi-translation-unit orchestration** in the worker by parsing all `clang++ -###` compile steps, compiling each translation unit in a fresh Clang instance, and linking all produced objects in one LLD step.
4. **Per-file diagnostics and output tracking** so the UI can render useful errors and the terminal can run the last built artifact consistently.

This keeps the existing browsercc-based architecture, but expands it from “single active file compile” to “workspace-aware project compile”.

For this MVP, “whole workspace” is intentionally defined as “all recursive `.cpp` and `.cxx` files in the opened folder”. `.c` and `.cc` files are ignored by default project discovery, and workspaces with multiple entry points may fail at link time; that failure should be surfaced clearly rather than hidden.

## Relevant Files
Use these files to implement the feature:

- `README.md`
  - Update terminal/build behavior documentation so it no longer claims `g++` compiles only the current editor source.
- `src/ui/app.js`
  - Extend the compile bridge so worker messages can receive richer project-build payloads instead of a single source string/file name pair.
- `src/ui/toolbar.js`
  - Change toolbar Compile / Compile & Run to build the whole opened workspace project by default.
  - Add helpers that snapshot current editor/tab content into the compile overlay before dispatching to the worker.
- `src/ui/terminal.js`
  - Stop discarding positional source-file arguments.
  - Resolve explicit file arguments relative to the terminal working directory.
  - Track the last compiled output path instead of hardcoding `/a.out`.
- `src/ui/filesystem.js`
  - Reuse workspace enumeration helpers and add any thin helper needed to support project source discovery or overlay generation without re-reading unrelated state ad hoc.
- `src/ui/editor.js`
  - Expand diagnostic parsing so it can capture arbitrary workspace-relative file paths and not just `/input.cpp`.
- `package.json`
  - Update `test:e2e` to include the new multi-file build suite.
- `src/workers/compiler.worker.js`
  - Replace the single-source compile pipeline with a multi-step compile plan that can build N translation units and link them together.
- `scripts/e2e-session-persistence.test.mjs`
  - Reference for the repository’s Node-based “real module with injected fakes” E2E style.
- `scripts/e2e-session-restore-choice.test.mjs`
  - Reference for writing additional E2E coverage in the existing test runner pattern.

### New Files
- `scripts/e2e-multifile-build.test.mjs`
  - Dedicated E2E coverage for terminal multi-file builds, workspace-default toolbar builds, dirty-tab overlay behavior, and local include resolution.

## Implementation Plan
### Phase 1: Foundation
Define a richer compile request contract shared by the toolbar, terminal, and worker. The new request should carry the selected source paths, workspace-relative current working directory, standard/flags, and a source-content overlay for dirty open tabs so the worker compiles the exact in-memory project state the user sees.

### Phase 2: Core Implementation
Rework the worker’s compile pipeline to support multiple translation units. The worker should derive a full compile plan from `clang++ -###`, execute one fresh Clang instance per compile step with the workspace overlay mounted into the module FS, then link all objects in one LLD invocation and return the actual output artifact path along with diagnostics.

### Phase 3: Integration
Wire the new compile contract into toolbar and terminal flows, surface multi-file diagnostics sensibly in the editor/terminal, update run behavior to use the actual built artifact, and document the new project-build semantics.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### Create dedicated E2E coverage first
- Add `scripts/e2e-multifile-build.test.mjs`.
- Cover these scenarios with injected fakes around the existing UI modules:
  - toolbar Compile chooses every recursive `.cpp` and `.cxx` workspace source file by default when a folder is open and ignores `.c` and `.cc`
  - terminal `g++ main.cpp other.cpp` preserves both source arguments instead of ignoring them
  - terminal relative paths are resolved from `workspaceCwd`
  - dirty open-tab content overrides on-disk workspace content during compile request assembly
  - local include resolution has the files mounted in the compile overlay even when the included file was edited but not saved
  - `g++ main.cpp other.cpp -o custom-name` records `custom-name` as the runnable artifact and `./custom-name` runs it
  - toolbar **Compile & Run** uses the worker-reported output path rather than assuming `a.out`
  - active-file editor markers remain scoped to the active file while the terminal still prints complete multi-file diagnostics

### Define the compile request model
- Replace the single-source request shape with a build request that includes:
  - `sourcePaths: string[]`
  - `sourceOverridesByPath: Record<string, string | Uint8Array>`
  - `cwd: string`
  - `std: string`
  - `flags: string[]`
  - `primarySourcePath` or equivalent for active-file-focused diagnostics/UX
- Keep the payload workspace-relative so the worker and diagnostics stay consistent across folder roots.
- Define the worker result contract explicitly so the UI can consume multi-file output predictably:
  - `success: boolean`
  - `diagnostics: string`
  - `outputPath: string | null`
  - `diagnosticsByPath?: Record<string, Array<Diagnostic>>`

### Assemble an in-memory workspace overlay before each build
- Add a toolbar/app-level helper that snapshots the active editor content into `_openTabs` before building.
- Build the compile overlay from:
  - all disk-backed workspace files via `readAllWorkspaceFiles()`
  - dirty open tab contents layered on top by workspace path
- Ensure files opened in tabs but not yet switched away from still contribute their latest editor buffer.
- Decide explicitly how to handle a no-workspace state:
  - preserve today’s single-buffer compile path for new unsaved files
  - require an opened folder for whole-project toolbar builds and explicit multi-file terminal builds

### Make toolbar builds project-based by default
- When a workspace is open, enumerate all recursive `.cpp` and `.cxx` files and pass them as the toolbar build target list, explicitly ignoring `.c` and `.cc`.
- Preserve current single-buffer behavior only when no workspace is open.
- Keep Compile & Run chained on successful build, but have it run the actual last-built artifact instead of assuming `a.out`.
- Treat this whole-workspace discovery behavior as an MVP tradeoff: if the workspace contains multiple entry points, surface the linker failure clearly in the terminal and do not try to guess the intended target automatically.

### Make terminal g++ honor explicit source arguments
- Update `cmdGxx()` so it keeps positional source paths instead of discarding them.
- Resolve non-flag arguments relative to `workspaceCwd` using the existing shell path helpers.
- Continue supporting `-std=...`, optimization/warning flags, and now preserve `-o` so the output artifact can be named intentionally.
- Keep terminal behavior predictable when no folder is open:
  - one implicit unsaved buffer compile still works
  - multiple explicit workspace file paths fail fast with a clear message
- Validate explicit source-file arguments against the MVP extension policy and fail clearly for `.c` and `.cc` inputs rather than compiling them silently.

### Rework worker invocation discovery for multiple translation units
- Replace `getCompilerInvocation()` with a planner that parses all emitted `-cc1` subcommands from `clang++ -###`, not just the first one.
- Return a structure such as:
  - `compileSteps: Array<{ sourcePath, compilerArgs, objectPath }>`
  - `linkStep: { linkerArgs, outputPath }`
- Make the planner robust to multiple quoted subcommand lines in driver stderr and preserve user-specified flags like `-o`.

### Compile and link the whole project in the worker
- For each compile step:
  - create a fresh Clang instance
  - mount the full workspace overlay into its FS
  - write all overlay files plus any in-memory source overrides
  - run that step’s `-cc1` args
  - collect the produced object file bytes
- For the link step:
  - create a fresh LLD instance
  - mount sysroot and all produced objects
  - execute the linker args returned by the planner
  - store `compiledBinary` and the actual output artifact path
- Keep compile diagnostics aggregated in terminal order so linker errors still appear after compile errors when applicable.

### Fix include resolution and dirty-file visibility
- Ensure the overlay writes files using their workspace-relative paths so Clang’s normal quoted-include search finds sibling files in the same directory.
- Do not special-case `#include "other.cpp"`; once file paths are mounted correctly, Clang should resolve it naturally relative to the including source file.
- Ensure unsaved sibling-file edits participate in build input so include-based workflows do not compile stale disk content.

### Improve diagnostics for project builds
- Expand `editor.js` diagnostic parsing to accept arbitrary source paths, not just `/input.cpp`.
- Return structured diagnostics keyed by path so the active editor can still show markers for its file while the terminal prints the full multi-file compiler/linker output.
- Keep this scoped to active-file marker rendering first; do not block the feature on implementing cross-tab marker persistence unless needed.

### Track the actual output artifact in the terminal/run flow
- Replace the hardcoded `/a.out` marker in `terminal.js` with `lastBuiltArtifactPath`, populated from the worker-reported `outputPath`.
- Make `./a.out` continue to work for default builds, but also allow `./custom-name` after `-o custom-name`.
- Keep the run button/command backed by the worker’s last compiled WASM binary so execution remains independent from whether the artifact was renamed.
- Define terminal run semantics precisely:
  - `./name` should validate against `lastBuiltArtifactPath`
  - compile-only success should update `lastBuiltArtifactPath`
  - failed builds must not overwrite the last successful runnable artifact

### Update documentation
- Revise `README.md` command documentation and any affected architecture notes.
- Clarify that:
  - toolbar builds compile the whole opened workspace project by default by selecting recursive `.cpp` and `.cxx` files only
  - terminal `g++` accepts explicit file lists
  - local includes resolve from the opened folder, including dirty tab overlays during compile

### Update test entrypoints
- Add `scripts/e2e-multifile-build.test.mjs` to `package.json`'s `test:e2e` script so the new suite runs in normal repository validation.

### Run full validation
- Execute the repository validation commands listed below after implementation and after adding the new E2E coverage.

## Testing Strategy
### Unit Tests
- Add focused coverage for terminal command parsing and path resolution if that logic is extracted into testable helpers.
- Add focused coverage for worker compile-plan parsing:
  - single-source `-###` output still yields one compile step + one link step
  - multi-source `-###` output yields multiple compile steps and one link step
  - `-o custom-name` propagates to the final output artifact
- Add focused coverage for diagnostics parsing across arbitrary file paths.

### Edge Cases
- Included file exists on disk but has unsaved edits in an open tab.
- Active editor buffer has never been switched away from before compile.
- Nested workspace paths such as `src/main.cpp` including `../include/app.hpp`.
- Workspace contains multiple source files with two `main()` definitions and linker failure must surface clearly.
- Terminal current directory is not `/` and the user runs `g++ ./src/main.cpp ./lib/other.cpp`.
- No folder is open and the user attempts a multi-file command.
- Duplicate or overlapping source arguments should not compile the same translation unit twice.
- Header-only workspace still behaves correctly when there is only one actual source file.
- Workspace contains `.c` or `.cc` files alongside `.cpp`/`.cxx`; project discovery ignores them and terminal validation reports them clearly if targeted explicitly.

## Acceptance Criteria
- Opening a folder and clicking **Compile** builds every recursive `.cpp` and `.cxx` file in that workspace by default, while ignoring `.c` and `.cc`.
- Opening a folder and clicking **Compile & Run** builds the same project target set and runs the produced binary on success.
- `g++ main.cpp other.cpp` compiles both files instead of ignoring `other.cpp`.
- `g++` rejects `.c` and `.cc` source arguments under this MVP rather than compiling them.
- `#include "other.cpp"` and normal local header includes resolve when the referenced file exists in the opened workspace.
- Dirty open-tab edits are used during compile even before the user saves them to disk.
- Compiler/linker diagnostics still print in the terminal, and the active file continues to receive usable editor markers.
- Default single-buffer compile behavior remains available when no workspace is open.

## Validation Commands
Execute every command to validate the feature works correctly with zero regressions.

```bash
npm run lint
npm run build
node --experimental-detect-module --test scripts/e2e-multifile-build.test.mjs
npm run test:e2e
```

## Notes
- This plan intentionally keeps the existing browsercc + `clang++ -###` architecture rather than replacing it with a custom direct Clang invocation model.
- The current README/help text and terminal behavior are out of sync around `g++ [file] [-o out]`; implementing this feature is a good point to realign them.
- The worker already mounts workspace files for runtime `fstream`; the compile path should converge on the same workspace-relative model rather than inventing a second path scheme.
- Ignoring `.c` and `.cc` is an intentional product constraint for this MVP, even though `.cc` is commonly used for C++ in some codebases.
