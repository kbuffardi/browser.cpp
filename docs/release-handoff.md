# Release Workflow Handoff

## Current state
- Issue `#33` is closed and the manifest-driven release workflow simplification is in `main`.
- The follow-up regression fix for `package-lock.json` root version sync is implemented on branch `fix/release-lockfile-root-version` and open in PR `#35`.
- The release validation failure reported by CI was caused by `package-lock.json packages[""].version` still being `0.1.0` while `manifest.json` and `package.json` were already `0.2.1`.

## What is done
- Synced `package-lock.json` root version to `0.2.1`.
- Verified:
  - `npm run version:check`
  - `npm run release:clean`
  - `npm run release:check-version`
- Updated the PR body to describe the regression and the verification status.

## What remains
- Wait for human review and merge of PR `#35`.
- If the workflow is still the desired end state, any further release-workflow adjustments should resume from issue `#33` and the existing release-playbook / PR history.

## Notes for the next session
- The full `npm run build` could not be completed in this sandbox because `npm ci` could not reach `registry.npmjs.org`, so `webpack` was unavailable locally.
- The important regression is already fixed in source control; the repo-level version checks now pass.
