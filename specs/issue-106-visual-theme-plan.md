# Implementation Plan: Issue #106 — Visual themes

## Scope

Add a persistent `Visual theme` setting with `browser-cpp-dark` as the default,
and `vs`, `vs-dark`, `hc-light`, and `hc-black` as additional choices. It is the
first Settings option; five named native-radio cards switch shell CSS, Monaco,
and xterm immediately, stay in the open drawer, and survive reloads. Memory
Debug Mode and compile/run behavior remain unchanged.

## Dependency order

Registry → settings validation → cards/CSS → boot application → Monaco/xterm →
persisted browser flow. Each task is a gate for the task after it.

## Risk-resolution tasks

### 1. Define and validate one theme registry

**Files:** `src/ui/themes.mjs`, `scripts/e2e-settings-visual-theme.test.mjs`

Create exactly five app-theme entries, each with `id`, `label`, `monacoTheme`,
`cssTokens`, `terminalTheme`, and `preview`. Safe lookup must map missing,
malformed, and unknown values to `browser-cpp-dark`. Register only the custom
theme; use native Monaco IDs for the built-ins.

**Gate:** tests assert the exact IDs, complete entry shapes, safe fallbacks, and
complete xterm palettes (background/foreground/cursor plus ANSI and bright ANSI
colors). This prevents registry drift, invalid settings, and Monaco redefinition.

### 2. Extend settings storage without breaking old data

**Files:** `src/ui/settings.mjs`, `scripts/e2e-settings-visual-theme.test.mjs`

Add `visualTheme` and `setVisualTheme()` to the existing `browser_cpp_settings`
model, preserving both Promise and callback storage APIs. All writes include
both settings so updating Memory Debug Mode migrates old records.

**Gate:** test default settings, legacy `{ memoryDebugMode: true }`, invalid IDs,
both storage styles, immediate subscriber notification, and persistence of both
fields. Existing Memory Debug Mode tests stay green.

### 3. Derive cards and root palettes from that registry

**Files:** `src/ui/themes.mjs`, `src/ui/settings.mjs`, `src/ui/styles.css`,
`scripts/e2e-settings-visual-theme.test.mjs`

Generate cards and CSS mini-previews from registry data; do not duplicate IDs in
static markup. Scope theme variables using `data-visual-theme` on the root and
wire selection through the validated `setVisualTheme()` API from Task 2.

**Gate:** DOM tests prove every registry ID renders exactly one labelled card,
each card updates the matching root attribute through settings, and no static ID
can drift from the registry.

### 4. Keep visual preferences out of compiler messages

**Files:** `src/ui/app.js`, `src/ui/toolbar.js`,
`scripts/e2e-session-persistence.test.mjs`

Change the compile-options callback to expose only `{ memoryDebugMode }`.

**Gate:** an `assembleCompilePayload()` test passes
`{ memoryDebugMode: true, visualTheme: 'vs' }` through compile options and
asserts the payload includes `memoryDebugMode: true` but omits `visualTheme`.
Existing Memory Debug Mode compilation coverage passes.

### 5. Implement keyboard-accessible native-radio cards

**Files:** `src/ui/index.html`, `src/ui/settings.mjs`, `src/ui/styles.css`,
`scripts/e2e-settings-visual-theme.test.mjs`, `scripts/smoke-browser.mjs`

Put a Visual theme `fieldset`/`legend` before Memory Debug Mode. Each card is a
label containing a native radio; previews are decorative. Use native checked and
focus-visible styles rather than custom ARIA radio behavior.

**Gate:** DOM/browser tests verify five labelled radios, Tab/arrow selection,
storage and root updates, an open drawer, no Apply/Save control, and visible
focus/selection in light and high-contrast themes.

### 6. Tokenize every theme-sensitive shell surface

**Files:** `src/ui/styles.css`, `src/ui/themes.mjs`, `scripts/smoke-browser.mjs`

Audit and convert fixed colors in the backdrop/shadow, button states, terminal
stop control, reload UI, scrollbars, file-tree loading state, and dirty-tab
indicator. Document any remaining literal color as non-theme-sensitive.

**Gate:** selecting `vs` changes computed toolbar, sidebar, Settings panel,
terminal-panel, and statusbar styles; high-contrast selection keeps a visible
radio focus outline. This eliminates dark-only remnants.

### 7. Apply the stored theme before mounting Monaco and xterm

**Files:** `src/ui/app.js`, `src/ui/themes.mjs`, `src/ui/editor.js`,
`src/ui/terminal.js`, `scripts/smoke-browser.mjs`

Immediately after settings load, apply the resolved root attribute and pass the
same theme to both factories. Use this lookup for boot and live changes.

**Gate:** preload storage with `vs`; smoke asserts the initial root state,
selected radio, and shell palette before Settings interaction, with both runtime
components mounted and no console error. This prevents Monaco and xterm from
mounting with the wrong stored theme; zero first-paint flash is not required.

### 8. Switch Monaco live without losing state

**Files:** `src/ui/editor.js`, `src/ui/themes.mjs`, `scripts/smoke-browser.mjs`

Register `browser-cpp-dark` once and expose `setTheme(appThemeId)`, mapping via
the registry to `monaco.editor.setTheme`; never recreate the editor.

**Gate:** smoke cycles through all five choices without errors and proves editor
content, cursor, and diagnostic markers survive. Registration is idempotent.

### 9. Switch xterm live without losing state

**Files:** `src/ui/terminal.js`, `src/ui/themes.mjs`, `src/ui/app.js`,
`scripts/smoke-browser.mjs`

Accept an initial app theme in `createTerminal()` and expose `setTheme()` that
assigns `term.options.theme` on the existing instance; never dispose xterm for
a theme change.

**Gate:** terminal content and its mounted container survive choosing `vs`;
prompt, busy state, stdin session, and workspace callbacks remain usable;
invalid IDs use the default palette.

### 10. Verify ANSI output is readable

**Files:** `src/ui/themes.mjs`, `src/ui/terminal.js`, `scripts/smoke-browser.mjs`

Use sufficiently dark ANSI colors for light palettes and explicit high-contrast
foreground/background separation. Command output continues to use xterm's
palette rather than per-command theme branches.

**Gate:** palette-shape tests reject incomplete colors and browser smoke shows
distinct readable terminal foreground/background after selecting `vs`.

### 11. Prove the persisted end-to-end flow

**Files:** `scripts/e2e-settings-visual-theme.test.mjs`,
`scripts/smoke-browser.mjs`, `package.json`

Add the new focused E2E file to the standard test command. Smoke coverage must
exercise default state, keyboard light-theme selection, open drawer, storage,
reload, shell update, Monaco/xterm state survival, and no console errors.

**Gate:** `npm run lint`, `npm run build`, `npm run test:e2e`, and—when its local
fixture is available—`npm run test:browser:chrome` all pass.

## Completion criteria

- [ ] Registry and Settings UI represent the same five IDs exactly once.
- [ ] Stored and live themes update shell, Monaco, and xterm without recreating
  editor or terminal.
- [ ] Legacy settings, invalid IDs, compile-payload shape, and ANSI readability
  have passing dedicated tests.
- [ ] Light/high-contrast browser smoke shows readable shell, editor, and
  terminal surfaces with no console errors.
- [ ] The implementation PR references `closes #106` and receives human review.
