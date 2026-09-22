# Implementation Plan: Issue #102 — `g++` wildcard expansion

## Overview

Make `g++` expand `*`, `?`, and `[...]` in every non-option argument against
the currently opened workspace. Matching is path-aware and non-recursive;
unmatched patterns remain literal so the compiler retains its normal diagnostic.
The change applies to `g++` only—other terminal commands, including `clang++`,
are out of scope for this issue.

## Architecture decisions

- Put the matching logic in `src/ui/build-request.mjs`, the existing pure module
  for terminal compile-request helpers. This keeps it independent of xterm and
  directly testable under Node.
- Invoke the helper only from `cmdGxx` in `src/ui/terminal.js`, after existing
  option parsing and before source paths are sent to the compiler. Pass the
  command identity into the handler (or split the handlers), so the shared
  `clang++` path does not expand patterns.
- Match only indexed workspace files. `*` and `?` do not cross `/`, so there is
  no implicit recursive `**` behaviour.
- Support positive (`[ab]`, `[a-z]`) and negated (`[!ab]`, `[^a-z]`) bracket
  classes, without allowing a bracket expression to match `/`.
- Sort matches for each pattern to make compiler requests reproducible; preserve
  unmatched patterns literally.

## Task 1: Add pure glob expansion helpers

**Description:** Add exported helpers in `src/ui/build-request.mjs` to identify
glob syntax, translate a single path pattern to a slash-aware regular expression,
and expand source arguments using workspace-relative file paths and the current
working directory.

**Acceptance criteria:**

- [ ] Supports `*`, `?`, positive bracket classes/ranges such as `[ab]` and
  `[a-z]`, and negated classes such as `[!ab]` and `[^a-z]`.
- [ ] `src/*.cpp` matches direct files in `src`, not `src/lib/main.cpp`.
- [ ] Invalid or unterminated bracket syntax is treated as literal text.
- [ ] A pattern with no matches is returned unchanged.
- [ ] Matches for an individual pattern are deterministic.

**Verification:** Add and run pure Node tests for the helper.

**Dependencies:** None.

**Files likely touched:**

- `src/ui/build-request.mjs`
- `scripts/e2e-multifile-build.test.mjs`

**Estimated scope:** Small (2 files).

## Task 2: Wire expansion into `g++` compilation

**Description:** Distinguish `g++` from the shared `clang++` dispatch, then
expand only `parseGxxArgs(...).sourcePaths` for `g++` against the terminal's
current workspace file index. Retain existing compile-request, output-name,
flag, and no-source editor-buffer behaviour.

**Acceptance criteria:**

- [ ] `g++ *.cpp` sends the matching root files to the compile callback.
- [ ] `cd src` followed by `g++ *.cpp` sends `src/...` paths.
- [ ] `g++ src/*.cpp -o app -Wall` preserves its output name and flags.
- [ ] `g++ missing*.cpp` sends the literal unmatched argument.
- [ ] `clang++ *.cpp` sends a literal `*.cpp` argument.
- [ ] Commands other than `g++` retain their existing literal argument behaviour.

**Verification:** Add terminal-harness tests that assert compile callback payloads.

**Dependencies:** Task 1.

**Files likely touched:**

- `src/ui/terminal.js`
- `scripts/e2e-terminal-gpp-glob.test.mjs`
- `package.json` (register the focused test in `test:e2e`)

**Estimated scope:** Medium (2–3 files).

## Task 3: Regression coverage and validation

**Description:** Cover literal inputs, each wildcard form, paths, option
positions, current-directory resolution, non-recursive matching, deterministic
ordering, and unmatched-pattern preservation. Run focused tests first, then all
repository checks.

**Acceptance criteria:**

- [ ] Existing literal multi-file compilation behaviour remains unchanged.
- [ ] `echo`, `cat`, `touch`, and `clang++` do not receive wildcard expansion.
- [ ] Lint, production build, and the full E2E suite pass.

**Verification:**

- [ ] `node --experimental-detect-module --test scripts/e2e-multifile-build.test.mjs`
- [ ] `node --experimental-detect-module --test scripts/e2e-terminal-gpp-glob.test.mjs`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm run test:e2e`

**Dependencies:** Tasks 1–2.

**Files likely touched:**

- `scripts/e2e-multifile-build.test.mjs`
- `scripts/e2e-terminal-gpp-glob.test.mjs`
- `package.json` (if needed)

**Estimated scope:** Small (2–3 files).

## Checkpoint: Before implementation

- [ ] The Issue #102 acceptance criteria and this plan agree.
- [ ] A human has reviewed and approved this plan.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A glob accidentally spans directories | Translate `*`, `?`, and bracket expressions to exclude `/`; test nested files. |
| Regex metacharacters widen a match | Escape all non-glob literals and test filenames containing regex-special characters. |
| Option parsing changes | Reuse `parseGxxArgs`; expand only its non-option source paths. |
| Scope leaks to other commands | Keep the invocation exclusively inside `cmdGxx`. |

## Out of scope

- Recursive globbing (`**`).
- Expansion for terminal commands other than `g++`.
- Shell quoting/escaping semantics beyond the terminal's existing tokenizer.
