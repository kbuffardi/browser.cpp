# browser.cpp

An in-browser **C++20 IDE** delivered as a Chrome / Chromium extension.

| Feature | Detail |
|---------|--------|
| Editor | Monaco Editor (the engine behind VS Code) |
| Compiler | WASM-native Clang (runs entirely in the browser, offline) |
| Terminal | xterm.js with a bash-like shell (`g++`, `./a.out`, `ls`, `cat`, …) |
| File access | File System Access API on Chromium, fallback file/folder flows on Firefox |
| File I/O | `fstream` / `ifstream` / `ofstream` – read and write workspace files at runtime |
| Standards | C++14 · C++17 · **C++20** (selectable in the toolbar) |

---

## Quick start

### 1 – Install Node dependencies

```bash
npm install
```

### 2 – Fetch the Clang WASM binary

The compiler binary is **not** shipped in this repository (~43 MB).
Download the pre-built [browsercc](https://github.com/BertalanD/browsercc) binary
(LLVM 20, C++23-capable):

```bash
npm run fetch-clang
```

> **Building your own binary** (custom LLVM version):
> See [§ Building Clang WASM from source](#building-clang-wasm-from-source) below.

### 3 – Build the extension

```bash
npm run lint           # lint the repository
npm run build          # production build → dist/
# or
npm run dev            # development build with watch mode
```

### 4 – Load in Chrome / Edge / Brave / Chromium

1. Open **chrome://extensions**, **edge://extensions**, **brave://extensions**,
   or **chromium://extensions**
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `dist/` folder
4. Click the browser.cpp icon in the toolbar (or press the extension button)
   to open the IDE in a new tab

---

## Architecture

```
browser.cpp/
├── manifest.json                  Chrome extension manifest (MV3)
├── package.json                   NPM scripts & dependencies
├── webpack.config.js              Build configuration
│
├── src/
│   ├── background/
│   │   ├── background-main.js     Shared background logic
│   │   ├── firefox-background.js  Firefox background script entry
│   │   └── service-worker.js      Chromium MV3 service worker entry
│   ├── ui/
│   │   ├── index.html             IDE shell
│   │   ├── styles.css             VS Code–inspired dark theme
│   │   ├── app.js                 Entry point – boots all subsystems
│   │   ├── editor.js              Monaco editor setup & diagnostic API
│   │   ├── terminal.js            xterm.js terminal + shell emulator
│   │   ├── filesystem.js          File System Access API wrapper
│   │   └── toolbar.js             Toolbar buttons & keyboard shortcuts
│   └── workers/
│       └── compiler.worker.js     WASM Clang loader, compile, WASI run
│
├── scripts/
│   ├── generate-icons.js          Generates PNG extension icons (prebuild)
│   └── fetch-clang-wasm.js        Downloads clang.js + clang.wasm
│
├── dist/                          ← Chromium-family unpacked extension output
│   ├── manifest.json
│   ├── index.html
│   ├── bundle.js
│   ├── service-worker.js
│   ├── firefox-background.js
│   ├── compiler.worker.js
│   ├── editor.worker.js            (emitted by monaco-editor-webpack-plugin)
│   ├── ts.worker.js                (emitted by monaco-editor-webpack-plugin)
│   ├── icons/
│   └── clang/
│       ├── clang.js               (downloaded by npm run fetch-clang)
│       └── clang.wasm             (downloaded by npm run fetch-clang)
└── dist-firefox/                  ← Firefox unpacked extension output
    └── manifest.json
```

### Compile & run pipeline

```
Workspace sources (+ unsaved tab overlay)
    │  postMessage {type:'compile', sourcePaths, files, std, flags, outputName}
    ▼
compiler.worker.js  ──importScripts──▶  dist/clang/clang.js
    │   clang++ -###  → multi-TU compile plan (one -cc1 per source + wasm-ld)
    │   compile each source in a fresh Clang, link all objects with LLD
    │◀── Emscripten Module ──────────────────┘
    │
    │  output.wasm (WASI binary) read from virtual FS
    │
    │  WebAssembly.instantiate(output.wasm, { wasi_snapshot_preview1: … })
    │
    ▼
WASI shim (built into compiler.worker.js)
    │  stdout/stderr streamed back via postMessage
    ▼
terminal.js  →  xterm.js display
```

---

## fstream / File I/O

When a folder is opened with **Ctrl+O** (or **Open folder**), the compiled program
can read and write files in that folder using standard C++ file streams:

```cpp
#include <fstream>
#include <string>

int main() {
    // Read a file
    std::ifstream in("input.txt");
    std::string line;
    while (std::getline(in, line)) { /* … */ }

    // Write a file
    std::ofstream out("output.txt");
    out << "Hello from browser.cpp!\n";
}
```

**How it works:** Before each run the extension reads all workspace files into
an in-memory virtual filesystem (VFS) that is exposed to the WASM program via
the WASI `snapshot_preview1` file-system API.  After the program exits, any
files the program created or modified are written back to the real folder on
disk.  Opening a folder requests **read/write** permission so that outputs can
be persisted.

**When no folder is open,** `fstream` opens will fail as expected
(`failbit` is set), and no files are written back.

---



| Action | Shortcut |
|--------|----------|
| Compile & Run | **F5** |
| Compile only | **Ctrl+Shift+B** |
| Run (last build) | **Ctrl+Shift+R** |
| Save | **Ctrl+S** |
| Open folder | **Ctrl+O** |
| New | **Ctrl+N** |
| Clear terminal | **Ctrl+K** |

---

## Terminal commands

| Command | Description |
|---------|-------------|
| `g++ [files…] [flags] [-std=c++NN] [-o out]` | Compile explicit source files (e.g. `g++ main.cpp other.cpp`). With no files given, compiles the current editor buffer. `.c`/`.cc` inputs are rejected in this MVP. |
| `./a.out` / `./<name>` | Run the last compiled binary (use `./<name>` after `-o <name>`) |
| `clear` | Clear the terminal |
| `echo <text>` | Print text |
| `ls [-R] [dir]` | List files/folders from the opened workspace folder |
| `cd [dir]` | Change the current workspace directory |
| `cat <file>` | Print file contents |
| `pwd` | Print working directory |
| `help` | Show command list |

### Project builds

The toolbar **Compile** / **Compile & Run** buttons build the *whole opened
workspace*: every recursive `.cpp` and `.cxx` file is compiled and linked
together (`.c`/`.cc` are ignored for this MVP). When no folder is open, they fall
back to compiling the single editor buffer.

Builds reflect the live, in-memory project: unsaved edits in open tabs are
overlaid on top of the on-disk files before compiling, so local includes such as
`#include "other.cpp"` or `#include "app.hpp"` resolve against the opened folder
even when the referenced file has unsaved changes. Compiler/linker diagnostics
for all files print in the terminal, while inline editor markers stay scoped to
the active file. **Compile & Run** runs the actual built artifact (honouring a
`-o` name), not a hardcoded `a.out`.


---

## Browser compatibility and releases

Full feature parity is supported for desktop Chrome, Edge, Brave, and Chromium
when the browser is based on Chromium 105 or newer. Latest stable is recommended
for release testing.

Firefox desktop is also a supported release target, but its support contract is
different:

- compile/run, Monaco, and extension-runtime flows are supported
- file open/save and folder import use fallback browser flows rather than
  Chromium File System Access APIs
- persistent folder write-back and directory-handle session restore may be
  reduced compared with Chromium-family builds
- public AMO publication is manual; the protected release workflow generates the
  Mozilla-signed unlisted XPI for self-distribution

Full parity requires:

- Manifest V3 extension APIs (`chrome.runtime`, `chrome.tabs`, `chrome.storage`)
- File System Access APIs (`showOpenFilePicker`, `showDirectoryPicker`,
  `showSaveFilePicker`)
- Web Workers and WebAssembly
- `SharedArrayBuffer` and `Atomics.waitAsync` for interactive stdin
- Managed browser policies that allow local file read/write prompts

### Release-blocking checks

Run the fast checks before browser-specific smoke tests:

```bash
npm run release:clean
npm run fetch-clang
npm run lint
npm run build
npm run test:e2e
npm run test:preflight-clang
npm run version:check
npm run release:check-version
```

`test:preflight-clang` requires these files to exist under `dist/clang/`:
`clang.js`, `clang.wasm`, `lld.js`, `lld.wasm`, and `sysroot.tar`. Run
`npm run fetch-clang` before browser smoke tests or release packaging.

Run smoke tests for each Chromium-family target:

```bash
npm run test:browser:chrome
npm run test:browser:edge
npm run test:browser:brave
npm run test:browser:chromium
```

Run the Firefox packaging smoke separately:

```bash
npm run test:browser:firefox
```

For release candidates triggered by a `manifest.json` version bump, GitHub Actions
uploads browser-labeled release artifacts for same-repo pull requests only. The
release workflow uses `manifest.json` as the version source of truth and expects
`package.json` to stay in sync with that value. See `docs/release-playbook.md`
for the full release flow and the remaining human-owned publish steps.

The smoke runner auto-discovers common browser install paths. Override discovery
with `CHROME_PATH`, `EDGE_PATH`, `BRAVE_PATH`, `CHROMIUM_PATH`, or a generic
`BROWSER_PATH`.

If auto-discovery misses a browser, set the path explicitly before running a
single target:

```bash
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run test:browser:chrome
EDGE_PATH="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" npm run test:browser:edge
BRAVE_PATH="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" npm run test:browser:brave
CHROMIUM_PATH="/Applications/Chromium.app/Contents/MacOS/Chromium" npm run test:browser:chromium
```

Common binary locations:

- macOS:
  - Chrome: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
  - Edge: `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`
  - Brave: `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`
  - Chromium: `/Applications/Chromium.app/Contents/MacOS/Chromium`
- Linux:
  - Chrome: `/usr/bin/google-chrome` or `/usr/bin/google-chrome-stable`
  - Edge: `/usr/bin/microsoft-edge` or `/usr/bin/microsoft-edge-stable`
  - Brave: `/usr/bin/brave-browser` or `/usr/bin/brave`
  - Chromium: `/usr/bin/chromium` or `/usr/bin/chromium-browser`
- Windows:
  - Chrome: `%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe`
  - Edge: `%LOCALAPPDATA%\\Microsoft\\Edge\\Application\\msedge.exe`
  - Brave: `%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`
  - Chromium: `%LOCALAPPDATA%\\Chromium\\Application\\chrome.exe`

For CI, set the same variables on the job before invoking the smoke script, for
example:

```bash
export CHROME_PATH=/path/to/google-chrome
export EDGE_PATH=/path/to/msedge
export BRAVE_PATH=/path/to/brave-browser
export CHROMIUM_PATH=/path/to/chromium
npm run test:browser
```

Automated smoke tests validate extension load, required browser APIs, compiler
asset loading, Monaco rendering, default C++ compile-and-run, and console-error
absence. Native `showDirectoryPicker()` path selection is not exposed through a
stable Chromium DevTools automation API, so each release also needs this manual
check in every target browser:

1. Open a local folder.
2. Create a new source file.
3. Save and Save As.
4. Compile a multi-file project.
5. Run a program that reads stdin.
6. Write an output file with `std::ofstream`.
7. Close and reopen the browser, then restore the previous workspace.

### Release packages

Create browser-labeled release ZIPs from the built `dist/` contents:

```bash
npm run package:release
```

This writes:

- `release/browser-cpp-chrome-v<version>.zip` for the Chrome Web Store listing
- `release/browser-cpp-edge-v<version>.zip` for Microsoft Edge Add-ons
- `release/browser-cpp-firefox-v<version>.zip` for Firefox unsigned/manual submission packaging
- `release/browser-cpp-brave-v<version>.zip` for Brave validation/distribution
- `release/browser-cpp-chromium-v<version>.zip` for Chromium/GitHub distribution
- `release/firefox-unlisted/*.xpi` after the protected release workflow signs the Firefox unlisted build
- `release/SHA256SUMS-v<version>.txt`
- `release/release-manifest-v<version>.json`

The release manifest tracks the browser package matrix:

- Chrome is the canonical Chromium-family payload
- Edge, Brave, and Chromium currently reuse that payload under browser-labeled filenames
- Firefox has its own manifest, background entry, unsigned ZIP artifact, and signing metadata

Chrome, Edge, Brave, and Chromium still share the same MV3 payload. Firefox is
packaged from `dist-firefox/` as a separate payload because its manifest and
background model differ from Chromium.

Store submission notes should state:

- Minimum browser version: Chromium 105+, latest stable recommended
- Local file prompts are required for folder read/write
- Compiler assets are packaged with the extension
- Programs execute inside the extension's WASI/WebAssembly sandbox
- No remote code execution is used

### Release workflow

Use `.github/workflows/release.yml` to publish one GitHub Release per
`manifest.json` version. On pushes to `main`, the workflow:

1. Reads `manifest.json.version`
2. Skips work if GitHub Release `v<version>` already exists
3. Verifies manifest-driven version sync
4. Cleans `dist/` and `release/`
5. Fetches the Clang toolchain
6. Runs lint, build, release validation, and E2E checks
7. Runs Firefox packaging smoke validation
8. Produces the browser-labeled ZIPs plus checksums and release metadata
9. Signs the Firefox unlisted XPI with protected AMO credentials
10. Creates or updates GitHub Release `v<version>` and uploads `release/*`

Use `workflow_dispatch` with `force=true` to rebuild and re-upload assets for an
existing release. The workflow does **not** publish directly to browser stores.
Store publication and Chromium distribution remain human-owned steps.
Public AMO publication also remains human-owned even though the unlisted Firefox
XPI is signed automatically during release.

### Human-owned deployment instructions

These steps happen after the automated release workflow or local release commands
have produced a validated `release/` directory and, for GitHub-distributed
assets, published GitHub Release `v<version>`.

#### Chrome Web Store

1. Verify you still have access to the existing Chrome Web Store item for
   browser.cpp.
2. Upload `release/browser-cpp-chrome-v<version>.zip`.
3. Update listing copy, screenshots, privacy details, and reviewer notes if the
   release changes user-visible behavior, permissions, or file-access guidance.
4. Confirm the listing still describes the extension as a local-only WASI/WebAssembly
   compiler with user-approved file access prompts.
5. Submit the draft, monitor review, and address any reviewer questions.
6. After publication, install/update from the public listing and verify the
   release in Chrome.

#### Microsoft Edge Add-ons

1. Verify the Microsoft Partner Center account is active, or create it before
   the first Edge release.
2. Create the Edge Add-ons listing if one does not exist yet.
3. Upload `release/browser-cpp-edge-v<version>.zip`.
4. Complete the store listing fields, availability/market settings, privacy
   links, and any certification notes requested by Partner Center.
5. Submit for certification and respond to reviewer feedback.
6. After publication, install/update from the Edge Add-ons listing and verify
   the release in Edge.

#### Brave

1. Run `npm run test:browser:brave`.
2. Load the validated release in Brave and complete the manual QA checklist
   below.
3. Install the published Chrome Web Store listing in Brave and verify the
   end-user install/update flow.
4. If Brave-specific notes are needed for users or reviewers, add them to the
   project documentation before announcing the release.

Brave does not use a separate store submission flow here; it rides on Chrome Web
Store compatibility plus Brave-specific validation.

#### Chromium

1. Verify that GitHub Release `v<version>` includes:
   - `release/browser-cpp-chromium-v<version>.zip`
   - `release/SHA256SUMS-v<version>.txt`
   - `release/release-manifest-v<version>.json`
2. Publish manual installation instructions for Chromium users, including that
   the extension is loaded outside a browser store.
3. Verify the packaged artifact can be loaded in Chromium and passes the manual
   QA checklist below.

There is no official Chromium extension store in this workflow; Chromium is a
manual/GitHub-distributed channel.

#### Firefox

1. Run `npm run test:browser:firefox`.
2. Review `amo/metadata/listed.json` and update it if the release changes
   Firefox-facing product behavior or listing copy.
3. For public AMO publication, upload the Firefox package and metadata manually
   through the owner-managed listing workflow.
4. For self-distribution, verify that the protected release workflow produced a
   signed artifact under `release/firefox-unlisted/`.
5. Install the signed XPI in Firefox and complete the manual QA checklist
   below, paying special attention to the documented workspace-persistence
   limitations.

### Manual release QA checklist

Perform these checks in Chrome, Edge, Brave, and Chromium before publishing:

1. Open a local folder.
2. Create a new source file.
3. Save and Save As.
4. Compile a multi-file project.
5. Run a program that reads stdin.
6. Write an output file with `std::ofstream`.
7. Close and reopen the browser, then restore the previous workspace.

---

## Building Clang WASM from source

For a **custom LLVM version** or offline builds, compile Clang with Emscripten.
The compiler worker accepts either output format:

**ES6 module format** (recommended, Emscripten 3.0+):
```bash
# Prerequisites: Emscripten SDK (emsdk), CMake, Ninja
git clone https://github.com/llvm/llvm-project
cd llvm-project

emcmake cmake -S llvm -B build-wasm -G Ninja \
  -DLLVM_ENABLE_PROJECTS="clang" \
  -DLLVM_TARGETS_TO_BUILD="WebAssembly" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DLLVM_BUILD_TOOLS=OFF \
  -DLLVM_INCLUDE_TESTS=OFF \
  -DEMSCRIPTEN_EXTRA_LINK_FLAGS="-s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORTED_RUNTIME_METHODS=[FS,callMain]"

cmake --build build-wasm --target clang -j$(nproc)
```

**Classic format** (legacy Emscripten):
```bash
emcmake cmake -S llvm -B build-wasm -G Ninja \
  ...same flags... \
  -DEMSCRIPTEN_EXTRA_LINK_FLAGS="-s MODULARIZE=1 -s EXPORT_NAME=createClangModule -s EXPORTED_RUNTIME_METHODS=[FS,callMain]"
```

Copy the resulting `clang.js` and `clang.wasm` into `dist/clang/`.

> The binary will be large (~40–120 MB for clang.wasm).  You can also host it
> on a CDN and update the `BASE_URL` in `scripts/fetch-clang-wasm.js`.

---

## Known limitations

- **Binary size**: The Clang WASM binary is large; first load may take a few
  seconds.  Subsequent loads use the browser cache.
- **No network access**: Programs run in a sandboxed WASI environment with no
  socket support.
- **Standard library**: Only the subset of libc/libc++ compiled into the WASM
  sysroot is available.
- **Execution time**: Long-running programs may trigger the browser's "unresponsive
  script" dialog.  The compiler runs in a dedicated Web Worker to avoid blocking
  the UI.
- **Browser scope**: Full parity targets desktop Chrome, Edge, Brave, and
  Chromium. Firefox and Safari are outside the current release target.
- **Managed browsers**: Enterprise policies that block File System Access prompts
  prevent full local workspace read/write support.

---

## License

MIT
