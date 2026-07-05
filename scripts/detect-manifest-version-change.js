'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

function readManifestVersion(repoRoot, ref) {
  const output = execFileSync('git', ['-C', repoRoot, 'show', `${ref}:manifest.json`], {
    encoding: 'utf8',
  });
  const manifest = JSON.parse(output);

  if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    throw new Error(`manifest.json at ${ref} does not contain a valid version string.`);
  }

  return manifest.version;
}

function detectManifestVersionChange(options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const baseRef = options.baseRef || process.env.GITHUB_BASE_SHA || process.env.BASE_REF;
  const headRef = options.headRef || process.env.GITHUB_SHA || 'HEAD';

  if (!baseRef) {
    throw new Error('A base ref is required to detect manifest version changes.');
  }

  const baseVersion = readManifestVersion(repoRoot, baseRef);
  const headVersion = readManifestVersion(repoRoot, headRef);

  return {
    changed: baseVersion !== headVersion,
    baseRef,
    headRef,
    baseVersion,
    headVersion,
  };
}

function main() {
  const result = detectManifestVersionChange({
    baseRef: process.argv[2],
    headRef: process.argv[3],
  });

  if (process.argv.includes('--github-output')) {
    process.stdout.write(
      `changed=${result.changed}\nbase_version=${result.baseVersion}\nhead_version=${result.headVersion}\n`
    );
    return;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
  detectManifestVersionChange,
  readManifestVersion,
};
