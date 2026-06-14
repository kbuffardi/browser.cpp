# AGENTS.md

Operational reference for browser.cpp (in-browser C++20 IDE, WASM Clang toolchain).

## Commands
- Install: `npm ci`
- Lint: `npm run lint`
- Build: `npm run build` (webpack → `dist/`)
- E2E tests: `npm run test:e2e`

## Notes
- UI modules (`src/ui/*.js`) use ESM `export` syntax in `.js` files. `test:e2e`
  passes `--experimental-detect-module` so Node < 22.7 can import them from the
  `.mjs` test files; CI's `lts/*` Node detects automatically.
- E2E suites are `scripts/e2e-*.test.mjs`; they run the real `src/ui` modules
  with injected fakes (no browser/DOM needed for most cases).
- CI (`.github/workflows/ci.yml`) runs lint + build + `test:e2e`.
