# Issue #88: Progressive workspace scanning

## Objective

Prevent deep directory trees from overflowing the JavaScript call stack while
making a newly selected workspace visibly load one directory depth at a time.

## Decision

- Traverse `FileSystemDirectoryHandle` trees iteratively, breadth-first.
- Publish a preview after each completed depth, starting with the root.
- Start each new-workspace preview with every directory collapsed.
- Permit directory expand/collapse while scanning, but keep file actions and
  workspace mutations unavailable until the final workspace is committed.
- Show a right-aligned spinner on every visible directory whose subtree still
  contains queued work. This includes queued directories themselves and their
  indexed ancestors, so an expanded path exposes progress at each visible level.
- Show the preview immediately; do not delay it behind a duration threshold.

## Public callback contract

`openFolderFromHandle` and `openFolder` accept an `onScanProgress` callback.
Each callback receives a preview workspace, the completed depth, and the paths
whose visible directory rows should show a spinner. The final return value and
workspace-index commit remain unchanged.

## Verification

- A fake workspace deeper than the JavaScript call-stack limit scans correctly.
- Depth-zero progress exposes root entries immediately.
- Progress payloads and Explorer spinners correctly track unresolved subtrees.
- The preview does not change compile, terminal, persistence, or open-tab state
  before the complete workspace scan succeeds.
- `npm run lint`, `npm run build`, and `npm run test:e2e` pass.
