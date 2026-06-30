'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');
const releaseDir = path.join(repoRoot, 'release');
const pkg = require(path.join(repoRoot, 'package.json'));

const TARGETS = ['chromium', 'edge'];

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const dosDate =
    ((year - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { dosTime, dosDate };
}

function collectFiles(dir, prefix = '') {
  const result = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const fullPath = path.join(dir, name);
    const relPath = prefix ? `${prefix}/${name}` : name;
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      result.push(...collectFiles(fullPath, relPath));
    } else if (stat.isFile()) {
      result.push({ fullPath, relPath, stat });
    }
  }
  return result;
}

function writeUInt16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function writeUInt32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function createZip(files, outPath) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.relPath, 'utf8');
    const source = fs.readFileSync(file.fullPath);
    const compressed = zlib.deflateRawSync(source, { level: 9 });
    const checksum = crc32(source);
    const { dosTime, dosDate } = dosDateTime(file.stat.mtime);

    const localHeader = Buffer.concat([
      writeUInt32(0x04034b50),
      writeUInt16(20),
      writeUInt16(0x0800),
      writeUInt16(8),
      writeUInt16(dosTime),
      writeUInt16(dosDate),
      writeUInt32(checksum),
      writeUInt32(compressed.length),
      writeUInt32(source.length),
      writeUInt16(nameBuffer.length),
      writeUInt16(0),
      nameBuffer,
    ]);
    localParts.push(localHeader, compressed);

    const centralHeader = Buffer.concat([
      writeUInt32(0x02014b50),
      writeUInt16(20),
      writeUInt16(20),
      writeUInt16(0x0800),
      writeUInt16(8),
      writeUInt16(dosTime),
      writeUInt16(dosDate),
      writeUInt32(checksum),
      writeUInt32(compressed.length),
      writeUInt32(source.length),
      writeUInt16(nameBuffer.length),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(0),
      writeUInt32(offset),
      nameBuffer,
    ]);
    centralParts.push(centralHeader);

    offset += localHeader.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endRecord = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(files.length),
    writeUInt16(files.length),
    writeUInt32(centralSize),
    writeUInt32(offset),
    writeUInt16(0),
  ]);

  fs.writeFileSync(outPath, Buffer.concat([...localParts, ...centralParts, endRecord]));
}

function main() {
  const manifestPath = path.join(distDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('dist/manifest.json is missing. Run `npm run build` before packaging.');
    process.exit(1);
  }

  fs.mkdirSync(releaseDir, { recursive: true });
  const files = collectFiles(distDir);
  for (const target of TARGETS) {
    const outPath = path.join(releaseDir, `browser-cpp-${target}-v${pkg.version}.zip`);
    createZip(files, outPath);
    console.log(`Created ${path.relative(repoRoot, outPath)} (${files.length} files).`);
  }
}

main();
