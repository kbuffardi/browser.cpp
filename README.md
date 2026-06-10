# browser.cpp

An in-browser **C++20 IDE** delivered as a Chrome / Chromium extension.

| Feature | Detail |
|---------|--------|
| Editor | Monaco Editor (the engine behind VS Code) |
| Compiler | WASM-native Clang (runs entirely in the browser, offline) |
| Terminal | xterm.js with a bash-like shell (`g++`, `./a.out`, `ls`, `cat`, …) |
| File access | File System Access API – open & save files on your local drive |
| Standards | C++14 · C++17 · **C++20** (selectable in the toolbar) |

---

## Quick start

### 1 – Install Node dependencies

```bash
npm install
```

### 2 – Obtain the Clang WASM binary

The compiler binary is **not** shipped in this repository (it is ~60 MB).
You need to either build it from source or host it yourself and configure the
download URL.

**Build from source** (recommended — see [§ Building Clang WASM from source](#building-clang-wasm-from-source)):
```bash
# After building, copy the output to dist/clang/
cp build-wasm/bin/clang.js build-wasm/bin/clang.wasm dist/clang/
```

**Or configure a download URL** — set `BASE_URL` in `scripts/fetch-clang-wasm.js`
to a host that serves `clang.js` and `clang.wasm` built with
`-s MODULARIZE=1 -s EXPORT_NAME=createClangModule`, then run:
```bash
npm run fetch-clang
```

### 3 – Build the extension

```bash
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

## Keyboard shortcuts

| Action | Shortcut |
|--------|----------|
| Compile & Run | **F5** |
| Compile only | **Ctrl+Shift+B** |
| Run (last build) | **Ctrl+Shift+R** |
| Save | **Ctrl+S** |
| Open | **Ctrl+O** |
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
| `ls` | List virtual files |
| `cat <file>` | Print file contents |
| `pwd` | Print working directory |
| `help` | Show command list |

---

## Building Clang WASM from source

For **C++20 / C++23** support with the latest LLVM:

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
  -DEMSCRIPTEN_EXTRA_LINK_FLAGS="-s MODULARIZE=1 -s EXPORT_NAME=createClangModule"

cmake --build build-wasm --target clang -j$(nproc)
```

Copy the resulting `clang.js` and `clang.wasm` into `dist/clang/`.

> The binary will be large (~60–120 MB for clang.wasm).  Consider hosting it
> on a CDN and updating the URL in `scripts/fetch-clang-wasm.js`.

---

## Known limitations

- **Binary size**: The Clang WASM binary is large; first load may take a few
  seconds.  Subsequent loads use the browser cache.
- **stdin**: Programs that read from `std::cin` will receive EOF immediately.
  Interactive keyboard input via the terminal is not yet supported.
- **No network access**: Programs run in a sandboxed WASI environment with no
  socket or file-I/O beyond stdin/stdout/stderr.
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
