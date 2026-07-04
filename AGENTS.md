# AGENTS.md

Operational reference for browser.cpp (in-browser C++20 IDE, WASM Clang toolchain).

## Commands
- Install: `npm ci`
- Lint: `npm run lint`
- Build: `npm run build` (webpack → `dist/`)
- E2E tests: `npm run test:e2e`

## Infrastructure

`browser.cpp` is a Chrome/Chromium extension that turns the browser into a local C++20 IDE.
The codebase is split into three main layers:

  - **UI layer**: the in-browser editor, terminal, toolbar, file browser, and session state
  - **Execution layer**: web workers that compile C++ with WASM Clang and run it through a WASI
  shim
  - **Infrastructure layer**: Webpack build config, release packaging, browser smoke tests, and
  GitHub Actions automation

The project is built with **Webpack**, linted with **ESLint**, and tested with a mix of
**Node-based E2E tests** and **browser smoke tests**. CI runs lint, build, version checks, and
E2E tests on pull requests. Release automation fetches the Clang WASM toolchain, builds the
extension, verifies version alignment, packages distributable archives, and uploads them as
artifacts.

### Repository File Structure

  - `src/` contains the application code
  - `scripts/` contains build, release, verification, and browser test scripts
  - `dist/` is the generated unpacked extension output for different browsers
  - `release/` holds packaged release artifacts
  - `.github/` contains CI and release workflows
  - `icons/`, `manifest.json`, and `webpack.config.js` support extension packaging and bundling  

### Runtime summary

At runtime, the extension loads a browser-based IDE shell, compiles code inside a worker using
a WASM toolchain, and can read/write files in an opened local folder through the File System
Access API. The design is centered on running a real C++ workflow entirely inside the browser
without a traditional backend.

## Project Workflow

- ALWAYS ON: All changes should follow the `github-workflow` skill to use GitHub Issues as the singular source of truth and Pull Requests from feature branches as the point of review and quality assurance. Every Pull Request should be linked to closing a corresponding Issue.
- ALWAYS ON: Proposed changes should be planned using `plan-agent` to document an implementation plan that can be reviewed, critiqued, and revised before deciding to initiate implementation
- If these agents/skills aren't available locally, they can be retrieved from [kbuffardi/.agents](https://github.com/kbuffardi/.agents)
