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
  - packages browser-labeled release artifacts
  - uploads the artifacts for review

## Manual Release Flow

- Review the uploaded artifacts and confirm the version bump is intentional.
- Use the existing tag/manual release workflow for final publication.
- Publish browser store listings and verify installed updates as required by the target browser.

## Validation

- `npm run lint`
- `npm run build`
- `npm run test:e2e`
- `npm run release:check-version`
- `npm run package:release`
