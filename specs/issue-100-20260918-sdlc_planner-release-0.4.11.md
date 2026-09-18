# Release version 0.4.11

## Goal

Publish a reviewable release-candidate change that advances browser.cpp from
`0.4.10` to `0.4.11`.

## Plan

1. Change the canonical version in `manifest.json` to `0.4.11`.
2. Synchronize `package.json` and the root package metadata in
   `package-lock.json` from the manifest.
3. Verify version synchronization, linting, the E2E suite, and the production
   build before submitting the pull request.

## Scope

Only release-version metadata and this planning record are changed. Generated
build outputs and release artifacts are intentionally excluded.
