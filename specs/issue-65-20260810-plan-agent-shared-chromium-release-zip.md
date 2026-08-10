# Feature: Release one shared Chromium-family ZIP artifact

## Feature Description
Update the release packaging contract so Chrome, Edge, Brave, and Chromium are represented by one canonical Chromium-family ZIP artifact instead of four byte-identical browser-labeled ZIP files. The release manifest must still list every Chromium-family target and make the compatibility mapping explicit, while Firefox remains on its separate Firefox build, signing, and XPI release path. The feature also bumps the extension release to v0.4.4 so the next release exercises the new artifact contract.

## User Story
As a browser.cpp release maintainer
I want one canonical Chromium-family ZIP per release
So that GitHub release assets avoid duplicated payloads while still documenting Chrome, Edge, Brave, and Chromium compatibility

## Problem Statement
The current packager caches the `chromium-mv3` payload once, but writes it to four different ZIP filenames: Chrome, Edge, Brave, and Chromium. Those files are byte-identical and around 31 MB each, so every release duplicates storage, upload time, checksum lines, and review surface without providing distinct browser behavior.

The current metadata already says Edge, Brave, and Chromium share Chrome's payload, but the emitted artifact set contradicts the desired operating model by publishing four physical ZIPs. Firefox must not be folded into this change because it uses `dist-firefox/`, Firefox-specific manifest/background behavior, `web-ext` smoke validation, and protected AMO signing to produce a signed XPI.

## Solution Statement
Refactor release packaging around a single canonical Chromium-family artifact, for example `browser-cpp-chromium-family-v0.4.4.zip`, generated from `dist/`. Keep Chrome, Edge, Brave, and Chromium as release targets in `release-manifest-v0.4.4.json`, but map each target to the same artifact filename, checksum, payload group, and compatibility notes. Update checksum generation, tests, release workflows, and documentation so only one Chromium-family ZIP is produced and uploaded. Preserve Firefox behavior unchanged: no Firefox ZIP is introduced, `test:browser:firefox` still validates Firefox packaging, and the protected release workflow still signs and uploads the Firefox unlisted XPI.

## Relevant Files
Use these files to implement the feature:

- `manifest.json`
  - Canonical version source; bump from `0.4.2` to `0.4.4`.
- `package.json`
  - Contains release, version sync, E2E, browser smoke, and Firefox signing scripts; package version must be synced to v0.4.4 and validation commands must remain accurate.
- `package-lock.json`
  - Root package version fields must be synced to v0.4.4 by `npm run version:sync`.
- `scripts/release-targets.js`
  - Defines browser target metadata, artifact naming, payload grouping, publishability, and package strategy. This is the main place to encode one canonical Chromium-family artifact mapped to Chrome, Edge, Brave, and Chromium.
- `scripts/package-extension-release.js`
  - Generates release ZIPs, checksums, and release manifest metadata. It must stop writing duplicate Chromium-family ZIPs while still recording all target mappings.
- `scripts/e2e-release-packaging.test.mjs`
  - Existing packaging regression suite; extend it to assert the single Chromium ZIP artifact set, target-to-artifact mapping, checksums, and Firefox non-regression behavior.
- `scripts/check-release-version-sync.js`
  - Validates manifest/package/package-lock/dist version sync. It should continue to pass after the v0.4.4 bump and should not need behavioral changes unless tests expose an artifact-version assumption.
- `scripts/sync-version-from-manifest.js`
  - Used to sync `package.json` and `package-lock.json` from `manifest.json` after the v0.4.4 bump.
- `scripts/firefox-webext.js`
  - Owns Firefox build/signing metadata updates. Review only to make sure release-manifest changes remain compatible with signed XPI metadata updates.
- `scripts/sign-firefox-unlisted.mjs`
  - Protected release signing path for Firefox. Must continue to update release metadata and upload a signed XPI without depending on a Firefox ZIP.
- `scripts/smoke-firefox.mjs`
  - Existing Firefox packaging smoke command; must remain part of release validation.
- `.github/workflows/release.yml`
  - Protected release workflow uploads every file under `release/`; ensure the new artifact set uploads one Chromium-family ZIP plus checksums, manifest, and signed Firefox XPI.
- `.github/workflows/release-on-version-change.yml`
  - Release-candidate workflow uploads `release/*`; ensure candidate artifacts reflect the new single-ZIP contract.
- `.github/workflows/ci.yml`
  - CI should continue running version sync, lint, build, release checks, E2E, and Firefox packaging smoke.
- `README.md`
  - Release packages section currently lists four Chromium ZIP files; update to document the canonical Chromium-family ZIP and per-browser mapping.
- `docs/release-playbook.md`
  - Operator runbook currently says packaging emits browser-labeled release artifacts; update release-candidate and manual release instructions for one Chromium-family ZIP.

### New Files
No new implementation files are required. Use the existing release metadata and E2E test files unless implementation discovers a strong need for a tiny helper extraction.

## Implementation Plan
### Phase 1: Foundation
Lock the artifact contract for issue #65: `manifest.json` is bumped to `0.4.4`, `dist/` produces one canonical Chromium-family ZIP, Chrome/Edge/Brave/Chromium all map to that ZIP in release metadata, and Firefox remains a separate signed-XPI flow. Decide the exact canonical filename once and use it everywhere. Recommended: `browser-cpp-chromium-family-v<version>.zip` because it names the payload family rather than one store channel.

### Phase 2: Core Implementation
Refactor `scripts/release-targets.js` and `scripts/package-extension-release.js` so artifact identity is separate from target identity. The packager should build each payload group once, write one artifact for `chromium-mv3`, and attach all Chromium-family targets to that artifact in the release manifest. Checksums should contain one line for the canonical Chromium-family ZIP, not four duplicate lines.

### Phase 3: Integration
Update release tests, workflows, README, and release playbook to match the new artifact contract. Bump the project to v0.4.4, sync package metadata, and run the full release validation suite. Verify that Firefox packaging smoke and protected signing assumptions remain unchanged.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. Confirm the issue and branch context
- Use GitHub issue `#65`: `Release one shared Chromium-family ZIP artifact`.
- Create an implementation branch from `main`, for example `feature/65-shared-chromium-release-zip`.
- Preserve existing untracked spec files; do not edit or delete unrelated files in `specs/`.
- Keep this task scoped to release packaging, metadata, docs, tests, workflows, and the v0.4.4 version bump.

### 2. Define the canonical artifact naming contract
- Choose one canonical Chromium-family filename. Recommended: `browser-cpp-chromium-family-v<version>.zip`.
- Record that this artifact is generated from `dist/` and is valid for Chrome, Edge, Brave, and Chromium.
- Record that Chrome Web Store, Microsoft Edge Add-ons, Brave validation, and Chromium/GitHub distribution all consume the same ZIP unless a future issue introduces browser-specific payload divergence.
- Explicitly preserve Firefox as separate from this artifact contract.

### 3. Update release target metadata
- In `scripts/release-targets.js`, separate target keys from artifact identity.
- Add metadata that lets every Chromium-family target resolve to the canonical Chromium-family artifact, including:
  - `artifactKey` such as `chromium-family`
  - `artifactFileName` or equivalent derived filename
  - `payloadGroup: 'chromium-mv3'`
  - target list or compatibility list for Chrome, Edge, Brave, and Chromium
- Keep Firefox target metadata present, distinct, and not publishable as a ZIP.
- Preserve Firefox signing metadata: listed publication remains manual-owner submission and unlisted signing remains required release artifact.

### 4. Refactor release artifact generation
- In `scripts/package-extension-release.js`, change artifact creation from "one ZIP per publishable target" to "one ZIP per publishable artifact identity".
- Generate the `chromium-mv3` ZIP buffer once and write it once to the canonical Chromium-family filename.
- Keep deterministic ZIP behavior:
  - sorted file traversal
  - normalized ZIP timestamp
  - stable compression behavior
- Remove any stale browser-labeled Chromium ZIP artifacts from `release/` before or during packaging so old outputs do not survive.
- Keep the existing stale Firefox ZIP removal behavior and do not introduce a Firefox ZIP.

### 5. Update release manifest structure
- Ensure `release-manifest-v<version>.json` includes a physical `artifacts` list with exactly one Chromium-family ZIP entry.
- Ensure the manifest includes target mappings for Chrome, Edge, Brave, and Chromium that point to that artifact.
- Include enough metadata for humans and workflows to understand the mapping:
  - target key and label
  - channel
  - package strategy, such as `shared-artifact:chromium-family`
  - payload group
  - canonical artifact filename
  - artifact SHA-256
  - source directory
  - compatibility notes
- Keep Firefox in `targets` with `fileName: null` or signed-XPI-specific fields, and do not include Firefox in the Chromium ZIP artifact list.
- Ensure `scripts/firefox-webext.js` can still update Firefox signing fields in the manifest after XPI signing.

### 6. Update checksum generation
- Change `SHA256SUMS-v<version>.txt` so it contains one Chromium-family ZIP checksum line, not four duplicate Chromium-family lines.
- Ensure signed Firefox XPI checksum behavior remains unchanged if it is added by the signing path or release workflow.
- Add test coverage that checksum line count matches physical ZIP outputs instead of target count.

### 7. Bump the release version to v0.4.4
- Update `manifest.json.version` to `0.4.4`.
- Run `npm run version:sync` so `package.json` and `package-lock.json` match the manifest version.
- Run `npm run version:check` after syncing.
- Do not manually edit generated `dist/` manifests; let `npm run build` regenerate them.

### 8. Extend release packaging tests
- Update `scripts/e2e-release-packaging.test.mjs`.
- Assert packaging creates exactly one physical Chromium-family ZIP.
- Assert no `browser-cpp-chrome-v<version>.zip`, `browser-cpp-edge-v<version>.zip`, `browser-cpp-brave-v<version>.zip`, or `browser-cpp-chromium-v<version>.zip` files are created for the new contract.
- Assert the release manifest maps Chrome, Edge, Brave, and Chromium to the canonical Chromium-family ZIP.
- Assert all Chromium-family target mappings share the same SHA-256 and payload group.
- Assert `SHA256SUMS-v<version>.txt` has one Chromium-family ZIP line.
- Assert Firefox remains present in target metadata but absent from ZIP artifacts.
- Preserve existing tests for version mismatch failures, stale Firefox ZIP cleanup, target metadata, and release workflow nested asset upload.

### 9. Update release workflows for the new artifact contract
- Review `.github/workflows/release.yml`; it currently uploads all files under `release/`, so it should not need hard-coded browser filename changes.
- If any workflow summary, artifact naming, or validation step assumes browser-labeled ZIPs, update it to use the canonical Chromium-family ZIP wording.
- Review `.github/workflows/release-on-version-change.yml`; it uploads `release/*`, so the candidate artifact bundle should naturally contain one Chromium-family ZIP.
- Do not change Firefox signing order or protected AMO credential validation.
- Confirm release upload still includes nested `release/firefox-unlisted/*.xpi` files after protected signing.

### 10. Update release documentation
- In `README.md`, replace the four Chromium ZIP bullet points with one canonical Chromium-family ZIP bullet.
- Document that the release manifest maps Chrome, Edge, Brave, and Chromium to that single ZIP.
- Update Chrome, Edge, Brave, and Chromium human-owned deployment instructions to reference the same canonical ZIP.
- In `docs/release-playbook.md`, update release-candidate wording from "browser-labeled release artifacts" to "one Chromium-family ZIP plus target metadata".
- Keep all Firefox documentation and signing instructions intact except where wording needs to distinguish Firefox from the Chromium-family ZIP.

### 11. Rehearse release packaging locally
- Run a clean local release package path after the version bump.
- Inspect `release/` and confirm it contains:
  - one canonical Chromium-family ZIP
  - `SHA256SUMS-v0.4.4.txt`
  - `release-manifest-v0.4.4.json`
  - no browser-labeled duplicate Chromium-family ZIP files
  - no Firefox ZIP
- Confirm the Firefox signed XPI is still expected only from the protected signing step, not local Chromium packaging.

### 12. Run the validation commands
- Execute every command in the Validation Commands section.
- Fix any regression before opening the PR.
- Open the PR with `Closes #65` in the body.

## Testing Strategy
### Unit Tests
- Extend the existing Node E2E release packaging suite rather than adding a new test file.
- Test release target metadata resolution from target key to canonical artifact identity.
- Test physical artifact generation count and filenames.
- Test release manifest target-to-artifact mappings.
- Test checksum output count and filenames.
- Test stale duplicate Chromium ZIP cleanup if implementation adds cleanup logic for old browser-labeled files.
- Keep Firefox credential and signing metadata tests passing.

### Edge Cases
- A stale `release/browser-cpp-chrome-v0.4.3.zip` exists before packaging.
- `release/` contains stale Edge/Brave/Chromium ZIPs from an older version.
- A target maps to the Chromium payload group but lacks the canonical artifact key.
- The release manifest lists a Chromium-family target but does not include the canonical artifact.
- Checksums contain duplicate lines for one identical payload.
- Firefox target metadata is accidentally made publishable as a ZIP.
- Firefox signing tries to update release manifest fields after the artifact schema changes.
- Protected release uploads nested Firefox XPI files alongside the single root Chromium-family ZIP.
- Store operators need Chrome, Edge, Brave, or Chromium instructions and must be able to identify the correct shared ZIP.

## Acceptance Criteria
- GitHub issue `#65` is referenced by the implementation branch, spec, commits, and PR.
- The project version is bumped to `0.4.4` in `manifest.json`, `package.json`, and root `package-lock.json` fields.
- `npm run package:release` produces exactly one Chromium-family ZIP artifact.
- No duplicate Chrome, Edge, Brave, or Chromium ZIP files are produced.
- `release-manifest-v0.4.4.json` records Chrome, Edge, Brave, and Chromium as targets that share the canonical Chromium-family ZIP.
- `SHA256SUMS-v0.4.4.txt` records the canonical Chromium-family ZIP once.
- Firefox ZIP generation is not introduced.
- Firefox packaging smoke remains part of CI/release validation.
- Protected Firefox unlisted XPI signing remains unchanged and continues to update release metadata.
- README and release playbook clearly tell maintainers which ZIP to upload/use for Chrome, Edge, Brave, and Chromium.
- Existing lint, build, version, E2E, release packaging, and Firefox smoke validations pass.

## Validation Commands
Execute every command to validate the feature works correctly with zero regressions.

```bash
npm ci
npm run version:sync
npm run version:check
npm run release:clean
npm run fetch-clang
npm run lint
npm run build
npm run release:check-version
npm run test:e2e
npm run test:browser:firefox
npm run package:release
find release -maxdepth 2 -type f -print
```

After packaging, manually verify the artifact set:

```bash
ls release/*.zip
node -e "const fs=require('fs'); const v=require('./manifest.json').version; const m=JSON.parse(fs.readFileSync(`release/release-manifest-v${v}.json`, 'utf8')); console.log(m.artifacts); console.log(m.targets);"
```

Expected local release artifact result:

- one Chromium-family ZIP under `release/`
- one checksum file
- one release manifest JSON file
- zero Firefox ZIP files
- Chrome, Edge, Brave, and Chromium target entries all reference the same Chromium-family ZIP

GitHub-side validation after merge and protected release completion:

```bash
VERSION=$(node -p "require('./manifest.json').version")
gh release view "v${VERSION}" --json assets
```

Confirm the GitHub Release includes the single Chromium-family ZIP, checksum file, release manifest, and protected Firefox signed XPI artifact.

## Notes
- This plan intentionally changes artifact identity, not browser compatibility. Chrome, Edge, Brave, and Chromium remain supported Chromium-family targets.
- This plan intentionally does not change Firefox release architecture. Firefox remains a separate browser family with separate build validation and signed XPI distribution.
- If a browser store later requires a browser-specific ZIP, add that as a new issue and mark only that target as distinct again.
