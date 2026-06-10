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
const CLANG_JS_FILE   = 'clang.js';
const CLANG_WASM_FILE = 'clang.wasm';
const FILES           = [CLANG_JS_FILE, CLANG_WASM_FILE];
const OUT_DIR  = path.resolve(__dirname, '..', 'dist', 'clang');

// ─────────────────────────────────────────────────────────────────────────────

fs.mkdirSync(OUT_DIR, { recursive: true });

function download(url, dest) {
  return new Promise((resolve, reject) => {
    let received = 0;
    let completed = false;

    function done(err) {
      if (completed) return;
      completed = true;
      if (err) {
        fs.unlink(dest, (unlinkErr) => {
          if (unlinkErr && unlinkErr.code !== 'ENOENT') {
            console.warn(`Warning: failed to remove ${dest}: ${unlinkErr.message}`);
          }
          reject(err);
        });
      } else {
        resolve();
      }
    }

    function get(urlStr) {
      https.get(urlStr, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
          done(new Error(`HTTP ${res.statusCode} for ${urlStr}`));
          return;
        }

        const file = fs.createWriteStream(dest);
        const total = parseInt(res.headers['content-length'] || '0', 10);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total) {
            const pct = ((received / total) * 100).toFixed(1);
            process.stdout.write(`\r  ${path.basename(dest)}  ${pct}%   `);
          }
        });
        res.on('error', (err) => done(err));
        file.on('error', (err) => done(err));
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          process.stdout.write('\n');
          done();
        });
      }).on('error', (err) => done(err));
    }

    get(url);
  });
}

function hasWasmMagic(dest) {
  let fd = null;
  try {
    fd = fs.openSync(dest, 'r');
    const header = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, header, 0, 4, 0);
    return (
      bytesRead === 4 &&
      header[0] === 0x00 &&
      header[1] === 0x61 &&
      header[2] === 0x73 &&
      header[3] === 0x6d
    );
  } catch (_) {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function hasNonEmptyFile(dest) {
  try {
    return fs.statSync(dest).size > 0;
  } catch (_) {
    return false;
  }
}

function isValidExistingArtifact(file, dest) {
  if (!fs.existsSync(dest)) return false;
  if (!hasNonEmptyFile(dest)) return false;
  if (file === CLANG_WASM_FILE) return hasWasmMagic(dest);
  return true;
}

/**
 * Patch clang.js if it was built in ES6 module format (-s EXPORT_ES6).
 *
 * Emscripten's EXPORT_ES6 output uses two constructs that are illegal in a
 * classic Web Worker loaded via importScripts():
 *
 *   • import.meta.url  – replaced with '' (the compiler worker always
 *                        supplies locateFile(), so _scriptName is unused)
 *   • export default … – replaced with a self.createClangModule assignment
 *                        that the compiler worker expects
 *
 * Classic format builds (-s MODULARIZE=1 -s EXPORT_NAME=createClangModule)
 * already set self.createClangModule and have no ES6 syntax, so the function
 * is a no-op for them.
 */
function patchClangJs(dest) {
  let src = fs.readFileSync(dest, 'utf8');

  // Only patch files that actually use ES6 module syntax.
  if (!src.includes('import.meta') && !src.includes('export default')) return;

  const before = src;

  // Replace every import.meta.url reference with an empty string.
  // All five occurrences in the browsercc build are either:
  //   – inside ENVIRONMENT_IS_NODE blocks (never executed in a worker), or
  //   – inside findWasmBinary() which is short-circuited when locateFile() is
  //     provided (which the compiler worker always does), or
  //   – the top-level _scriptName assignment whose value is unused when
  //     locateFile() is provided.
  src = src.replaceAll('import.meta.url', "''");

  // Convert the ES6 default export into a classic global assignment.
  // The compiler worker looks for self.createClangModule after importScripts().
  src = src.replace(
    /^export default (\w+);?\s*$/m,
    'if (typeof self !== "undefined") { self.createClangModule = $1; }'
  );

  if (src !== before) {
    fs.writeFileSync(dest, src, 'utf8');
    console.log(`  Patched ${path.basename(dest)} for importScripts() compatibility.`);
  }
}

(async () => {
  console.log(`Downloading Clang WASM binaries to dist/clang/ …\n`);
  for (const file of FILES) {
    const url  = `${BASE_URL}/${file}`;
    const dest = path.join(OUT_DIR, file);

    if (!isValidExistingArtifact(file, dest)) {
      if (fs.existsSync(dest)) {
        console.log(`  ${file} present but invalid/corrupted, re-downloading.`);
        fs.unlinkSync(dest);
      }
      console.log(`  ↓ ${url}`);
      await download(url, dest);
    } else {
      console.log(`  ${file} already present, skipping download.`);
    }

    if (file === CLANG_JS_FILE) {
      patchClangJs(dest);
    } else if (file === CLANG_WASM_FILE && !hasWasmMagic(dest)) {
      throw new Error(
        `Downloaded clang.wasm is invalid at ${dest}. ` +
        'Delete dist/clang/ and run npm run fetch-clang again.'
      );
    }
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
