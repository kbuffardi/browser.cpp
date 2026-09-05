# Feature: Deprecate Firefox support and disable deployment

## Feature Description

Mark Firefox support as deprecated and remove it from automated release and CI
paths. Firefox-specific code and local validation may remain temporarily for
existing users and a possible future removal, but Firefox is no longer a
supported deployment target or a normal pull-request quality gate. Chromium-
family release artifacts and deployment behavior must remain unchanged.

The repository's general CI workflow will become manually triggered only. The
release-candidate workflow must also stop treating Firefox validation as a
release gate.

## User Story

As a release maintainer
I want Firefox support and deployment clearly marked as deprecated
So that releases and routine CI focus on maintained Chromium-family targets
without implying Firefox receives ongoing support.

## Problem Statement

The protected release workflow currently requires `AMO_JWT_ISSUER` and
`AMO_JWT_SECRET`, runs Firefox packaging smoke validation, and signs an unlisted
XPI before uploading every release directory. The general CI workflow runs on
pull requests and includes Firefox smoke validation. README and the release
playbook describe Firefox as an active distribution channel.

The release metadata already excludes Firefox from the publishable ZIP artifact
set, but the workflow still performs Firefox signing and publishes the resulting
XPI. This creates an unnecessary release dependency and leaves the deployment
state inconsistent across workflows, scripts, tests, and documentation.

## Solution Statement

1. Remove Firefox signing and Firefox deployment-specific steps from the
   protected release workflow.
2. Change `.github/workflows/ci.yml` to `workflow_dispatch` only, removing its
   automatic pull-request trigger and Firefox smoke step from routine CI.
3. Remove Firefox smoke validation from the release-candidate workflow so a
   version-bump PR is not gated by deprecated Firefox support.
4. Update release metadata, tests, and documentation to identify Firefox as
   deprecated and ensure releases contain only Chromium-family artifacts.
5. Retain Firefox source/runtime code and local commands temporarily, with a
   documented follow-up path for complete removal after usage/ownership review.

## Relevant Files

- `.github/workflows/release.yml` - Remove AMO secret validation, Firefox signing,
  and any release-upload assumptions tied to the signed XPI.
- `.github/workflows/release-on-version-change.yml` - Remove Firefox smoke
  validation from release-candidate gating and keep candidate uploads limited to
  maintained Chromium-family artifacts.
- `.github/workflows/ci.yml` - Change the trigger to `workflow_dispatch` only and
  remove the Firefox smoke step from the manually run general CI workflow.
- `scripts/release-targets.js` - Represent Firefox as disabled for deployment with
  an explicit stable reason and no publishable artifact contract.
- `scripts/package-extension-release.js` - Ensure release manifests, checksums,
  stale-artifact cleanup, and payload handling cannot include Firefox deployment
  artifacts.
- `scripts/e2e-release-packaging.test.mjs` - Update regression assertions for the
  disabled deployment state and verify no Firefox asset is emitted.
- `scripts/sign-firefox-unlisted.mjs` and `scripts/sign-firefox-listed.mjs` -
  Retain temporarily only as deprecated/manual tools, or remove them in a later
  cleanup once Firefox users and maintainers have been assessed.
- `scripts/firefox-webext.js` - Retain shared Firefox build/smoke helpers if
  Firefox validation remains supported.
- `package.json` - Keep Firefox commands only as explicitly deprecated/manual
  commands during the transition; do not invoke them from automated release or
  routine CI.
- `README.md` - Revise release workflow and Firefox deployment instructions to
  state that automated deployment is disabled and remove obsolete AMO/XPI
  release steps.
- `docs/release-playbook.md` - Document the disabled state, deferred re-enable
  requirements, and the remaining Firefox validation path.

### New Files

None expected.

## Implementation Plan

### Phase 1: Foundation

- Confirm the deprecation status, effective date, owner, and whether a future
  removal date is advisory or compulsory.
- Identify the GitHub Issue that will be the source of truth. If none exists,
  create one before implementation and link the eventual PR with `Closes #<id>`.
- Inventory active Firefox consumers/owners as far as the repository can show and
  document the migration target: Chromium, Edge, Brave, or Chromium builds.
- Assert the desired post-change contract: one Chromium-family ZIP, checksums,
  and release manifest; no signed Firefox XPI or Firefox deployment metadata in
  uploaded release directories.

### Phase 2: Core Implementation

- Update `.github/workflows/release.yml` to remove AMO credential validation,
  Firefox smoke validation, and the `sign:firefox:unlisted` step. Keep the
  normal build/package/release flow fail-closed for missing Chromium artifacts.
- Update `.github/workflows/ci.yml` so its only event is `workflow_dispatch` and
  remove its Firefox smoke step.
- Update `.github/workflows/release-on-version-change.yml` to remove its Firefox
  smoke step and ensure candidate uploads contain only maintained artifacts.
- Update release target metadata and packaging logic so Firefox is represented as
  disabled/non-publishable without requiring `dist-firefox` for a deployable
  release, while preserving Chromium-family payload generation.
- Add or revise release-package tests covering the absence of Firefox artifacts,
  absence of AMO-signing requirements, and preservation of Chromium artifacts.
- Mark retained Firefox signing and smoke commands as deprecated/manual in
  documentation and avoid adding new Firefox features during the deprecation
  period.

### Phase 3: Integration

- Update the release-candidate workflow to match the deployment contract and
  ensure artifact upload contains no Firefox deployment output.
- Do not run Firefox smoke testing in normal CI or release-candidate validation.
  If a maintainer needs a final compatibility check, run it manually using the
  existing command before removing the deprecated path.
- Update README and the release playbook, including the future re-enable checklist:
  AMO credentials, signing workflow, artifact assertions, owner-managed AMO
  submission, and manual Firefox runtime QA.
- Review generated release metadata and workflow logs for secret references,
  stale XPI paths, and contradictory claims.

## Step by Step Tasks

### Step 1: Confirm scope and create the GitHub Issue

- Confirm Firefox is deprecated, not merely deployment-disabled, and record the
  deprecation date, owner, migration guidance, and any planned removal date.
- Confirm whether local `sign:firefox:*` commands remain temporarily available
  as deprecated/manual tools or are removed in this change.
- Create or identify the GitHub Issue and record this plan and the decision
  history there before implementation.

### Step 2: Remove automated Firefox deployment

- Remove the AMO secret preflight, Firefox smoke step, and protected `Sign Firefox
  unlisted XPI` step from `.github/workflows/release.yml`.
- Remove assumptions that a signed XPI must be present for a normal release.
- Preserve release permissions and the GitHub Release publication for the
  Chromium-family artifacts.

### Step 3: Change CI and release-candidate triggers

- Change `.github/workflows/ci.yml` from pull-request plus manual execution to
  `workflow_dispatch` only.
- Remove the Firefox smoke step from `.github/workflows/ci.yml`.
- Remove the Firefox smoke step from `.github/workflows/release-on-version-change.yml`.
- Verify no automatic workflow still treats Firefox as a required quality gate.

### Step 4: Align release metadata and packaging

- Keep Firefox marked non-publishable with an explicit reason such as deployment
  being suspended, not an obsolete reason about unsigned ZIP generation.
- Ensure `package:release` generates no Firefox ZIP/XPI and does not require
  Firefox output solely for deployment.
- Prevent stale Firefox artifacts from being accidentally included in checksums
  or uploaded release assets.

### Step 5: Update regression tests

- Revise `scripts/e2e-release-packaging.test.mjs` to assert the new disabled
  deployment contract.
- Retain tests for Chromium artifact naming, checksums, release manifest
  generation, and version synchronization.
- Retain Firefox compatibility/build tests only as local/deprecation coverage if
  they still provide value; they must not be wired into automatic CI or release
  gates.

### Step 6: Update operator documentation

- Add a clear Firefox deprecation notice to README and the release playbook,
  including status, reason, effective date, owner, migration target, and whether
  removal is planned.
- Remove instructions presenting Firefox as an active automated or owner-managed
  deployment channel.
- Document that general CI is manually triggered and no longer validates Firefox
  automatically.
- Ensure no documentation instructs maintainers to configure AMO secrets for the
  normal release workflow while Firefox is deprecated.

### Step 7: Validate the complete change

- Run every command in the Validation Commands section.
- Inspect the release directory and generated release manifest to confirm no
  Firefox deployment artifact is present.
- Review the workflow diff for removed secret exposure and unchanged Chromium
  release behavior.
- Update the GitHub Issue with the implementation summary and open a PR linked
  to the issue for human review.

## Testing Strategy

### Unit and integration tests

- Release target metadata identifies Firefox as disabled/non-publishable.
- Release packaging emits only the Chromium-family ZIP, checksums, and release
  manifest.
- Generated release metadata does not list Firefox as an emitted artifact.
- Chromium release targets, shared payload mapping, and version checks remain
  unchanged.
- Firefox manifest generation and smoke/compatibility tests continue to pass if
  runtime support remains active.

### Edge Cases

- A stale `release/firefox-unlisted/` directory exists before packaging.
- AMO secrets are absent: the release must no longer fail solely for that reason.
- A manually generated Firefox XPI exists locally: it must not be picked up by
  automatic release upload or checksum generation.
- Release-candidate artifact upload must match production release artifact scope.
- Re-enabling deployment later must have an explicit, reviewable path rather than
  relying on undocumented workflow restoration.

## Acceptance Criteria

- The protected release workflow completes without AMO secrets when all
  Chromium-family release prerequisites are valid.
- Normal GitHub Releases contain no automated Firefox XPI or Firefox deployment
  asset.
- Release checksums and manifests contain only approved Chromium-family
  deployment artifacts.
- Firefox is explicitly marked deprecated in README and
  `docs/release-playbook.md`, with migration guidance and ownership.
- `.github/workflows/ci.yml` runs only on manual `workflow_dispatch` and no
  automatic workflow runs Firefox validation as a required gate.
- README and `docs/release-playbook.md` do not instruct maintainers to deploy
  Firefox as part of normal release.
- Existing Chrome, Edge, Brave, and Chromium release behavior remains intact.
- The implementation is delivered through a feature branch and PR linked to a
  GitHub Issue.

## Validation Commands

```bash
npm ci
npm run lint
npm run build
npm run test:e2e
npm run test:e2e:compiler
npm run release:check-version
npm run package:release
git diff --check
```

After packaging, inspect `release/` and the generated
`release/release-manifest-v<version>.json`; assert that no Firefox XPI or Firefox
deployment artifact is present and that the Chromium-family ZIP exists. If the
deprecated Firefox path is being retained temporarily, run
`npm run test:browser:firefox` manually as an optional smoke check.

## Notes

- Firefox support is deprecated rather than immediately deleted; the follow-up
  removal decision should verify active usage and ownership before deleting
  Firefox runtime/build code.
- No repository changes beyond this plan document have been implemented.
- Existing unrelated/untracked files in `specs/` must be preserved.
- If a removal date is later approved, create a follow-up migration/removal plan
  covering Firefox runtime compatibility, manifests, smoke tests, signing tools,
  dependencies, and remaining user-facing claims.
