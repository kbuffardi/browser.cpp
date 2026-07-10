'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function resolveWebExtCommand() {
  if (process.env.WEB_EXT_BIN) {
    return { command: process.env.WEB_EXT_BIN, args: [] };
  }
  return { command: 'npx', args: ['--yes', 'web-ext'] };
}

function ensureFirefoxBuild(repoRoot) {
  const manifestPath = path.join(repoRoot, 'dist-firefox', 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('dist-firefox/manifest.json is missing. Run `npm run build` first.');
  }
  return manifestPath;
}

function validateAmoCredentials(env = process.env) {
  const apiKey = env.AMO_JWT_ISSUER;
  const apiSecret = env.AMO_JWT_SECRET;

  if (typeof apiKey !== 'string' || !/\S/.test(apiKey)) {
    throw new Error('AMO_JWT_ISSUER is required to sign a Firefox package.');
  }
  if (typeof apiSecret !== 'string' || !/\S/.test(apiSecret)) {
    throw new Error('AMO_JWT_SECRET is required to sign a Firefox package.');
  }

  return { apiKey, apiSecret };
}

function runWebExt(args, options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const { command, args: prefixArgs } = resolveWebExtCommand();
  const result = spawnSync(command, [...prefixArgs, ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...options.env,
    },
  });

  if (result.status !== 0) {
    throw new Error(`web-ext exited with status ${result.status ?? 'unknown'}.`);
  }
}

function updateReleaseManifest(repoRoot, mutate) {
  const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8')).version;
  const releaseManifestPath = path.join(repoRoot, 'release', `release-manifest-v${version}.json`);
  if (!fs.existsSync(releaseManifestPath)) return null;

  const manifest = JSON.parse(fs.readFileSync(releaseManifestPath, 'utf8'));
  mutate(manifest);
  fs.writeFileSync(releaseManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return releaseManifestPath;
}

module.exports = {
  ensureFirefoxBuild,
  validateAmoCredentials,
  runWebExt,
  updateReleaseManifest,
};
