# Feature: Multi-browser release deployment

## Feature Description
Create a repeatable release process for browser.cpp across Chrome, Edge, Brave, and Chromium using the repository's existing Manifest V3 build, preflight, smoke-test, and packaging foundations. The feature should define one maintainable release path from source checkout to browser-specific publication, while also documenting the human-owned account, submission, listing, and verification work required for each distribution channel.

## User Story
As a browser.cpp maintainer
I want a clear, repeatable release workflow for Chrome, Edge, Brave, and Chromium
So that I can ship validated extension updates without relying on ad hoc packaging, undocumented store steps, or browser-specific guesswork

## Problem Statement
The repository already contains important release building blocks, but they do not yet form a complete deployment system:

- `package.json` includes lint, build, E2E, clang preflight, and per-browser smoke-test scripts.
- `scripts/package-extension-release.js` currently emits ZIPs only for `chromium` and `edge`.
- `README.md` says the same build is used for Chrome Web Store, Brave, and Chromium-compatible distribution, but it does not define a full release workflow or ownership boundaries.
- `.github/workflows/ci.yml` only runs lint, build, and `test:e2e`; it does not verify release packaging or produce release artifacts.
- `manifest.json` and `package.json` both carry versions, but nothing enforces that they stay in sync.
- The current build output is not guaranteed to be clean or reproducible because webpack uses `clean: false`, `dist/clang` is populated out-of-band, and packaging uses source mtimes in the ZIP output.
- Chrome Web Store already exists as a live channel, but Edge Add-ons, Brave release handling, and Chromium distribution have not been formalized.

Without a codified release contract, maintainers can produce artifacts, but they cannot reliably repeat or audit the full deployment process across all supported Chromium-family targets.

## Solution Statement
Define a single-source release workflow around the existing `dist/` build and Chromium-family compatibility model:

1. Keep one canonical MV3 extension payload and package browser-labeled release artifacts from that same `dist/` output.
2. Add release automation that validates version sync, uses a clean build strategy, verifies required clang artifacts, packages all supported targets, and emits release metadata/checksums.
3. Add a manual/tag-driven GitHub Actions workflow that produces release artifacts and uploads them for operator review, while keeping browser-store publication manual in the first iteration.
4. Document a release playbook that clearly separates automated tasks from human-owned tasks.
5. Treat channels according to current platform reality:
   - **Chrome**: publish to the existing Chrome Web Store listing.
   - **Edge**: publish to a new Microsoft Edge Add-ons listing through Partner Center.
   - **Brave**: validate and support release through the Chrome Web Store listing; no separate Brave submission portal is assumed for normal MV3 distribution.
   - **Chromium**: distribute through GitHub Releases/self-hosted artifacts because there is no official Chromium extension store.

This keeps the plan grounded in the current repository structure, avoids premature store API automation, and still makes releases repeatable, reviewable, and maintainable.

## Relevant Files
Use these files to implement the feature:

- `README.md`
  - Already documents Chromium-family compatibility, release-blocking checks, browser smoke tests, and current packaging behavior; needs a higher-level release summary that points to the new runbook.
- `AGENTS.md`
  - Defines the repository's baseline validation commands that the implementation must continue to honor.
- `package.json`
  - Owns the current release/test scripts and should gain release-specific verification entry points if needed.
- `manifest.json`
  - The extension's store-facing metadata source; version alignment and minimum supported browser metadata should be reviewed here.
- `privacy.md`
  - Existing privacy policy is Chrome-specific and should be updated so it can be reused across Chrome/Edge/Brave/Chromium release documentation and store listings.
- `webpack.config.js`
  - Uses `clean: false`, which matters for clean-release planning and stale-file prevention.
- `.github/workflows/ci.yml`
  - Current CI coverage is limited to lint/build/E2E; it should be updated so release-specific validation is covered appropriately.
- `scripts/fetch-clang-wasm.js`
  - Defines the fetched compiler toolchain inputs and pinned upstream source currently used for release builds.
- `scripts/preflight-clang-artifacts.js`
  - Encodes the required clang payload that must exist before smoke tests and release packaging.
- `scripts/smoke-browser.mjs`
  - Provides the current Chrome/Edge/Brave/Chromium smoke harness and highlights browser-specific automation constraints, especially for Google Chrome.
- `scripts/package-extension-release.js`
  - Current release packager; needs to become the canonical multi-browser artifact generator.
- `src/ui/browser-capabilities.mjs`
  - Encodes the minimum Chromium compatibility assumption currently used by runtime/browser compatibility checks.
- `release/`
  - Existing artifact output directory; should continue to receive packaged release artifacts plus generated metadata/checksums.

### New Files
- `.github/workflows/release.yml`
  - Manual/tag-driven workflow to produce validated release artifacts and upload them for review.
- `docs/release-playbook.md`
  - Human/operator runbook covering prerequisites, automated commands, manual checks, browser-store submission steps, and rollback guidance.
- `scripts/check-release-version-sync.js`
  - Fast validator that fails when `package.json` and `manifest.json` versions diverge or when release metadata does not match the intended version/tag.
- `scripts/clean-release-workspace.js`
  - Canonical clean-build helper so release packaging starts from a known state instead of a potentially stale `dist/` tree.
- `scripts/e2e-release-packaging.test.mjs`
  - Node-based integration coverage for release packaging, artifact naming, metadata generation, and release-target behavior.
- `.nvmrc`
  - Pins the Node.js major/minor version expected for repeatable local and CI release builds.

## Implementation Plan
### Phase 1: Foundation
Define the release contract before changing scripts: supported channels, artifact naming, clean-build expectations, version source-of-truth rules, clang/toolchain provenance, and what remains human-owned in v1. This phase should also resolve the practical channel model: Chrome Web Store is the canonical public store for Chrome and Brave users, Edge gets its own Partner Center listing, and Chromium is treated as GitHub/manual distribution rather than a nonexistent public store.

### Phase 2: Core Implementation
Upgrade the repository's release automation around that contract. Add clean-build tooling, version-sync validation, packaging tests, reproducible artifact behavior, release metadata/checksums, and a `release.yml` workflow that can generate candidate artifacts from a branch or tag without directly publishing to stores.

### Phase 3: Integration
Integrate the workflow into human release operations through a dedicated runbook, README updates, privacy/listing text updates, and browser-specific manual checklists. Finish with a dry-run rehearsal that proves the repo can generate all release artifacts and that a human can follow the documented Chrome, Edge, Brave, and Chromium steps without ambiguity.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### Define the release channel contract and ownership model
- Document the canonical target matrix with, at minimum:
  - browser name
  - artifact filename
  - publication channel
  - automated validation gates
  - human-owned submission tasks
  - post-publish verification steps
- Make these channel rules explicit in the implementation:
  - **Chrome** uses the existing Chrome Web Store listing.
  - **Edge** uses a dedicated Microsoft Edge Add-ons listing.
  - **Brave** is supported through the Chrome Web Store listing plus Brave-specific validation; do not plan a separate Brave developer portal.
  - **Chromium** is distributed via GitHub Releases/self-hosted artifacts and install documentation, not a public Chromium store.
- Decide and document whether Chrome, Brave, and Chromium get separate browser-labeled ZIPs that intentionally contain identical payloads, or whether one shared payload is generated with browser-specific aliases. The plan should favor clarity for human operators over cleverness.
- Human prerequisite: confirm who owns the Chrome Web Store listing, who will create/verify the Edge Partner Center account, and whether GitHub Releases is the approved official Chromium distribution endpoint.

### Make release inputs deterministic and fail-fast
- Add `.nvmrc` so local and CI release builds use the same Node.js version family.
- Add `scripts/clean-release-workspace.js` to remove stale `dist/` and `release/` outputs before release builds while preserving the expected `fetch-clang -> build -> package` flow.
- Add `scripts/check-release-version-sync.js` to enforce:
  - `package.json.version === manifest.json.version`
  - release artifact names use the same version
  - release tags, if present, match the version string
- Decide the repository's version source of truth and encode it in the validator instead of relying on convention alone.
- Capture toolchain provenance in generated release metadata:
  - fetched clang source URL/version
  - generated artifact hashes
  - commit SHA
  - Node version

### Expand the release packaging contract
- Refactor `scripts/package-extension-release.js` so it becomes the single packaging entry point for all supported channels.
- Update the packager to:
  - generate browser-labeled ZIPs for Chrome, Edge, Brave, and Chromium
  - emit `SHA256SUMS.txt`
  - emit a machine-readable release manifest JSON describing artifact names, hashes, source commit, toolchain metadata, and target-channel notes
  - fail fast when `dist/manifest.json` is missing or release-version validation fails
- Normalize artifact creation enough for repeatable releases:
  - deterministic file ordering
  - normalized ZIP timestamps or another documented reproducibility strategy
  - explicit handling of identical Chrome/Brave/Chromium payloads
- Keep the implementation simple: reuse the current Node-based packager instead of introducing a large packaging dependency unless testing reveals a real gap.

### Add automated coverage for release packaging behavior
- Add `scripts/e2e-release-packaging.test.mjs`.
- Cover at least these behaviors:
  - package/manifest version mismatch fails the release path
  - packaging from a clean temp `dist/` tree produces the full target artifact set
  - generated metadata contains the expected target names, hashes, and version
  - Chrome/Brave/Chromium artifact handling matches the documented contract
  - stale files are not silently included after a clean release build
  - missing clang artifacts still fail through the preflight path before packaging
- Update `package.json` so the release-packaging test runs via `npm run test:e2e`.

### Add a release-specific GitHub Actions workflow
- Create `.github/workflows/release.yml`.
- Use `workflow_dispatch` and tag-based triggers so maintainers can produce release artifacts on demand and on official version tags.
- The workflow should:
  - check out the repository
  - set up the pinned Node version
  - install dependencies
  - clean prior build outputs
  - fetch clang artifacts
  - run `npm run lint`
  - run `npm run build`
  - run `npm run test:e2e`
  - run `npm run test:preflight-clang`
  - run release-version validation
  - run `npm run package:release`
  - upload ZIPs, checksums, and release manifest as workflow artifacts
- Keep store publication manual in v1; the workflow should prepare validated artifacts, not push directly to browser stores.

### Tighten existing CI around release-sensitive checks
- Update `.github/workflows/ci.yml` so lightweight release-sensitive checks run on normal CI without forcing full browser-store deployment:
  - keep lint/build/E2E
  - include the release-packaging test through `npm run test:e2e`
  - add the fast version-sync validator as a blocking check
- Decide explicitly whether the repository will automate `test:browser:*` in CI or keep them as required manual release gates in v1.
- If browser-smoke automation remains manual in v1, document that choice clearly in the runbook rather than leaving it implied.

### Document the operator runbook and release checklist
- Add `docs/release-playbook.md` as the canonical release runbook.
- Separate the runbook into:
  - prerequisites
  - automated commands
  - browser-specific human tasks
  - manual QA checklist
  - rollback / resubmission guidance
  - post-release verification
- Include the current browser manual checks already called out in `README.md`:
  - open local folder
  - create file
  - save / save as
  - compile multi-file project
  - run stdin-based program
  - write output file with `std::ofstream`
  - close and reopen browser, then restore workspace
- Call out the Google Chrome automation caveat from `scripts/smoke-browser.mjs`: hosted fallback is not the same as a full unpacked-extension smoke test when a Google Chrome binary ignores `--load-extension`.

### Update user-facing docs and store-facing metadata
- Update `README.md` so it stays concise and points maintainers to `docs/release-playbook.md` for the full release process.
- Update `privacy.md` so the privacy text is no longer Chrome-only and can be reused across Chrome Web Store, Edge Add-ons, Brave support notes, and Chromium distribution docs.
- Review `manifest.json` and `src/ui/browser-capabilities.mjs` together to decide whether the documented Chromium 105+ minimum should also be reflected in store-facing metadata such as `minimum_chrome_version`.

### Document Chrome Web Store human-owned release tasks
- Record these human tasks in the runbook:
  - verify access to the existing Chrome Web Store developer dashboard entry
  - verify the publisher account still satisfies required security prerequisites
  - upload the Chrome-labeled ZIP to the existing listing
  - update Store Listing, Privacy, Distribution, and Test Instructions fields when permissions, screenshots, copy, or reviewer guidance changed
  - decide whether to defer publish or auto-publish after review
  - monitor review status and address reviewer feedback
  - verify the public Chrome listing installs and updates correctly after publication
- Explicitly note that Chrome publication is also the primary public distribution path for Brave users.

### Document Microsoft Edge Add-ons human-owned release tasks
- Record these human tasks in the runbook:
  - create or verify the Microsoft Partner Center developer account
  - choose the correct individual vs organization ownership model
  - create the first Edge Add-ons listing if it does not yet exist
  - upload the Edge-labeled ZIP
  - complete availability, markets, properties, privacy, store listing assets, and certification testing notes
  - submit for review and respond to any reviewer feedback
  - verify the published listing installs and updates correctly in Edge
- Make the first-time account/listing setup a clearly marked blocking prerequisite, not an implicit follow-up task.

### Document Brave human-owned release tasks
- Record these human tasks in the runbook:
  - run the Brave smoke test against the release candidate
  - perform the manual folder/file/workspace QA checklist in Brave
  - install the published Chrome Web Store listing in Brave and verify the user-facing install flow
  - record any Brave-specific reviewer/user guidance if behavior differs from Chrome
- State plainly that there is no separate normal Brave extension submission portal in scope for this MV3 release workflow.

### Document Chromium human-owned distribution tasks
- Record these human tasks in the runbook:
  - create a Git tag and GitHub Release for the version
  - attach the Chromium-labeled ZIP, `SHA256SUMS.txt`, and release manifest JSON
  - publish installation instructions for Chromium users, including the expected manual/developer-mode or managed-distribution path
  - verify the packaged artifact can be loaded in Chromium and passes the manual QA checklist
- Be explicit that this is an artifact distribution channel, not a public browser-store listing with automatic updates.

### Rehearse one full release dry run before calling the feature complete
- Run the full automated release path from a clean checkout.
- Produce all intended artifacts through the new workflow and local commands.
- Execute per-browser smoke tests for Chrome, Edge, Brave, and Chromium.
- Perform the documented manual QA checklist in each browser.
- Walk through the Chrome and Edge dashboard steps in draft form without publishing if necessary.
- Create or simulate the Chromium GitHub Release artifact upload flow.
- Resolve documentation gaps discovered during the rehearsal before declaring the release system complete.

### Run the full validation commands
- Execute every command in the Validation Commands section and fix all regressions before final sign-off.

## Testing Strategy
### Unit Tests
- Add Node-based tests for release-target metadata and artifact naming.
- Test the version-sync validator against matching and mismatched `package.json` / `manifest.json` versions.
- Test clean-build behavior so stale files do not survive into release packaging.
- Test release-manifest and checksum generation for deterministic structure and expected fields.
- Test the package builder against identical-payload channels so Chrome/Brave/Chromium handling stays intentional and documented.

### Edge Cases
- `package.json` and `manifest.json` versions diverge.
- A version tag does not match the extension version.
- `dist/` contains stale files from a previous build because webpack does not clean it automatically.
- `dist/clang/` is missing one or more required artifacts.
- Chrome, Brave, and Chromium artifacts intentionally share payload bytes but drift in naming or metadata.
- Google Chrome ignores `--load-extension`, causing the smoke harness to fall back to hosted mode instead of validating the unpacked extension page.
- Edge account verification or first-time listing setup delays the first release.
- The privacy policy/support metadata used in store listings drifts from the repo's checked-in documentation.
- Chromium users expect a store-like update channel even though the repo only supports GitHub/manual distribution in v1.
- The documented Chromium 105+ minimum remains in README/runtime checks but is not reflected in store-facing metadata.

## Acceptance Criteria
- The repository has a documented release workflow that explicitly covers Chrome, Edge, Brave, and Chromium.
- Release automation starts from a clean workspace, validates version alignment, fetches required clang artifacts, packages all supported targets, and emits release metadata/checksums.
- `scripts/package-extension-release.js` (or a tightly related release wrapper) is the canonical source for producing multi-browser release artifacts.
- A manual/tag-driven GitHub Actions workflow can generate release artifacts and upload them without directly publishing to stores.
- The repo documents which steps are automated and which remain human-owned.
- The Chrome Web Store workflow is documented against the existing listing.
- The Edge Add-ons workflow includes first-time Partner Center/listing setup tasks.
- The Brave workflow is documented as Chrome Web Store-backed distribution plus Brave-specific validation, not as a separate store submission flow.
- The Chromium workflow is documented as GitHub/manual distribution, not as a nonexistent official Chromium store.
- README, privacy/listing documentation, and validation commands all reflect the finalized release contract.
- `npm run lint`, `npm run build`, `npm run test:e2e`, `npm run test:preflight-clang`, `npm run package:release`, and per-browser smoke tests all succeed under the implemented workflow.

## Validation Commands
Execute every command to validate the feature works correctly with zero regressions.

```bash
npm run lint
npm run build
node --experimental-detect-module --test scripts/e2e-release-packaging.test.mjs
npm run test:e2e
npm run test:preflight-clang
node scripts/check-release-version-sync.js
npm run package:release
npm run test:browser:chrome
npm run test:browser:edge
npm run test:browser:brave
npm run test:browser:chromium
```

## Notes
- This plan intentionally stops short of store API automation. Artifact generation should become repeatable first; direct Chrome/Edge publishing can be a follow-on feature once credentials, secrets handling, and store-review edge cases are better understood.
- Brave support should be treated as Chrome Web Store compatibility plus Brave-specific validation unless product requirements later justify a separate Brave-specific distribution path.
- Chromium distribution should be described honestly as GitHub/manual/managed deployment in v1, not as equivalent to a public browser-store channel.
- Because `scripts/smoke-browser.mjs` can fall back when regular Google Chrome blocks `--load-extension`, the runbook should recommend Chrome for Testing, Chromium, Edge, or Brave when maintainers need a true unpacked-extension smoke test.
- First-time Edge Add-ons setup is likely the largest human dependency in this plan; it should be handled early so it does not block final release execution.
