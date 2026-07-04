'use strict';

const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeTagCandidates(version) {
  return new Set([version, `v${version}`]);
}

function validateReleaseVersionSync(options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const packagePath = path.join(repoRoot, 'package.json');
  const sourceManifestPath = path.join(repoRoot, 'manifest.json');
  const distManifestPath = path.join(repoRoot, 'dist', 'manifest.json');

  const pkg = readJson(packagePath);
  const sourceManifest = readJson(sourceManifestPath);
  const version = pkg.version;
  const errors = [];

  if (sourceManifest.version !== version) {
    errors.push(
      `package.json version (${version}) does not match manifest.json version (${sourceManifest.version}).`
    );
  }

  let distManifest = null;
  if (fs.existsSync(distManifestPath)) {
    distManifest = readJson(distManifestPath);
    if (distManifest.version !== version) {
      errors.push(
        `dist/manifest.json version (${distManifest.version}) does not match package.json version (${version}).`
      );
    }
  }

  const releaseTag =
    options.releaseTag ||
    process.env.RELEASE_TAG ||
    (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null);
  if (releaseTag && !normalizeTagCandidates(version).has(releaseTag)) {
    errors.push(`Release tag (${releaseTag}) does not match version ${version}. Expected ${version} or v${version}.`);
  }

  if (errors.length) {
    const err = new Error(errors.join('\n'));
    err.details = errors;
    throw err;
  }

  return {
    version,
    packagePath,
    sourceManifestPath,
    distManifestPath: fs.existsSync(distManifestPath) ? distManifestPath : null,
    releaseTag,
    sourceManifestVersion: sourceManifest.version,
    distManifestVersion: distManifest ? distManifest.version : null,
  };
}

function main() {
  const result = validateReleaseVersionSync();
  const checkedDist = result.distManifestPath ? ' and dist/manifest.json' : '';
  console.log(
    `Release version sync passed for ${result.version} (package.json, manifest.json${checkedDist}).`
  );
  if (result.releaseTag) {
    console.log(`Release tag ${result.releaseTag} matches version ${result.version}.`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('Release version sync failed:');
    for (const detail of err.details || [err.message]) {
      console.error(`- ${detail}`);
    }
    process.exit(1);
  }
}

module.exports = {
  validateReleaseVersionSync,
};
