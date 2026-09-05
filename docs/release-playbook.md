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
  - packages one shared Chromium-family release ZIP and target metadata
  - uploads the artifacts for review

## Manual Release Flow

- Review the uploaded artifacts and confirm the version bump is intentional.
- Use the existing tag/manual release workflow for final publication.
- Publish browser store listings and verify installed updates as required by the target browser.
- Firefox support and deployment are deprecated; it is not included in release artifacts or release gates.

### Firefox deprecation notice

**Status:** Deprecated as of 2026-09-05

**Replacement:** Chrome, Edge, Brave, or Chromium builds

**Removal date:** Advisory; Firefox runtime/build code remains temporarily while
existing users migrate and ownership is assessed.

Firefox is no longer a supported deployment target. Do not configure AMO
credentials for the normal release workflow, publish a Firefox package, or
expect a signed XPI in GitHub Releases. The existing Firefox build and signing
commands are transition tooling only and are not automated release steps.

If a maintainer needs a final compatibility check during migration, run
`npm run test:browser:firefox` manually. It is not a CI or release gate.

The future removal follow-up must verify active Firefox usage and ownership,
provide migration guidance, then remove the Firefox runtime/build paths, tests,
signing tools, and documentation together.

### General CI

The general CI workflow is manual-only (`workflow_dispatch`) during this
transition. It does not run automatically on pull requests and does not run the
deprecated Firefox smoke test. Run it manually when validating a branch.

### Deprecated Firefox signing credentials

No AMO credentials are required by the normal release workflow. If the
transition tooling is used manually, keep any credentials outside the repository
and never expose them in pull-request workflows, source, artifacts, or logs.

## Deprecated Firefox Verification Test Plan

Use this only for migration or eventual removal work. It does not qualify
Firefox for release.

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
9. `npm run package:release`

Passing these gates proves that:

- release packaging emits one Chromium-family ZIP and a release manifest that maps Chrome, Edge, Brave, and Chromium to it
- manifest/package metadata stay version-synchronized

### Manual Firefox runtime QA

Automated Firefox smoke does **not** prove that the extension compiles and runs
programs correctly inside Firefox. Before release, verify these behaviors in a
real Firefox desktop build:

1. Load the unpacked Firefox build and confirm the toolbar action opens the IDE.
2. Confirm Monaco renders and the default sample appears without blocking
   console/runtime errors.
3. Compile and run the default sample program.
4. Complete `docs/firefox-stdin-runtime-acceptance.md`: confirm Firefox 153+
   JSPI live stdin works without
   SharedArrayBuffer/COOP/COEP errors.
5. Open a local source file with Firefox's fallback picker and save changes.
6. Import a folder, compile a multi-file project, and confirm diagnostics appear
   in the expected file.
7. Write an output file with `std::ofstream` and confirm the documented Firefox
   persistence behavior matches reality.
8. Restart Firefox and verify session/workspace restore behavior matches the
   documented limitations.
9. Do not install or distribute a signed Firefox XPI; deployment is deprecated.

### Release decision

The deprecated Firefox migration check passes only when:

- every applicable automated gate above succeeds
- manual Firefox runtime QA succeeds
- no migration-blocking Firefox regressions are found in startup, compile/run,
  or file flows
- remaining Firefox limitations are already documented and match observed
  behavior

Do **not** present this validation as evidence that Firefox is release-supported.

## Validation

- `npm run lint`
- `npm run build`
- `npm run test:e2e`
- `npm run release:check-version`
- `npm run package:release`
