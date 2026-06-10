/**
 * scripts/fetch-clang-wasm.js
 *
 * Downloads the pre-built Emscripten-compiled Clang WASM binary
 * (clang.js + clang.wasm) and places both files in dist/clang/.
 *
 * Usage:
 *   npm run fetch-clang
 *
 * The binary is large (~43 MB for clang.wasm).  It is NOT bundled in the
 * repository; each developer fetches it once.  The extension's compiler
 * worker (dist/compiler.worker.js) loads these files at runtime.
 *
 * ── Default source ────────────────────────────────────────────────────────────
 * By default this script downloads from the "browsercc" NPM package
 * (github.com/BertalanD/browsercc), which ships a pre-built LLVM 20 Clang
 * compiled with Emscripten using -s MODULARIZE -s EXPORT_ES6.
 *
 * The compiler worker supports both classic (importScripts) and ES6 module
 * formats, so no extra configuration is needed.
 *
 * ── Using a custom binary ─────────────────────────────────────────────────────
 * Set BASE_URL below to point to your own host that serves clang.js and
 * clang.wasm.  Either build format is accepted by the worker:
 *   • ES6 module:  -s MODULARIZE -s EXPORT_ES6  (browsercc style)
 *   • Classic:     -s MODULARIZE=1 -s EXPORT_NAME=createClangModule
 *
 * ── Building from source ──────────────────────────────────────────────────────
 * See README § "Building Clang WASM from source".
 *
 * C++20 note:
 *   LLVM 14+ supports most of C++20; LLVM 20 (browsercc default) covers C++23.
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── Configuration ─────────────────────────────────────────────────────────────
// Default: browsercc NPM package (LLVM 20, Emscripten ES6 module format).
// Override with your own CDN/server URL if you host a custom binary.
const BASE_URL = 'https://unpkg.com/browsercc@0.1.1/dist';
const FILES    = ['clang.js', 'clang.wasm'];
const OUT_DIR  = path.resolve(__dirname, '..', 'dist', 'clang');

// ─────────────────────────────────────────────────────────────────────────────

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
