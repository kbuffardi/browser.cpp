# Feature: Auto-create browser releases on manifest version bumps

## Feature Description
When `manifest.json` changes its `version` field in a new pull request, GitHub Actions should automatically prepare a new release for every supported browser target. The release process should detect the version bump, build the extension artifacts, package browser-specific release outputs, and stage the release assets for maintainer review through the repository's existing GitHub release workflow.

## User Story
As a browser.cpp maintainer
I want a release to be created automatically when the extension version changes in a PR
So that I do not need to manually coordinate version bumps, packaging, and browser release preparation

## Problem Statement
Release creation is currently too manual for version-driven updates. The repository already has:

- a `manifest.json` version field that should serve as the extension version source of truth
- CI that runs lint, build, and E2E checks on pull requests
- a release workflow that is currently triggered by `workflow_dispatch` and version tags
- packaging and version-sync scripts that can validate the release state

What is missing is the automation that ties a manifest version bump in a PR to a release-ready output for each supported browser. Without that connection, version changes can pass review without producing the correct release artifacts or clear release signals for maintainers.

## Solution Statement
Add a release-oriented GitHub Actions path that is aware of `manifest.json` version changes and turns them into validated browser release artifacts.

The solution should:

1. Detect when a PR changes `manifest.json.version`.
2. Treat `manifest.json` as the source of truth for the release version and update `package.json.version` from it.
3. Validate that the version bump is intentional and in sync with the release metadata.
4. Build and package the extension for each supported browser target using the existing release packaging flow.
5. Upload release artifacts for same-repo PRs only, while skipping forked PRs.
6. Keep the current human-owned browser store publication flow explicit in documentation.

The implementation should reuse the current release scripts and workflows instead of introducing a separate release system.

## Relevant Files
Use these files to implement the feature:

- `manifest.json`
  - Source of truth for the extension version and the file whose `version` changes should trigger release handling.
- `package.json`
  - Holds scripts that can be extended or reused for version checks, release packaging, and workflow validation; its version should be kept in sync with `manifest.json`.
- `.github/workflows/ci.yml`
  - Current PR CI entrypoint; likely needs version-change awareness or release-prep checks.
- `.github/workflows/release.yml`
  - Existing release workflow that should be extended or triggered when version changes are detected.
- `scripts/check-release-version-sync.js`
  - Fast validation for version consistency between manifest and release metadata.
- `scripts/package-extension-release.js`
  - Canonical packaging entrypoint for browser-specific release artifacts.
- `scripts/e2e-release-packaging.test.mjs`
  - Integration coverage for release packaging behavior and version-driven release readiness.
- `README.md`
  - Current release/build documentation that should point maintainers to the automated release path.
- `docs/release-playbook.md`
  - Runbook for what happens automatically and what remains human-owned after the automation is added.

### New Files
- `.github/workflows/release-on-version-change.yml`
  - Workflow that watches PRs for `manifest.json` version bumps and creates release candidates or uploads release artifacts automatically.
- `scripts/detect-manifest-version-change.js`
  - Small helper that determines whether the current PR changes `manifest.json.version` and emits the target version.
- `scripts/build-release-candidate.js`
  - Optional orchestration helper if the workflow needs a single Node entrypoint for version validation and packaging.

## Implementation Plan
### Phase 1: Version-change detection
Establish the exact trigger condition for release automation. The workflow should compare the current PR head against the base branch and only activate the release path when `manifest.json.version` changes. This phase should also define what counts as a valid version bump, how `package.json.version` is derived from the manifest, and how the detected version is passed into later steps.

### Phase 2: Release artifact generation
Reuse the existing release packaging code to build browser-specific artifacts whenever a version bump is detected. The release path should produce the same validated outputs that a manual release would produce, including the browser-labeled artifacts and any metadata needed by maintainers.

### Phase 3: GitHub Actions integration
Add or update a workflow so same-repo PRs with version bumps automatically produce release artifacts for review. The workflow should run the version-sync validator, build and package the release outputs, and publish artifacts for review. Forked PRs should be skipped rather than attempting privileged release steps. It should not silently publish to external browser stores.

### Phase 4: Documentation and process alignment
Document the new automated behavior in the release playbook and README. Make it clear which steps happen automatically on version changes, which steps still require maintainer approval, and how the browser-specific release flow is expected to proceed after the workflow completes.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### Confirm the version bump contract
- Define `manifest.json.version` as the trigger input for release automation.
- Define `package.json.version` as derived from `manifest.json.version` and updated from the manifest as part of the release workflow.
- Decide whether patch/minor/major changes all create the same kind of release candidate or whether the workflow needs different behavior by version type.
- Confirm that PRs without a version bump should not produce release artifacts.

### Add version-change detection
- Implement a small script or workflow step that compares the PR base and head versions.
- Fail fast if the manifest version is malformed or the comparison cannot be made reliably.
- Pass the detected version into the release workflow so artifact names and metadata stay aligned.
- Skip the workflow for forked PRs, since the automation should only run on same-repo pull requests where repository-scoped permissions are predictable.

### Wire the release workflow
- Add a workflow that runs on pull requests and/or manual dispatch when `manifest.json.version` changes.
- Reuse the existing lint, build, E2E, and release packaging checks.
- Upload browser-specific artifacts for review rather than publishing directly to stores.
- Treat browser-specific artifacts as labeled copies of the same MV3 payload, not distinct per-browser builds.

### Tighten release validation
- Run `scripts/check-release-version-sync.js` before packaging.
- Ensure the release package is built from a clean workspace.
- Verify the browser-specific release artifacts match the expected naming convention.

### Update documentation
- Add the new automation behavior to the release playbook.
- Document the maintainer review step after the automated release candidate is produced.
- Update README release guidance so maintainers know how version bumps map to automated release creation.

### Validate the flow
- Run the repository's lint, build, E2E, and release packaging commands.
- Verify that a PR with a `manifest.json` version bump produces the expected release candidate output.
- Verify that a PR without a version bump does not trigger release artifact creation.
- Verify that forked PRs are skipped by the release automation path.

## Testing Strategy
### Unit Tests
- Test version-change detection against matching and mismatching PR diffs.
- Test release metadata generation for the detected version.
- Test that package naming stays aligned with the manifest version.

### Edge Cases
- `manifest.json` contains an invalid version string.
- A PR changes files other than `manifest.json` and should not trigger release automation.
- A PR changes `manifest.json` but not the `version` field.
- The detected version does not match the version-sync validator.

## Acceptance Criteria
- A same-repo PR that changes `manifest.json.version` automatically produces a release artifact workflow run.
- A PR that does not change `manifest.json.version` does not create release artifacts.
- Forked PRs are skipped by the release automation path.
- The release workflow uses the repository's existing packaging and version-sync scripts.
- Browser-specific release outputs are produced or uploaded for every supported target.
- The release playbook documents the new automatic behavior and the remaining human-owned steps.

## Validation Commands
Execute every command to validate the feature works correctly with zero regressions.

- `npm run lint`
- `npm run build`
- `npm run test:e2e`
- `npm run release:check-version`
- `npm run package:release`

## Notes
- Issue: `#31`
- The current release workflow is tag/manual driven, so the implementation should be careful about when automation creates release candidates versus when it publishes final releases.
- The automatic path should remain compatible with the existing multi-browser release artifact model.
