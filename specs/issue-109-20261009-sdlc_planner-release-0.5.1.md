# Feature: Patch release version bump to 0.5.1

## Feature Description

Bump browser.cpp's release metadata from `0.5.0` to `0.5.1` so the next extension package reflects a patch release after the Settings drawer theme-preview fix. The value in `manifest.json` remains the canonical project version, with npm metadata kept in sync.

## User Story

As a browser.cpp maintainer
I want to publish a patch version bump
So that the next release clearly identifies the latest patched extension build

## Problem Statement

The latest merged fix is still represented by the previous release version `0.5.0` on `main`. Release packaging and user-visible extension metadata need a patch increment to `0.5.1`.

## Solution Statement

Update the canonical extension version in `manifest.json` to `0.5.1`, then keep `package.json` and both package-lock root version fields aligned with that value. Validate with the repo's version-sync checks plus the standard lint, build, and E2E commands.

## Relevant Files

Use these files to implement the feature:

- `manifest.json` - Canonical Chrome extension manifest version used by the runtime and release packaging.
- `package.json` - npm package metadata that must match the manifest version.
- `package-lock.json` - lockfile metadata with top-level and root-package versions that must match the manifest version.
- `scripts/sync-version-from-manifest.js` - Existing version alignment check used to validate the metadata.
- `scripts/check-release-version-sync.js` - Release validation for source and built manifest/package version agreement.
- `scripts/e2e-release-packaging.test.mjs` - Existing E2E coverage for version sync and release packaging behavior.

### New Files

- `specs/issue-109-20261009-sdlc_planner-release-0.5.1.md` - This implementation plan.

## Implementation Plan

### Phase 1: Foundation

Confirm the current release version on `main`, verify that `manifest.json` is the canonical source, and create GitHub Issue #109 as the source of truth for the release bump.

### Phase 2: Core Implementation

Update `manifest.json`, `package.json`, and `package-lock.json` from `0.5.0` to `0.5.1` without changing dependencies, runtime code, or build configuration.

### Phase 3: Integration

Run version synchronization, release version checks, lint, build, and E2E validation. Open a pull request from a release branch that closes Issue #109.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Confirm Current Version State

- Read `manifest.json`, `package.json`, and `package-lock.json`.
- Confirm `main` reports `0.5.0` before the bump.
- Confirm no runtime source files need changes.

### 2. Update Version Metadata

- Set `manifest.json` version to `0.5.1`.
- Set `package.json` version to `0.5.1`.
- Set `package-lock.json` top-level version to `0.5.1`.
- Set `package-lock.json` `packages[""].version` to `0.5.1`.

### 3. Validate Version Alignment

- Run the version sync check.
- Run the release version check after build output exists.
- Confirm no unintended file changes are present.

### 4. Run Standard Validation

- Run every command in the Validation Commands section.
- Fix only release-metadata issues if any command fails.

### 5. Publish Review Artifacts

- Commit the release bump and plan.
- Push a release branch.
- Open a PR that references `closes #109`.

## Testing Strategy

### Unit Tests

No new unit tests are required because this is static release metadata. Existing release/version tests already cover version synchronization, mismatch detection, and package metadata alignment.

### Edge Cases

- `manifest.json` changes but npm metadata does not.
- `package-lock.json` top-level version changes but `packages[""].version` does not.
- Build output manifests retain an old version.
- Release checks run before build output exists.

## Acceptance Criteria

- `manifest.json` reports `0.5.1`.
- `package.json` reports `0.5.1`.
- `package-lock.json` reports `0.5.1` for both root version fields.
- Version sync and release sync checks pass.
- Lint, build, and standard E2E tests pass.
- A pull request is opened and linked with `closes #109`.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

```bash
npm run version:check
npm run lint
npm run build
npm run release:check-version
npm run test:e2e
```

## Notes

- This patch bump intentionally does not modify runtime code.
- Browser smoke tests are not required for this metadata-only change; the standard E2E release packaging tests cover the version logic.
