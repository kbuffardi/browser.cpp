/**
 * scripts/fetch-clang-wasm.js
 *
 * Downloads the pre-built Emscripten-compiled Clang WASM binary
 * (clang.js + clang.wasm) from a release URL and places
 * both files in dist/clang/.
 *
 * Usage:
 *   npm run fetch-clang
 *
 * The binary is large (~60 MB for clang.wasm).  It is NOT bundled in the
 * repository; each developer fetches it once.  The extension's compiler
 * worker (dist/compiler.worker.js) loads these files at runtime.
 *
 * ── Building your own binary ──────────────────────────────────────────────────
 * If you don't have a pre-built binary, build one from source:
 *
 *   git clone https://github.com/llvm/llvm-project
 *   cd llvm-project
 *   emcmake cmake -S llvm -B build-wasm -G Ninja \
 *     -DLLVM_ENABLE_PROJECTS="clang" \
 *     -DLLVM_TARGETS_TO_BUILD="WebAssembly" \
 *     -DCMAKE_BUILD_TYPE=MinSizeRel \
 *     -DLLVM_BUILD_TOOLS=OFF \
 *     -DLLVM_INCLUDE_TESTS=OFF \
 *     -DEMSCRIPTEN_EXTRA_LINK_FLAGS="-s MODULARIZE=1 -s EXPORT_NAME=createClangModule"
 *   cmake --build build-wasm --target clang -j$(nproc)
 *
 * Copy the resulting clang.js and clang.wasm into dist/clang/.
 *
 * Alternatively, supply your own BASE_URL below pointing to a host that serves
 * clang.js and clang.wasm built with the flags above.
 *
 * C++20 note:
 *   LLVM 14+ supports most of C++20.
 *   To build your own C++23-capable binary see README § "Building Clang WASM".
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── Configuration ─────────────────────────────────────────────────────────────
// Set BASE_URL to your own host that serves clang.js and clang.wasm built with
//   -s MODULARIZE=1 -s EXPORT_NAME=createClangModule
// Leave empty to skip the download and build from source instead (see above).
const BASE_URL = '';
const FILES    = ['clang.js', 'clang.wasm'];
const OUT_DIR  = path.resolve(__dirname, '..', 'dist', 'clang');

// ─────────────────────────────────────────────────────────────────────────────

if (!BASE_URL) {
  console.error(
    '\nNo pre-built Clang WASM binary URL is configured.\n\n' +
    'Options:\n' +
    '  1. Set BASE_URL in scripts/fetch-clang-wasm.js to point to a host\n' +
    '     that serves clang.js + clang.wasm built with:\n' +
    '       -s MODULARIZE=1 -s EXPORT_NAME=createClangModule\n\n' +
    '  2. Build the binary yourself and copy it to dist/clang/:\n' +
    '     See README § "Building Clang WASM from source" for instructions.\n'
  );
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let received = 0;

    function get(urlStr) {
      https.get(urlStr, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${urlStr}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total) {
            const pct = ((received / total) * 100).toFixed(1);
            process.stdout.write(`\r  ${path.basename(dest)}  ${pct}%   `);
          }
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          process.stdout.write('\n');
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    }

    get(url);
  });
}

(async () => {
  console.log(`Downloading Clang WASM binaries to dist/clang/ …\n`);
  for (const file of FILES) {
    const url  = `${BASE_URL}/${file}`;
    const dest = path.join(OUT_DIR, file);
    if (fs.existsSync(dest)) {
      console.log(`  ${file} already present, skipping.`);
      continue;
    }
    console.log(`  ↓ ${url}`);
    await download(url, dest);
  }
  console.log('\nDone. You can now run `npm run build` to bundle the extension.');
})().catch((err) => {
  console.error('\nError:', err.message);
  console.error(
    '\nIf the URL is no longer valid, build your own Clang WASM binary.\n' +
    'See README § "Building Clang WASM from source".'
  );
  process.exit(1);
});
