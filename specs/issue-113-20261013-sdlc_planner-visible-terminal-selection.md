# Updated plan: Make terminal text selection visibly render (#113)

## Context

The latest issue discussion and attached screenshots confirm the bug. In the editor, a selection appears as a rounded light-blue highlight behind dark text; selecting the terminal's `Available commands:` and `g++` lines produces no visible highlight. PR #114 configured selection colors and checked xterm's logical selection/theme state, but did not prove that the browser painted a visible selection.

The follow-up browser investigation reproduced a logical mouse selection but found no xterm selection rectangles. Instrumenting the active renderer showed redraw requests with an empty range (`[null, null, false]`) even though xterm's public selection position contained the final mouse-drag range. Explicitly sending the current range to the active renderer produced the missing paint; production code now resynchronizes that range on selection changes, mouseup, and theme changes.

## Goal

Make mouse-selected terminal text visibly highlighted in Light and High Contrast Light themes, comparable to the editor selection, while retaining readable selection in dark themes and preserving theme IDs and terminal contents.

## Implementation plan

1. **Sync and reproduce.** Start a feature branch from current main including merged PR #114. Build and load the extension in Chrome. In Light theme, drag-select the reported help text and record `term.getSelection()`, renderer type, selection overlay elements/rectangles, computed foreground/background, focus state, and before/after screenshots.
2. **Identify the failing render stage.** Determine whether xterm creates selection overlay elements and whether their rectangles intersect selected cells. If absent, inspect selection refresh/renderer behavior. If present, inspect computed styles, clipping, stacking, and screenshot pixels for transparent paint or occlusion. Also exercise focused and unfocused selection paths. Do not assume a CSS override is the fix until evidence identifies the failure.
3. **Fix the cause.** Keep theme-registry selection values and explicitly send xterm's current selection range to its active renderer after selection changes and theme changes. This keeps the renderer's foreground and background paint in sync with the logical selection without adding a CSS overlay or recreating the terminal. Match Monaco's computed active foreground/background and inactive background for every theme; retain persisted theme IDs.
4. **Add a failing browser regression first.** Extend `scripts/smoke-browser.mjs` to perform real mouse drags over both reported help lines. Assert selected text, overlay geometry, selected-text foreground, active/inactive computed backgrounds, and a visible screenshot/pixel difference between selected and adjacent unselected cells. Cover all five themes and verify theme switching preserves and repaints the existing selection. Include diagnostics on failure so a state-only pass cannot mask invisible rendering.
5. **Retain configuration tests.** Keep theme registry tests for selection foreground/background/inactive values, but label them as configuration coverage, not rendering proof. Preserve persisted theme IDs (`vs`, `vs-dark`, `hc-light`, `hc-black`).
6. **Validate.** Run lint, build, E2E, syntax check, and Chrome browser smoke. Include browser-render evidence in the PR and link it to #113.

## Acceptance criteria

- Selecting `Available commands:` and `g++` in Light theme visibly paints light blue behind dark text, comparable to the attached editor screenshot.
- High Contrast Light has an equally perceivable selection; dark themes remain readable.
- Browser tests fail if selection is only logical, if paint is transparent/hidden/zero-sized, or if selected cells are not visibly distinct in screenshot/pixel evidence.
- Theme changes update selection appearance without losing terminal output or changing stored theme IDs.

## Confirmed decisions

- Match each Monaco theme's exact computed selection foreground/background and inactive background in xterm.
- Keep the selection visible after terminal focus moves away.
- Exercise all supported terminal renderers through xterm's active render service.
- Verify exact computed colors as well as real painted pixels and geometry.
- Use the real `help` output, with controlled size and scroll position.
- Repaint an existing selection immediately after a theme change without clearing it.

## Validation commands

- `npm run lint`
- `npm run build`
- `npm run test:e2e`
- `node --check scripts/smoke-browser.mjs`
- `npm run test:browser:chrome`
