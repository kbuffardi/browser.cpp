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

// Each entry describes one file to fetch.
//   name        – filename in dist/clang/
//   isWasm      – validate WASM magic bytes after download
//   globalName  – if set, patch this ES6 module to expose self.<globalName>
//                 so it can be loaded via importScripts() in a classic worker
const FILES = [
  { name: 'clang.js',    isWasm: false, globalName: 'createClangModule' },
  { name: 'clang.wasm',  isWasm: true,  globalName: null               },
  { name: 'lld.js',      isWasm: false, globalName: 'createLLDModule'  },
  { name: 'lld.wasm',    isWasm: true,  globalName: null               },
  { name: 'sysroot.tar', isWasm: false, globalName: null               },
];

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

function isValidExistingArtifact({ isWasm }, dest) {
  if (!fs.existsSync(dest)) return false;
  if (!hasNonEmptyFile(dest)) return false;
  if (isWasm) return hasWasmMagic(dest);
  return true;
}

/**
 * Patch a JS file built in ES6 module format (-s EXPORT_ES6) so it can be
 * loaded via importScripts() in a classic Web Worker.
 *
 * Emscripten's EXPORT_ES6 output uses two constructs that are illegal in a
 * classic worker:
 *
 *   • import.meta.url  – replaced with '' (the worker always supplies
 *                        locateFile(), so _scriptName is unused)
 *   • export default … – replaced with a self.<globalName> assignment
 *                        that compiler.worker.js reads after importScripts()
 *
 * Classic format builds (-s MODULARIZE=1 -s EXPORT_NAME=...) already set a
 * global and have no ES6 syntax, so this function is a no-op for them.
 */
function patchJsFile(dest, globalName) {
  let src = fs.readFileSync(dest, 'utf8');

  // Only patch files that actually use ES6 module syntax.
  if (!src.includes('import.meta') && !src.includes('export default')) return;

  const before = src;

  // Replace every import.meta.url reference with an empty string.
  src = src.replaceAll('import.meta.url', "''");

  // Convert the ES6 default export into a classic global assignment.
  src = src.replace(
    /^export default (\w+);?\s*$/m,
    `if (typeof self !== "undefined") { self.${globalName} = $1; }`
  );

  if (src !== before) {
    fs.writeFileSync(dest, src, 'utf8');
    console.log(`  Patched ${path.basename(dest)} (self.${globalName}) for importScripts() compatibility.`);
  }
}

async function main() {
  console.log(`Downloading Clang WASM binaries to dist/clang/ …\n`);
  for (const entry of FILES) {
    const { name, isWasm, globalName } = entry;
    const url  = `${BASE_URL}/${name}`;
    const dest = path.join(OUT_DIR, name);

    if (!isValidExistingArtifact(entry, dest)) {
      if (fs.existsSync(dest)) {
        console.log(`  ${name} present but invalid/corrupted, re-downloading.`);
        fs.unlinkSync(dest);
      }
      console.log(`  ↓ ${url}`);
      await download(url, dest);
    } else {
      console.log(`  ${name} already present, skipping download.`);
    }

    if (globalName) {
      patchJsFile(dest, globalName);
    } else if (isWasm && !hasWasmMagic(dest)) {
      throw new Error(
        `Downloaded ${name} is invalid at ${dest}. ` +
        'Delete dist/clang/ and run npm run fetch-clang again.'
      );
    }
  }
  console.log('\nDone. You can now run `npm run build` to bundle the extension.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\nError:', err.message);
    console.error(
      '\nIf the URL is no longer valid, build your own Clang WASM binary.\n' +
      'See README § "Building Clang WASM from source".'
    );
    process.exit(1);
  });
}

module.exports = {
  BASE_URL,
  FILES,
  OUT_DIR,
  main,
};
