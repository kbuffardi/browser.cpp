'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED = [
  { name: 'clang.js', type: 'js' },
  { name: 'clang.wasm', type: 'wasm' },
  { name: 'lld.js', type: 'js' },
  { name: 'lld.wasm', type: 'wasm' },
  { name: 'sysroot.tar', type: 'binary' },
];

const clangDir = path.resolve(__dirname, '..', 'dist', 'clang');

function hasWasmMagic(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, header, 0, 4, 0);
    return (
      bytesRead === 4 &&
      header[0] === 0x00 &&
      header[1] === 0x61 &&
      header[2] === 0x73 &&
      header[3] === 0x6d
    );
  } finally {
    fs.closeSync(fd);
  }
}

function validateArtifact({ name, type }) {
  const filePath = path.join(clangDir, name);
  if (!fs.existsSync(filePath)) {
    return `${name} is missing`;
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) {
    return `${name} is empty or not a regular file`;
  }

  if (type === 'wasm' && !hasWasmMagic(filePath)) {
    return `${name} is not a valid WASM binary`;
  }

  return null;
}

function main() {
  const errors = REQUIRED.map(validateArtifact).filter(Boolean);

  if (errors.length) {
    console.error('Clang WASM artifact preflight failed:');
    for (const err of errors) {
      console.error(`- ${err}`);
    }
    console.error('\nRun `npm run fetch-clang` before browser smoke tests or release packaging.');
    process.exit(1);
  }

  console.log(`Clang WASM artifact preflight passed (${clangDir}).`);
}

main();
