import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ensureFirefoxBuild, runWebExt } = require('./firefox-webext.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  ensureFirefoxBuild(repoRoot);

  const apiKey = process.env.AMO_JWT_ISSUER;
  const apiSecret = process.env.AMO_JWT_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('AMO_JWT_ISSUER and AMO_JWT_SECRET are required to sign the Firefox listed package.');
  }

  const metadataPath = path.join(repoRoot, 'amo', 'metadata', 'listed.json');
  if (!fs.existsSync(metadataPath)) {
    throw new Error('amo/metadata/listed.json is missing.');
  }

  const artifactsDir = path.join(repoRoot, 'release', 'firefox-listed');
  fs.mkdirSync(artifactsDir, { recursive: true });

  runWebExt([
    'sign',
    '--channel',
    'listed',
    '--source-dir',
    path.join(repoRoot, 'dist-firefox'),
    '--artifacts-dir',
    artifactsDir,
    '--api-key',
    apiKey,
    '--api-secret',
    apiSecret,
  ], { repoRoot });

  console.log(`Prepared Firefox listed signing output in ${path.relative(repoRoot, artifactsDir)}.`);
  console.log('Public AMO publication remains a manual owner-managed step.');
}

main();
