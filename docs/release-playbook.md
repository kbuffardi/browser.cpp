# Release Playbook

## Source of Truth

- `manifest.json` is the canonical release version source.
- `package.json.version` must be updated from `manifest.json.version` before release validation passes.

## Automated PR Flow

- Same-repo pull requests that change `manifest.json.version` trigger the release-candidate workflow.
- Forked pull requests are skipped.
- The workflow:
  - detects the version bump
  - runs version sync validation
  - cleans the release workspace
  - fetches the Clang WASM toolchain
  - runs lint, build, and E2E checks
  - runs Firefox packaging smoke checks
  - packages browser-labeled release artifacts
  - uploads the artifacts for review

## Manual Release Flow

- Review the uploaded artifacts and confirm the version bump is intentional.
- For Firefox, confirm the unsigned ZIP and the AMO/manual-submission metadata are present before owner handoff.
- Use the existing tag/manual release workflow for final publication.
- Publish browser store listings and verify installed updates as required by the target browser.
- The protected release workflow signs the Firefox unlisted XPI with AMO credentials and uploads it with the other release assets.

### Firefox unlisted-signing credentials

The protected release workflow requires two GitHub Actions secrets before it
starts the release build:

- `AMO_JWT_ISSUER`
- `AMO_JWT_SECRET`

Create the AMO API credential pair in Mozilla Add-ons, then store the values as
secrets in the protected `copilot` GitHub Environment with these exact names.
Keep them unavailable to pull-request workflows, do not put them in source,
local release artifacts, or logs, and grant only the permissions required for
Firefox signing. The workflow checks only that each value is present and
non-blank; it never prints either value.

Rotate both secrets through Mozilla and GitHub when the credential expires or
is suspected to be exposed. After updating them, use
`workflow_dispatch` with `force=true` to rerun the protected release. The
workflow must fail before dependency installation when either secret is absent;
do not bypass signing or publish an unsigned XPI. If the preflight passes but
signing fails, inspect the protected workflow's AMO/web-ext error, correct the
credential or AMO configuration, and rerun the forced release.

## Firefox Verification Test Plan

Use this plan before declaring Firefox support release-ready or bumping the
project version for a Firefox-supporting release.

### Automated gates

Run these commands from a clean checkout in order:

1. `npm run release:clean`
2. `npm run fetch-clang`
3. `npm run lint`
4. `npm run build`
5. `npm run test:e2e`
6. `npm run test:preflight-clang`
7. `npm run version:check`
8. `npm run release:check-version`
9. `npm run test:browser:firefox`
10. `npm run package:release`

Passing these gates proves that:

- Firefox-specific manifest generation succeeds
- the Firefox extension package passes `web-ext` lint/build smoke
- release packaging emits the Firefox artifact and release manifest
- manifest/package metadata stay version-synchronized

### Manual Firefox runtime QA

Automated Firefox smoke does **not** prove that the extension compiles and runs
programs correctly inside Firefox. Before release, verify these behaviors in a
real Firefox desktop build:

1. Load the unpacked Firefox build and confirm the toolbar action opens the IDE.
2. Confirm Monaco renders and the default sample appears without blocking
   console/runtime errors.
3. Compile and run the default sample program.
4. Run a program that reads stdin and confirm terminal interaction works.
5. Open a local source file with Firefox's fallback picker and save changes.
6. Import a folder, compile a multi-file project, and confirm diagnostics appear
   in the expected file.
7. Write an output file with `std::ofstream` and confirm the documented Firefox
   persistence behavior matches reality.
8. Restart Firefox and verify session/workspace restore behavior matches the
   documented limitations.
9. Install the packaged Firefox ZIP/XPI and repeat the compile/run sanity check.

### Release decision

The Firefox release gate passes only when:

- every automated gate above succeeds
- manual Firefox runtime QA succeeds
- no new Firefox-only regressions are found in startup, compile/run, file
  flows, or packaging
- remaining Firefox limitations are already documented and match observed
  behavior

Do **not** cut the version bump for a Firefox-supporting release if only the
packaging smoke passes. Runtime validation in Firefox is still required.

## Validation

- `npm run lint`
- `npm run build`
- `npm run test:e2e`
- `npm run test:browser:firefox`
- `npm run release:check-version`
- `npm run package:release`
