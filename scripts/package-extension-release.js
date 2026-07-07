'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { validateReleaseVersionSync } = require('./check-release-version-sync');
const { BASE_URL, FILES } = require('./fetch-clang-wasm');
const {
  getArtifactFileName,
  getPublishableReleaseTargets,
  getReleaseTargets,
} = require('./release-targets');

const NORMALIZED_ZIP_DATE = new Date('2024-01-01T00:00:00Z');
const TARGETS = getReleaseTargets();

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
  const year = Math.max(date.getUTCFullYear(), 1980);
  const dosTime =
    (date.getUTCHours() << 11) |
    (date.getUTCMinutes() << 5) |
    Math.floor(date.getUTCSeconds() / 2);
  const dosDate =
    ((year - 1980) << 9) |
    ((date.getUTCMonth() + 1) << 5) |
    date.getUTCDate();
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
      result.push({ fullPath, relPath });
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

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function buildZipBuffer(files, normalizedDate = NORMALIZED_ZIP_DATE) {
  const localParts = [];
  const centralParts = [];
  const { dosTime, dosDate } = dosDateTime(normalizedDate);
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.relPath, 'utf8');
    const source = fs.readFileSync(file.fullPath);
    const compressed = zlib.deflateRawSync(source, { level: 9 });
    const checksum = crc32(source);

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

  return Buffer.concat([...localParts, ...centralParts, endRecord]);
}

function getCommitSha(repoRoot) {
  const headPath = path.join(repoRoot, '.git', 'HEAD');
  if (!fs.existsSync(headPath)) return null;

  const head = fs.readFileSync(headPath, 'utf8').trim();
  if (!head.startsWith('ref: ')) return head || null;

  const refPath = path.join(repoRoot, '.git', head.slice(5));
  if (fs.existsSync(refPath)) {
    return fs.readFileSync(refPath, 'utf8').trim() || null;
  }
  return null;
}

function createReleaseArtifacts(options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const distDir = options.distDir || path.join(repoRoot, 'dist');
  const releaseDir = options.releaseDir || path.join(repoRoot, 'release');
  const manifestPath = path.join(distDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error('dist/manifest.json is missing. Run `npm run build` before packaging.');
  }

  const versionResult = validateReleaseVersionSync({
    repoRoot,
    releaseTag: options.releaseTag,
  });
  const files = collectFiles(distDir);
  const zipBuffer = buildZipBuffer(files, options.normalizedDate || NORMALIZED_ZIP_DATE);
  const sharedSha256 = sha256(zipBuffer);
  const publishableTargets = getPublishableReleaseTargets();

  fs.mkdirSync(releaseDir, { recursive: true });

  const artifacts = publishableTargets.map((target) => {
    const fileName = getArtifactFileName(target, versionResult.version);
    const filePath = path.join(releaseDir, fileName);
    fs.writeFileSync(filePath, zipBuffer);
    return {
      target: target.key,
      label: target.label,
      channel: target.channel,
      notes: target.notes,
      packageStrategy: target.packageStrategy,
      payloadGroup: target.payloadGroup,
      fileName,
      filePath,
      bytes: zipBuffer.length,
      sha256: sharedSha256,
      sharedPayload: true,
    };
  });

  const checksumPath = path.join(releaseDir, `SHA256SUMS-v${versionResult.version}.txt`);
  const checksumBody = artifacts
    .map((artifact) => `${artifact.sha256}  ${artifact.fileName}`)
    .join('\n');
  fs.writeFileSync(checksumPath, `${checksumBody}\n`, 'utf8');

  const releaseManifestPath = path.join(
    releaseDir,
    `release-manifest-v${versionResult.version}.json`
  );
  const releaseManifest = {
    version: versionResult.version,
    generatedAt: new Date().toISOString(),
    commitSha: options.commitSha || getCommitSha(repoRoot),
    nodeVersion: process.version,
    sourceManifestVersion: versionResult.sourceManifestVersion,
    packageVersion: versionResult.packageVersion,
    packageLockVersion: versionResult.packageLockVersion,
    packageLockRootVersion: versionResult.packageLockRootVersion,
    distManifestVersion: versionResult.distManifestVersion,
    normalizedZipDate: (options.normalizedDate || NORMALIZED_ZIP_DATE).toISOString(),
    toolchain: {
      baseUrl: BASE_URL,
      files: FILES.map((file) => file.name),
    },
    targets: TARGETS.map((target) => ({
      target: target.key,
      label: target.label,
      channel: target.channel,
      packageStrategy: target.packageStrategy,
      payloadGroup: target.payloadGroup,
      publishable: target.publishable,
      blockReason: target.blockReason || null,
      notes: target.notes,
      fileName: target.publishable ? getArtifactFileName(target, versionResult.version) : null,
    })),
    artifacts: artifacts.map((artifact) => ({
      target: artifact.target,
      label: artifact.label,
      channel: artifact.channel,
      notes: artifact.notes,
      packageStrategy: artifact.packageStrategy,
      payloadGroup: artifact.payloadGroup,
      fileName: artifact.fileName,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      sharedPayload: artifact.sharedPayload,
    })),
  };
  fs.writeFileSync(releaseManifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, 'utf8');

  return {
    version: versionResult.version,
    releaseDir,
    files,
    artifacts,
    checksumPath,
    releaseManifestPath,
  };
}

function main() {
  const result = createReleaseArtifacts();
  for (const artifact of result.artifacts) {
    console.log(
      `Created ${path.relative(result.releaseDir, artifact.filePath)} (${result.files.length} files, sha256 ${artifact.sha256.slice(0, 12)}...).`
    );
  }
  console.log(`Created ${path.basename(result.checksumPath)}.`);
  console.log(`Created ${path.basename(result.releaseManifestPath)}.`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  TARGETS,
  NORMALIZED_ZIP_DATE,
  buildZipBuffer,
  collectFiles,
  createReleaseArtifacts,
};
