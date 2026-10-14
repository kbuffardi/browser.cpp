# Feature: Issue #113 Terminal Selection Rendering Without Light-Theme Black Strip

## Feature Description

Fix the terminal selection regression in Issue #113 so xterm selections render with the exact computed Monaco selection colors for all five visual themes, inactive selections remain visible after focus leaves the terminal, selected content survives live theme changes, and Light / High Contrast Light never leave a black strip or stale dark paint in blank terminal cells.

This update explicitly resolves the latest review gaps. The implementation must not assume the existing private xterm 6 call is causal. It must prove or disprove causality with controlled browser evidence, then choose the smallest renderer-safe fix that preserves the visible-selection requirements already accepted for #113.

## User Story

As a browser.cpp user
I want terminal text selection to look and behave like editor selection in every theme
So that I can reliably select terminal output without invisible selection, stale paint, or black artifacts in light terminals.

## Problem Statement

The production code currently calls xterm 6 private internals through `term._core._renderService.handleSelectionChanged(...)` from `onSelectionChange`, terminal `mouseup`, and theme changes. After the visible-selection follow-up, Light and High Contrast Light terminals can show a black strip in otherwise blank terminal space.

The bug is visual and renderer/timing-sensitive. Existing assertions that inspect only xterm logical selection state, theme option values, or selection overlay geometry are insufficient. The next implementation must establish a deterministic reproduction, compare the private repaint path against xterm's native path under identical conditions, inspect CSS/parent/canvas backgrounds, and add pixel-level checks on cell-aligned blank terminal cells.

## Solution Statement

Create a deterministic Chrome smoke regression that reproduces real `help` output selection and samples both selected cells and known blank cells inside the xterm screen. Use that test to produce RED on current behavior. Add controlled A/B instrumentation in the same browser, renderer, viewport, DPR, zoom, terminal geometry, font readiness, scroll offset, and timing to determine whether the private render-service call causes, contributes to, or merely exposes the black strip.

Then replace or guard the repaint mechanism according to the evidence:

- Prefer xterm public behavior first: native queued selection repaint after normal mouse selection, `term.options.theme` update, and a public `term.refresh(0, term.rows - 1)` or equivalent documented/public repaint if needed.
- Allow CSS/background fixes only if evidence shows parent, padding, canvas, selection layer, or screen background mismatch.
- Allow any private xterm fallback only behind a strict proof and guard contract: same-run A/B proves no public path can satisfy the requirements, the fallback is limited to the affected renderer/browser state, it is scheduled after xterm has finalized selection geometry, it never runs unconditionally from every selection event, and browser smoke proves selected cells plus blank lower cells remain correct after select, blur, theme switch, clear, and reversed clear/theme ordering.

## Review Gap Resolution

| Review gap | Resolution required by this plan |
|---|---|
| 1. Do not assume the private call is causal. | Add same-run A/B diagnostics that compare native/public repaint versus private refresh under identical browser, renderer, geometry, DPR, zoom, font readiness, scroll offset, output, selection path, and timing. Inspect `.xterm`, `.xterm-screen`, canvas/rows layers, `.xterm-selection`, `#terminal-container`, and `#terminal-panel` computed backgrounds before selecting a fix. |
| 2. Deterministic setup. | Lock the smoke setup to Chrome, fixed viewport, forced DPR/zoom, fixed terminal panel height, known terminal rows/cols, completed font/layout readiness, top-level scroll at zero, `help` output scrolled to a known line, and known lower blank cells inside the xterm screen. The test must record these values in diagnostics. |
| 3. Pixel assertions on blank cells. | Add cell-aligned screenshot sampling inside `.xterm-screen` that excludes text glyphs, selected cells, cursor, scrollbar, padding, and borders. Assert blank cells match the configured terminal background after select, blur, theme switch, clear, and reversed clear/theme ordering. |
| 4. Renderer/browser scope. | Supported automated scope is Chrome/Chromium-family xterm default renderer because the app does not configure `rendererType`. The required matrix is Chrome smoke with the active default renderer recorded. If implementation adds or branches on `rendererType`, each configured renderer value becomes part of the required smoke matrix. Existing Edge/Brave/Chromium scripts may be run opportunistically but Chrome is the required gate for this issue. |
| 5. Alternatives and fallback contract. | Allowed alternatives are native xterm queued repaint, public full-row refresh, correcting terminal/screen/canvas/parent backgrounds, and timing the existing theme update after layout readiness. Private fallback is allowed only if A/B evidence proves it is necessary and the guard contract above is met. |
| 6. Genuine help path and diagnostics. | Use the real command-input path for `help`: focus terminal, type `help`, press Enter, then drag actual `Available commands:` and `g++` output. Do not inject test-only output into the terminal buffer for this regression. On failure, emit screenshots plus JSON diagnostics for renderer, geometry, DPR, zoom, rows/cols, scroll offset, selection range, computed backgrounds, sampled cells, and common pixel colors. |
| 7. RED then green and PR workflow. | First commit or document a failing smoke assertion on current behavior before the fix. Then implement the smallest evidence-backed fix and make the same test green. Open a feature-branch PR that includes `closes #113`, summarizes the A/B result, and attaches or links the diagnostic artifact path. |

## Relevant Files

Use these files to implement the feature:

- `src/ui/terminal.js` - Owns xterm creation, theme application, selection hooks, smoke-test terminal hooks, and the current private `_core._renderService.handleSelectionChanged(...)` call.
- `src/ui/themes.mjs` - Owns the five visual themes and the Monaco/xterm selection color contract.
- `src/ui/editor.js` - Exposes Monaco theme definitions and the existing smoke hook for computed Monaco selection colors.
- `src/ui/styles.css` - Defines terminal container, panel, xterm sizing, padding, and theme CSS variables that may contribute to black/stale backgrounds.
- `scripts/smoke-browser.mjs` - Required location for the deterministic browser regression, A/B diagnostics, screenshot capture, real mouse drags, and pixel assertions.
- `scripts/e2e-settings-visual-theme.test.mjs` - Configuration-level coverage for exact registry selection fields and contrast; not sufficient as rendering proof.
- `package.json` - Defines the required validation commands.
- `.github/` - Existing PR/CI workflows that should run lint, build, E2E, and smoke-related gates.

### New Files

- `scripts/e2e-terminal-selection-rendering.test.mjs` is optional only if the implementer chooses to split helper-level assertions out of `scripts/smoke-browser.mjs`. If created, it must be added to `npm run test:e2e`; browser rendering assertions still belong in `scripts/smoke-browser.mjs`.
- `artifacts/terminal-selection/` or a temporary smoke output directory may be used for failure screenshots and JSON diagnostics. Do not commit generated screenshots unless the PR discussion needs a specific reference image.

## Implementation Plan

### Phase 1: Foundation

Define the deterministic visual test environment and diagnostics before changing production behavior. The first useful artifact is a failing Chrome smoke check that proves the current code can leave black or non-theme-background pixels in blank terminal cells.

Required setup:

- Browser: Chrome target from `npm run test:browser:chrome`.
- Viewport: fixed dimensions set through CDP before opening the extension page.
- DPR/zoom: force a known device scale factor and assert `window.devicePixelRatio`; reset page zoom to 100%.
- Terminal panel: set a deterministic `#terminal-panel` height before fitting xterm.
- Terminal geometry: wait until `term.rows`, `term.cols`, `.xterm-screen` bounds, and cell width/height are stable for two animation frames.
- Fonts: wait for `document.fonts.ready` when available and then refit.
- Scroll: page scroll must be `0,0`; terminal viewport must be scrolled so `Available commands:` and `g++` are at known visible rows with known blank rows below.
- Blank cells: identify at least three cell-aligned sample points in lower visible rows whose buffer line text is empty at those columns.

### Phase 2: Core Implementation

Add the RED regression first, then diagnose. The smoke test must:

- Use genuine terminal input for `help` through focus/type/Enter, not `__browserCppRunCommand` or other output injection.
- Select `Available commands:` and `g++` using real CDP mouse drag coordinates derived from xterm cell geometry.
- Assert exact active and inactive terminal selection colors match the same browser's computed Monaco colors for all five themes.
- Assert selected pixels visibly differ from adjacent unselected cells.
- Assert blank cells match the terminal background and are not black in Light / High Contrast Light.
- Exercise the orderings `select -> blur -> theme switch -> clear` and `select -> clear -> theme switch`, plus the reversed `theme switch -> select -> clear`.

After RED, run the controlled A/B:

- Path A: remove/disable the private direct call in the test run and rely on xterm native/public repaint behavior.
- Path B: enable the current private direct call under the same geometry and timing.
- Capture identical diagnostics for both paths in the same browser session when possible; otherwise same browser binary, same launch args, same viewport, same DPR, same terminal rows/cols, and same smoke timing.
- Decide from evidence whether the artifact originates from private repaint timing, CSS/background mismatch, xterm renderer behavior, or another parent/canvas paint issue.

### Phase 3: Integration

Apply the smallest evidence-backed production fix while preserving all existing #113 requirements:

- Monaco and xterm active selection foreground/background must exactly match per theme.
- xterm inactive selection background must exactly match Monaco inactive selection appearance per theme.
- Existing terminal content and current selection must survive live theme changes.
- The `help` output drag selection must continue to work with real mouse interaction.
- Light and High Contrast Light blank terminal cells must never show black or stale dark paint.
- Persisted theme IDs remain unchanged.

If the final solution keeps any private xterm internal access, it must be isolated in one helper with an explicit comment explaining the evidence, renderer/browser guard, timing guard, and removal condition. It must not be called unconditionally from `onSelectionChange`, `mouseup`, and every theme change.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### Task 1: Create the Feature Branch and Baseline

- Start from current `main`.
- Create `fix/terminal-selection-black-strip`.
- Confirm Issue #113 is open and the PR description will include `closes #113`.
- Run `git status --short` and preserve unrelated user changes.

### Task 2: Document the Active Runtime Scope

- In `scripts/smoke-browser.mjs`, add diagnostics that record browser product/version, executable family, headless mode, viewport, DPR, zoom, xterm renderer value, xterm rows/cols, terminal panel/screen/container bounds, terminal font metrics, page scroll, terminal viewportY, and theme ID.
- Record that the app does not configure `rendererType`; therefore the supported automated renderer scope is xterm's default renderer in Chrome/Chromium-family browsers.
- If the implementation introduces explicit renderer choices, expand the smoke matrix to cover each configured renderer.

### Task 3: Add Deterministic Terminal Setup

- Force a fixed viewport and DPR through CDP before navigating to the extension page.
- Set terminal panel height deterministically in smoke mode and call the existing fit path.
- Wait for `document.fonts.ready`, two animation frames, and stable `.xterm-screen` geometry.
- Assert terminal `rows` and `cols` are known and stable before selecting text.
- Reset document scroll to `0,0` and verify no page-level scroll offset contaminates screenshot coordinates.

### Task 4: Create the E2E Browser Regression for Issue #113

- Extend `scripts/smoke-browser.mjs` with a focused Issue #113 smoke section.
- Use the genuine command-input path: focus the terminal, type `help`, press Enter, and wait for `Available commands:` plus `g++` in the xterm buffer.
- Do not use test-only terminal output injection for this regression.
- Add helper logic to derive cell-aligned coordinates from `.xterm-screen`, rows, cols, and visible buffer lines.
- Capture before/after screenshots around every visual transition.

### Task 5: Add Blank-Cell Pixel Assertions

- Identify blank sample cells inside `.xterm-screen` using buffer text and cell geometry.
- Exclude text glyph cells, selected cells, cursor cells, scrollbar, padding, borders, and any sample outside `.xterm-screen`.
- In Light and High Contrast Light, assert sampled blank pixels match the configured terminal background within the existing screenshot tolerance and are not black.
- Run these assertions after each required state: after select, after blur, after theme switch with retained selection, after clear, and after reversed clear/theme ordering.

### Task 6: Add Selection Pixel and Color Assertions

- For every theme (`vs`, `hc-light`, `browser-cpp-dark`, `vs-dark`, `hc-black`), read Monaco's computed active foreground/background and inactive background from the existing editor smoke hook.
- Assert xterm active selection foreground/background and inactive background exactly match those computed values.
- Assert selected cells visibly differ from nearby unselected cells.
- Assert selected text and selection position include the intended `Available commands:` or `g++` content.
- Assert inactive selection remains visible after focus moves to Monaco.

### Task 7: Add Controlled A/B Diagnostics Before Fixing

- Add a temporary implementation switch or local diagnostic mode that can run the same smoke sequence with the private refresh path disabled and enabled.
- Keep all other variables identical: browser binary, renderer, viewport, DPR, zoom, terminal height, rows/cols, font readiness, scroll offset, output, selected text, mouse coordinates, and wait timing.
- Save JSON diagnostics and screenshots for both paths on failure.
- Use this evidence to classify the root cause before production changes.

### Task 8: Decision Gate: Choose the Production Fix

- If the native/public xterm path passes all color, selection, and blank-cell assertions, remove the private direct render-service call and rely on native/public repaint.
- If selection colors update only after a public repaint, use the narrowest public API available, such as a scheduled full visible-row refresh after theme updates.
- If black cells come from CSS or parent/canvas backgrounds, fix the specific background/stacking/clipping source in `src/ui/styles.css` or terminal setup.
- If and only if no public/CSS path satisfies the tests, keep a private fallback behind a renderer/browser/timing guard and prove it does not create black cells across all required state transitions.

### Task 9: Implement the Evidence-Backed Fix

- Modify only the production files implicated by the A/B result.
- Preserve exact Monaco color matching for all five themes.
- Preserve terminal contents, scroll state, logical selection, and visible inactive selection during live theme changes.
- Keep persisted theme IDs unchanged.
- Remove any diagnostic-only production switch before final validation.

### Task 10: Keep Configuration Coverage

- Keep or extend `scripts/e2e-settings-visual-theme.test.mjs` so every theme defines active selection foreground/background and inactive background.
- Assert selected foreground/background contrast remains acceptable.
- Assert selection background is distinct from terminal background.
- Treat this as configuration coverage only; do not use it as proof that rendering is fixed.

### Task 11: Improve Failure Artifacts

- On browser smoke failure, print concise paths to saved screenshots and JSON diagnostics.
- Diagnostics must include renderer, browser version, viewport, DPR, zoom, rows/cols, screen bounds, selection range/text, focus state, theme, computed backgrounds for terminal parents/layers/canvas/selection layer, blank-cell sample coordinates, expected colors, actual sampled colors, and most common screenshot colors in failed regions.
- Ensure diagnostics use actual line breaks in GitHub/console output where multiline text is emitted.

### Task 12: Run the Validation Commands

- Run every command listed in the Validation Commands section.
- Confirm the Issue #113 browser smoke is RED on current behavior before the production fix and GREEN after the fix.
- Open a PR from `fix/terminal-selection-black-strip` with `closes #113`, the A/B conclusion, supported renderer/browser scope, and artifact references.

## Testing Strategy

### Unit Tests

- Extend `scripts/e2e-settings-visual-theme.test.mjs` for all five themes:
  - exact registry presence for `selectionForeground`, `selectionBackground`, and `selectionInactiveBackground`;
  - contrast checks between selected foreground/background;
  - selection background distinct from terminal background;
  - persisted theme IDs unchanged.

### Browser E2E / Smoke Tests

- Add the Issue #113 rendering regression to `scripts/smoke-browser.mjs`.
- Required browser: Chrome via `npm run test:browser:chrome`.
- Required renderer: xterm default renderer currently used by the app, recorded in diagnostics.
- Required interactions:
  - real terminal `help` command input;
  - real mouse drag over `Available commands:`;
  - real mouse drag over `g++`;
  - focus transition from terminal to Monaco;
  - live theme switching with selection retained;
  - clear selection;
  - reversed clear/theme ordering.

### Edge Cases

- Light and High Contrast Light blank lower cells after selection repaint.
- Selection spans only text cells, while blank-cell checks sample unselected empty cells in the same screen.
- Theme switch while terminal is blurred and selection remains inactive.
- Theme switch while terminal still has an active selection.
- Clear selection before theme switch and theme switch before clear.
- Device pixel ratio and screenshot scaling on macOS Retina and non-Retina displays.
- Headless and headed Chrome if both are used locally.
- Any future explicit `rendererType` values.

## Acceptance Criteria

- A browser smoke test fails against the current black-strip behavior before the fix.
- Light and High Contrast Light show no black strip or stale dark region before, during, or after terminal text selection.
- Blank, unselected cells inside `.xterm-screen` match the active terminal background after select, blur, theme switch, clear, and reversed clear/theme ordering.
- Selecting `Available commands:` and `g++` in real `help` output visibly paints the exact Monaco active selection background and foreground for the active theme.
- Inactive selection remains visible after focus leaves the terminal and uses Monaco's inactive selection color.
- Selection text, terminal content, scroll state, and current selection survive live theme changes.
- All five themes pass exact Monaco/xterm selection color checks.
- The supported renderer/browser scope is stated in the PR and enforced by tests.
- Production code does not contain an unguarded direct call to `term._core._renderService.handleSelectionChanged(...)`.
- Any private fallback, if retained, has same-run proof, a narrow guard, failure diagnostics, and a documented removal condition.
- The PR is opened from a feature branch and includes `closes #113`.

## Decision Gates

### Gate 1: RED Reproduction

Do not change production behavior until the deterministic smoke test fails on the current behavior or captures the black-strip artifact in diagnostic output. If the current local browser cannot reproduce the strip, the test must still fail by asserting the missing contract that current code violates, such as unguarded private repaint usage plus blank-cell background proof.

### Gate 2: Causality

Do not remove or retain the private call based on suspicion. Compare private-enabled and private-disabled behavior under identical setup and record the result.

### Gate 3: Fix Selection

Choose the smallest fix that satisfies selection colors, inactive visibility, live theme switching, content retention, and blank-cell background correctness.

### Gate 4: Fallback Approval

Private xterm internals are acceptable only if public and CSS alternatives fail under recorded evidence and the final guarded fallback passes the full smoke matrix.

### Gate 5: Release Readiness

Do not mark #113 fixed until lint, build, Node E2E, syntax check, and Chrome smoke all pass.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions:

```bash
npm run lint
npm run build
npm run test:e2e
node --check scripts/smoke-browser.mjs
npm run test:browser:chrome
```

Optional expanded browser-family confidence when local browsers are installed:

```bash
npm run test:browser:edge
npm run test:browser:brave
npm run test:browser:chromium
```

## Risks

- xterm private APIs can change without notice; avoid them unless the proof/guard contract is satisfied.
- Canvas screenshot pixels can vary by platform color management; use exact computed CSS assertions for exact color identity and tolerant screenshot sampling for paint visibility/background correctness.
- Font loading and terminal fitting can make cell coordinates drift; deterministic setup must wait for stable geometry before dragging or sampling.
- A black strip may come from parent/container/canvas backgrounds rather than selection repaint. The A/B step and CSS/background diagnostics are required to avoid fixing the wrong layer.
- Headless and headed Chrome can differ in rendering; record headless mode and browser version in artifacts.

## Notes

No code patches are part of this planning update. The next implementation should proceed on a feature branch, post the A/B conclusion in the PR, and link the PR with `closes #113`.
