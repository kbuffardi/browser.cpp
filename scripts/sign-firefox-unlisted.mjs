import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  ensureFirefoxBuild,
  runWebExt,
  updateReleaseManifest,
} = require('./firefox-webext.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8')).version;

function findSignedArtifact(dir) {
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  return entries.find((entry) => entry.endsWith('.xpi')) || null;
}

function main() {
  ensureFirefoxBuild(repoRoot);

  const apiKey = process.env.AMO_JWT_ISSUER;
  const apiSecret = process.env.AMO_JWT_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('AMO_JWT_ISSUER and AMO_JWT_SECRET are required to sign the Firefox unlisted XPI.');
  }

  const artifactsDir = path.join(repoRoot, 'release', 'firefox-unlisted');
  fs.mkdirSync(artifactsDir, { recursive: true });

  runWebExt([
    'sign',
    '--channel',
    'unlisted',
    '--source-dir',
    path.join(repoRoot, 'dist-firefox'),
    '--artifacts-dir',
    artifactsDir,
    '--api-key',
    apiKey,
    '--api-secret',
    apiSecret,
  ], { repoRoot });

  const signedArtifact = findSignedArtifact(artifactsDir);
  updateReleaseManifest(repoRoot, (manifest) => {
    const firefoxTarget = manifest.targets.find((target) => target.target === 'firefox');
    if (firefoxTarget?.signing) {
      firefoxTarget.signing.unlistedSigned = !!signedArtifact;
      firefoxTarget.signing.unlistedArtifactFileName = signedArtifact;
    }
  });

  if (!signedArtifact) {
    throw new Error('Firefox signing completed without a signed .xpi artifact.');
  }

  console.log(`Signed Firefox unlisted artifact: release/firefox-unlisted/${signedArtifact}`);
  console.log(`Release version: ${version}`);
}

main();
