'use strict';

const fs = require('fs');
const path = require('path');

const {
  readJson,
  readProjectVersion,
} = require('./project-version');

function normalizeTagCandidates(version) {
  return new Set([version, `v${version}`]);
}

function validateReleaseVersionSync(options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const packagePath = path.join(repoRoot, 'package.json');
  const packageLockPath = path.join(repoRoot, 'package-lock.json');
  const sourceManifestPath = path.join(repoRoot, 'manifest.json');
  const distManifestPath = path.join(repoRoot, 'dist', 'manifest.json');
  const firefoxDistManifestPath = path.join(repoRoot, 'dist-firefox', 'manifest.json');

  const pkg = readJson(packagePath);
  const packageLock = readJson(packageLockPath);
  const sourceManifest = readJson(sourceManifestPath);
  const version = readProjectVersion({ repoRoot });
  const errors = [];

  if (pkg.version !== version) {
    errors.push(
      `manifest.json version (${version}) does not match package.json version (${pkg.version}).`
    );
  }

  if (packageLock.version !== version) {
    errors.push(
      `manifest.json version (${version}) does not match package-lock.json version (${packageLock.version}).`
    );
  }

  const rootPackageVersion = packageLock.packages && packageLock.packages['']
    ? packageLock.packages[''].version
    : undefined;
  if (rootPackageVersion !== version) {
    errors.push(
      `manifest.json version (${version}) does not match package-lock.json packages[""].version (${rootPackageVersion ?? 'missing'}).`
    );
  }

  let distManifest = null;
  if (fs.existsSync(distManifestPath)) {
    distManifest = readJson(distManifestPath);
    if (distManifest.version !== version) {
      errors.push(
        `dist/manifest.json version (${distManifest.version}) does not match manifest.json version (${version}).`
      );
    }
  }

  let firefoxDistManifest = null;
  if (fs.existsSync(firefoxDistManifestPath)) {
    firefoxDistManifest = readJson(firefoxDistManifestPath);
    if (firefoxDistManifest.version !== version) {
      errors.push(
        `dist-firefox/manifest.json version (${firefoxDistManifest.version}) does not match manifest.json version (${version}).`
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
    packageLockPath,
    sourceManifestPath,
    distManifestPath: fs.existsSync(distManifestPath) ? distManifestPath : null,
    releaseTag,
    sourceManifestVersion: sourceManifest.version,
    packageVersion: pkg.version,
    packageLockVersion: packageLock.version,
    packageLockRootVersion: rootPackageVersion ?? null,
    distManifestVersion: distManifest ? distManifest.version : null,
    firefoxDistManifestVersion: firefoxDistManifest ? firefoxDistManifest.version : null,
  };
}

function main() {
  const result = validateReleaseVersionSync();
  const checkedDist = [
    result.distManifestPath ? 'dist/manifest.json' : null,
    result.firefoxDistManifestVersion ? 'dist-firefox/manifest.json' : null,
  ].filter(Boolean);
  console.log(
    `Release version sync passed for ${result.version} (manifest.json, package.json, package-lock.json${checkedDist.length ? `, ${checkedDist.join(', ')}` : ''}).`
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
