# browser.cpp

An in-browser **C++20 IDE** delivered as a Chrome / Chromium extension.

| Feature | Detail |
|---------|--------|
| Editor | Monaco Editor (the engine behind VS Code) |
| Compiler | WASM-native Clang (runs entirely in the browser, offline) |
| Terminal | xterm.js with a bash-like shell (`g++`, `./a.out`, `ls`, `cat`, …) |
| File access | File System Access API – open & save files on your local drive |
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

### 4 – Load in Chrome

1. Open **chrome://extensions**
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
│   │   └── service-worker.js      MV3 background worker (opens IDE tab)
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
└── dist/                          ← Load this folder as an unpacked extension
    ├── manifest.json
    ├── index.html
    ├── bundle.js
    ├── service-worker.js
    ├── compiler.worker.js
    ├── editor.worker.js            (emitted by monaco-editor-webpack-plugin)
    ├── ts.worker.js                (emitted by monaco-editor-webpack-plugin)
    ├── icons/
    └── clang/
        ├── clang.js               (downloaded by npm run fetch-clang)
        └── clang.wasm             (downloaded by npm run fetch-clang)
```

### Compile & run pipeline

```
Editor source
    │  postMessage {type:'compile', source, std}
    ▼
compiler.worker.js  ──importScripts──▶  dist/clang/clang.js
    │                                        │
    │  callMain(['--target=wasm32-wasi', …])  │
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
| `g++ [flags] [-std=c++NN] [-o out]` | Compile current editor source |
| `./a.out` | Run the last compiled binary |
| `clear` | Clear the terminal |
| `echo <text>` | Print text |
| `ls [-R] [dir]` | List files/folders from the opened workspace folder |
| `cd [dir]` | Change the current workspace directory |
| `cat <file>` | Print file contents |
| `pwd` | Print working directory |
| `help` | Show command list |

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
- **Firefox**: Manifest V3 support in Firefox is partial; the extension targets
  Chromium-based browsers.

---

## License

MIT
