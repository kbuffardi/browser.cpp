/**
 * scripts/fetch-clang-wasm.js
 *
 * Downloads the pre-built Emscripten-compiled Clang WASM binary
 * (clang.js + clang.wasm) from the wasm-clang release and places
 * both files in dist/clang/.
 *
 * Usage:
 *   npm run fetch-clang
 *
 * The binary is large (~60 MB for clang.wasm).  It is NOT bundled in the
 * repository; each developer fetches it once.  The extension's compiler
 * worker (dist/compiler.worker.js) loads these files at runtime.
 *
 * C++20 note:
 *   The default binary targets LLVM 14 which supports most of C++20.
 *   To build your own C++23-capable binary see README § "Building Clang WASM".
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── Configuration ─────────────────────────────────────────────────────────────
// Adjust VERSION and BASE_URL if you host your own build.
const BASE_URL = 'https://github.com/nicowillis/wasm-clang/releases/download/v0.1.0';
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
