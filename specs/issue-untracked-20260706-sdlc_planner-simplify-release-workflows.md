# Feature: Simplify GitHub release workflows around manifest-driven versioning

## Feature Description
Reshape the project's release automation so there is one canonical GitHub Actions release workflow, one canonical release trigger, and one canonical version source. The workflow should treat `manifest.json` as the authoritative version for the extension, keep any duplicate version fields synchronized to that value, and use GitHub Actions plus GitHub Releases to publish one GitHub release per version with browser-specific release packages attached as assets where distinct packages are required.

This is primarily a workflow-simplification and ownership change, not a packaging rewrite. The repository already has working packaging, release validation, and one checked-in release workflow file. The missing piece is consolidating release behavior so maintainers no longer have to reason about separate tag-first versus manifest-first release paths, and so `package.json` is no longer the implicit version authority for release logic.

## User Story
As a browser.cpp maintainer
I want releases to be created automatically from a new `manifest.json` version
So that the extension version is defined in one place and GitHub publishes one predictable release containing the correct packages for Chrome, Edge, Firefox, Brave, and Chromium

## Problem Statement
The current repository already includes substantial release plumbing, but it is not aligned with the desired operating model:

- The current release pipeline in [.github/workflows/release.yml](/Users/kevin/Documents/Work/Development/browser.cpp/.github/workflows/release.yml) is triggered by `workflow_dispatch` and tag pushes, then uploads packaged artifacts as workflow artifacts.
- GitHub Release creation is still a separate concern from artifact packaging; the workflow does not currently create or update a GitHub release.
- The revised requirement is not multiple browser-named GitHub Releases. It is one GitHub Release per version that includes per-browser packages only where the package contents are not identical. The plan therefore needs an explicit package matrix instead of a browser-specific release-name model.
- `scripts/check-release-version-sync.js` treats `package.json.version` as the primary version and validates `manifest.json` against it, which is the opposite of the requested source-of-truth.
- The project also stores the root package version in [package-lock.json](/Users/kevin/Documents/Work/Development/browser.cpp/package-lock.json), so version duplication already exists outside `manifest.json`.
- The current packaging script already emits browser-labeled ZIPs for Chrome, Edge, Brave, and Chromium, but not Firefox, so the plan must either add a Firefox artifact target or explicitly block release publication until Firefox packaging is implemented.
- The local checkout on July 6, 2026 contains only two workflow files total, [ci.yml](/Users/kevin/Documents/Work/Development/browser.cpp/.github/workflows/ci.yml) and [release.yml](/Users/kevin/Documents/Work/Development/browser.cpp/.github/workflows/release.yml). There is not a second checked-in `release*.yml` file to delete, so the simplification target should be interpreted as consolidating release behavior and trigger strategy rather than merely removing a duplicate workflow file.

Without an explicit manifest-first release contract and package-matrix contract, the repository can package release artifacts, but it still relies on duplicated version ownership and a tag-driven path that does not match the requested "new manifest version creates one release with the required browser packages" model.

## Solution Statement
Make `manifest.json` the sole authoritative release version and convert the existing release workflow into the only release entry point:

1. Add a small version utility layer so release scripts read the project version from `manifest.json`.
2. Add a sync/check mechanism that updates `package.json` and `package-lock.json` from `manifest.json` and fails CI if they drift.
3. Define a release package matrix for `chrome`, `edge`, `firefox`, `brave`, and `chromium` that records whether each browser gets:
   - a distinct package
   - a shared package alias
   - or a blocked release until compatibility work exists
4. Change `.github/workflows/release.yml` to trigger from pushes to `main` and to decide whether a release is needed by checking whether `v<manifest.version>` already exists as a Git tag or GitHub Release.
5. When a new manifest version is detected, run the existing release validation and packaging path once, create or update the single GitHub Release for `v<manifest.version>`, and upload the per-browser release packages plus shared metadata assets to that release.
6. Keep `workflow_dispatch` only as a manual recovery/replay entry point inside the same workflow, not as a separate release process.

This preserves the current Node-based packaging implementation and existing validation scripts while simplifying operational ownership: one version source, one workflow, one GitHub Release per version, and a deterministic set of browser package assets.

## Relevant Files
Use these files to implement the feature:

- [manifest.json](/Users/kevin/Documents/Work/Development/browser.cpp/manifest.json)
  - Will become the canonical version authority for the project and release automation.
- [package.json](/Users/kevin/Documents/Work/Development/browser.cpp/package.json)
  - Currently duplicates the project version and defines the release-related scripts that will need manifest-first semantics.
- [package-lock.json](/Users/kevin/Documents/Work/Development/browser.cpp/package-lock.json)
  - Also carries duplicated root version fields and must be kept aligned with `manifest.json`.
- [.github/workflows/release.yml](/Users/kevin/Documents/Work/Development/browser.cpp/.github/workflows/release.yml)
  - Existing release workflow; should become the single release workflow and the place where GitHub Release creation happens.
- [.github/workflows/ci.yml](/Users/kevin/Documents/Work/Development/browser.cpp/.github/workflows/ci.yml)
  - Should block drift by running the new version-sync check on normal pull requests.
- [scripts/check-release-version-sync.js](/Users/kevin/Documents/Work/Development/browser.cpp/scripts/check-release-version-sync.js)
  - Currently validates manifest and tag values against `package.json`; needs to be inverted to manifest-first logic and expanded to include lockfile drift.
- [scripts/package-extension-release.js](/Users/kevin/Documents/Work/Development/browser.cpp/scripts/package-extension-release.js)
  - Already packages release artifacts; should consume the manifest-first version contract, add Firefox if supported, and expose enough target metadata for single-release asset publication.
- [scripts/e2e-release-packaging.test.mjs](/Users/kevin/Documents/Work/Development/browser.cpp/scripts/e2e-release-packaging.test.mjs)
  - Existing test coverage for packaging/version sync; should be extended to cover manifest-first validation, Firefox target behavior, and the package-matrix metadata assumptions the workflow depends on.
- [scripts/smoke-browser.mjs](/Users/kevin/Documents/Work/Development/browser.cpp/scripts/smoke-browser.mjs)
  - Current smoke coverage exists for Chrome, Edge, Brave, and Chromium; the plan must explicitly account for the lack of Firefox support here before promising a Firefox release.
- [README.md](/Users/kevin/Documents/Work/Development/browser.cpp/README.md)
  - Documents the current release flow and should be updated to describe the single manifest-driven workflow that creates one GitHub Release containing browser-specific package assets.
- [AGENTS.md](/Users/kevin/Documents/Work/Development/browser.cpp/AGENTS.md)
  - Defines the baseline validation commands that the implementation must continue to respect.

### New Files
- [scripts/project-version.js](/Users/kevin/Documents/Work/Development/browser.cpp/scripts/project-version.js)
  - Shared helper to read and validate the canonical version from `manifest.json` so other scripts stop hard-coding `package.json` as the source.
- [scripts/sync-version-from-manifest.js](/Users/kevin/Documents/Work/Development/browser.cpp/scripts/sync-version-from-manifest.js)
  - Utility to update `package.json` and `package-lock.json` root version fields from `manifest.json`, with `--check` support for CI.
- [scripts/release-targets.js](/Users/kevin/Documents/Work/Development/browser.cpp/scripts/release-targets.js)
  - Shared browser target metadata, including artifact names, package strategy, browser labels, and support flags so packaging and workflow logic do not drift.

## Implementation Plan
### Phase 1: Establish the manifest-first version contract
Define and codify that `manifest.json.version` is the only version that drives release behavior. Add shared utilities and CI checks so all duplicate version fields either derive from or are validated against that source. This phase removes ambiguity before any workflow trigger changes.

### Phase 2: Consolidate release automation into one workflow
Refactor the existing release workflow so it becomes the single release path. The workflow should detect whether the current manifest version has already been released, run the existing validation/build/package sequence once when it has not, and then create or update the single Git tag and GitHub Release while attaching the correct browser packages for all supported targets.

### Phase 3: Document and rehearse the simplified operational model
Update documentation and rehearse the new release path so maintainers understand that a version bump in `manifest.json` is the release signal and that one GitHub Release publishes a browser package set for Chrome, Edge, Firefox, Brave, and Chromium.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### Audit and lock the intended release contract
- Confirm the intended branch for automatic release creation. This plan assumes `main`.
- Confirm the intended release visibility. This plan assumes a published GitHub Release rather than a draft, because the user asked to create a new GitHub release when the manifest version changes.
- Confirm the browser package matrix. This revised plan assumes:
  - `Chrome`
  - `Firefox`
  - `Edge`
  - `Brave`
  - `Chromium`
- Confirm the release naming contract:
  - Git tag: `v<version>`
  - GitHub Release name: either `v<version>` or `<version>`, chosen once and used consistently
- Confirm the package naming contract:
  - asset filenames remain browser-labeled, for example `browser-cpp-chrome-v<version>.zip`
  - identical payloads may still produce separate browser-labeled assets if that improves operator clarity
  - alternatively, identical payloads may collapse to one canonical asset only if the release manifest and documentation make that mapping explicit
- Confirm the intended duplicate version set. This plan assumes at minimum:
  - `manifest.json.version`
  - `package.json.version`
  - root package version fields in `package-lock.json`
- Record in the implementation notes that the repo currently has one checked-in release workflow file already; the simplification target is the release mechanism, not a missing second workflow file.
- Record that Firefox is not currently present in packaging or smoke-test targets and must be treated as a first-class implementation task rather than an assumed alias.
- Record that Firefox publication likely needs additional compatibility work beyond naming, including Firefox-specific manifest requirements and a real packaging contract if the current MV3 Chromium artifact is not directly usable.
- Record the intended package-sharing strategy explicitly:
  - which browsers can share the exact same payload
  - which browsers need distinct packaging
  - whether shared payloads are published once or duplicated under browser-specific filenames

### Introduce shared manifest-version utilities
- Add `scripts/project-version.js` to:
  - read `manifest.json`
  - validate that `version` exists and is non-empty
  - expose a reusable `readProjectVersion()` helper
- Refactor release-oriented scripts to import this helper instead of reading `package.json.version` first.
- Keep the helper narrowly scoped to version ownership so it can be reused from CI and packaging without creating unrelated coupling.

### Add a manifest-to-package sync/check script
- Add `scripts/sync-version-from-manifest.js`.
- Support two modes:
  - default mode updates `package.json` and `package-lock.json` root version fields to the manifest version
  - `--check` mode exits non-zero when those files are out of sync
- Update `package.json` scripts to add explicit commands such as:
  - `version:sync`
  - `version:check`
- Decide whether the implementation should auto-sync during release steps or require committed sync changes before CI passes. This plan recommends requiring committed sync changes and using `version:check` in CI so version drift is visible in review.

### Invert release validation to manifest-first semantics
- Update `scripts/check-release-version-sync.js` so it:
  - reads the canonical version from `manifest.json`
  - verifies `package.json.version === manifest.json.version`
  - verifies the root version fields in `package-lock.json` equal `manifest.json.version`
  - verifies `dist/manifest.json.version === manifest.json.version` after build
  - verifies the release tag, when present, matches `v<manifest.version>` or `<manifest.version>`
- Update the script's success and failure messages so they describe `manifest.json` as the source of truth.
- Update release packaging tests to reflect the inverted error wording and validation order.

### Refactor packaging code to consume the shared version contract
- Update `scripts/package-extension-release.js` so its versioned filenames and release metadata come from the manifest-first validation result rather than from `package.json`.
- Move browser target definitions into `scripts/release-targets.js` so packaging and workflow asset publication use the same target list.
- Add or explicitly gate a Firefox packaging target:
  - if Firefox support is feasible in the current extension architecture, generate `browser-cpp-firefox-v<version>.zip`
  - if Firefox support is not yet feasible, fail the workflow before release publication instead of silently omitting the Firefox package
  - do not publish a Firefox asset that simply re-labels a Chromium artifact without an explicit compatibility decision
- Define package strategy per target in shared metadata:
  - `distinct` for browsers that need their own package
  - `shared-with:<target>` for browsers that intentionally reuse another target's payload
  - `blocked` for browsers that are not yet releasable
- Keep the packaging surface area unchanged where possible:
  - same artifact naming pattern
  - same checksum generation
  - same release manifest output
- Extend release manifest output to include, per target:
  - browser key
  - artifact file name
  - browser label
  - package strategy
  - payload identity or shared-payload group
  - publish eligibility
- Avoid bundling GitHub Release creation into the packager; keep the packager responsible only for local artifacts and machine-readable target metadata.

### Extend automated test coverage for version ownership
- Expand `scripts/e2e-release-packaging.test.mjs` to cover:
  - manifest/package mismatch failure
  - manifest/package-lock mismatch failure
  - dist manifest mismatch failure after build
  - successful packaging when all tracked versions match manifest
  - tag validation against the manifest version
- Expand release tests to cover target metadata:
  - `chrome`, `edge`, `firefox`, `brave`, and `chromium` are present in shared target metadata
  - each target declares `distinct`, `shared-with`, or `blocked`
  - shared payload groups are explicit and deterministic
- Add coverage that the release manifest exposes enough data for the workflow to publish the correct assets to the single GitHub Release without hard-coded duplication in YAML.
- Add a focused test for `scripts/sync-version-from-manifest.js` if the implementation extracts reusable functions; otherwise validate its behavior through integration-style script tests.

### Turn the existing release workflow into the single release path
- Update `.github/workflows/release.yml` to trigger on:
  - `push` to `main`
  - optional `workflow_dispatch` for manual reruns/recovery
- Remove the tag-push trigger so the workflow is no longer waiting for an externally created release tag.
- Add a first job or early step that determines:
  - the current manifest version
  - the browser target matrix from shared metadata
  - whether `v<manifest.version>` already exists as a Git tag
  - whether the GitHub Release for `v<manifest.version>` already exists
- Define "new version" in terms of repository state, not just the previous commit:
  - if the version is not yet tagged/released, the workflow should proceed
  - if the version already has a tag/release, the workflow should no-op unless explicitly forced through `workflow_dispatch`
- Use GitHub's API or `gh` inside the workflow to avoid brittle git-history-only comparisons.
- Structure the workflow so build/package work happens once, then asset publication uses the generated metadata to upload the correct package set to the single release.

### Add GitHub Release creation to the same workflow
- After validation and packaging succeed, have the workflow:
  - create tag `v<manifest.version>` if it does not already exist
  - create or update the GitHub Release for that tag
  - attach the browser package assets selected by shared target metadata
  - attach shared checksum and release-manifest files to that release
- Ensure the workflow can publish any of these package sets correctly:
  - one package reused across multiple browsers but exposed as multiple browser-labeled assets
  - one canonical shared asset plus distinct assets for browsers that differ
  - all-distinct assets when browser packaging truly diverges
- Prefer a single implementation mechanism for this, such as:
  - `actions/github-script` calling the GitHub Releases API, or
  - `gh release create` / `gh release upload`
- Keep permissions minimal but sufficient, likely `contents: write` for the release workflow.
- Ensure reruns are idempotent:
  - rerunning the workflow for an existing version release should update or re-upload assets cleanly rather than fail on "already exists"
- Use a loop or generated asset list driven from shared target metadata rather than hard-coding browser decisions in YAML.

### Keep CI focused on drift prevention
- Update `.github/workflows/ci.yml` to run the new `version:check` command on pull requests.
- Keep the existing lint/build/E2E coverage intact.
- Ensure CI does not attempt to publish releases; it should only prove that a branch is ready for the single release workflow.

### Update maintainer documentation
- Update `README.md` so the release process is described as:
  - bump `manifest.json.version`
  - sync duplicate versions
  - merge to `main`
  - let the release workflow package artifacts and publish the single GitHub Release
- Remove or rewrite any documentation that still implies tag-first release creation as the primary path.
- Document the manual recovery path through `workflow_dispatch`, including when it is appropriate to force a rerun.
- Document the package-matrix contract with concrete examples such as:
  - `browser-cpp-chrome-v0.2.2.zip`
  - `browser-cpp-edge-v0.2.2.zip`
  - `browser-cpp-firefox-v0.2.2.zip`
  - `browser-cpp-brave-v0.2.2.zip`
  - `browser-cpp-chromium-v0.2.2.zip`
- Document which of those assets are expected to be byte-identical versus distinct, and why.

### Rehearse the end-to-end flow before sign-off
- Validate a non-release change on a branch to confirm the release workflow no-ops when the manifest version already exists.
- Validate a version-bump branch merged into a test-safe target or rehearsal path to confirm:
  - version checks pass
  - packages are built
  - all target release artifacts are produced, including Firefox if supported
  - one Git tag and one GitHub Release are created
  - the single release gets the correct browser package assets
  - shared metadata assets land in the documented place
- Capture any operational edge cases discovered during the rehearsal and fold them back into the workflow or docs before closing the work.

### Run the full validation commands
- Execute every command in the Validation Commands section and fix all regressions before final sign-off.

## Testing Strategy
### Unit Tests
- Add tests for the shared manifest-version reader.
- Add tests or integration coverage for `sync-version-from-manifest` in both update and `--check` modes.
- Extend release packaging tests so the validator clearly enforces manifest-first version ownership.
- Add tests for shared release-target metadata so package strategy cannot drift from artifact naming and workflow expectations.

### Edge Cases
- `manifest.json.version` changes but duplicate version fields were not synced before the PR.
- A maintainer reruns the release workflow for a version whose release already exists but some assets are missing or stale.
- A tag exists but its GitHub Release does not, or the reverse.
- `package-lock.json` contains multiple root version locations and only one gets updated.
- A release workflow runs on a push that touches `manifest.json` but does not actually change the version string.
- A backport or revert reintroduces an older manifest version that already has a published release.
- Firefox packaging is requested but the underlying extension metadata or build assumptions are not yet compatible with Firefox.
- The package matrix says two browsers share a payload, but the documentation or release manifest claims they are distinct.

## Acceptance Criteria
- `manifest.json.version` is treated as the documented and enforced source of truth for release versioning.
- Duplicate tracked version fields in `package.json` and `package-lock.json` are synchronized from `manifest.json` and checked in CI.
- There is one checked-in GitHub release workflow responsible for release packaging and GitHub Release publication.
- The release workflow no longer depends on a pre-existing manually created tag as the primary trigger.
- A new, unreleased manifest version merged to the release branch causes GitHub Actions to package artifacts and create or update a single GitHub Release for that version.
- The workflow creates or reuses the single tag `v<version>`.
- The single release contains the correct package assets for Chrome, Edge, Firefox, Brave, and Chromium according to the defined package matrix.
- Rerunning the release workflow for an already released version is safe and idempotent.
- Existing release artifact outputs remain intact: browser ZIPs, checksum file, and release manifest JSON.
- The release manifest exposes enough metadata for the workflow to map each browser target to the correct asset strategy without duplicated hard-coded target logic.
- Repository documentation matches the manifest-driven release model.

## Validation Commands
Execute every command to validate the feature works correctly with zero regressions.

```bash
npm ci
npm run version:sync
npm run version:check
npm run lint
npm run build
npm run release:check-version
npm run test:e2e
npm run package:release
```

GitHub-side validation after merge:

```bash
VERSION=$(node -p "require('./manifest.json').version")
gh release view "v${VERSION}"
```

Notes for validation:
- The GitHub-side check should be run only after the release workflow has completed on the target branch.
- If the implementation uses a different helper name than `version:sync` / `version:check`, update these commands to match the final script names.

## Notes
- No GitHub issue number was provided with this request. Before implementation starts, this plan should be linked to an existing issue or a new issue should be created so the work follows the repository's GitHub workflow requirement.
- The current repository already contains one release workflow file and a substantial amount of release packaging infrastructure. The implementation should prefer targeted refactoring over replacing working packaging code.
- The most important design choices in this revised plan are:
  - defining "new version" against the existing release/tag rather than against `HEAD~1`
  - separating release identity from package identity so one GitHub Release can carry multiple browser assets
  - treating Firefox as an explicit implementation requirement, not as an assumed synonym for the Chromium artifact
