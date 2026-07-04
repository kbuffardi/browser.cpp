import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { validateReleaseVersionSync } = require('./check-release-version-sync.js');
const { cleanReleaseWorkspace } = require('./clean-release-workspace.js');
const {
  TARGETS,
  createReleaseArtifacts,
} = require('./package-extension-release.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function makeRepoFixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-cpp-release-'));
  writeJson(path.join(repoRoot, 'package.json'), {
    name: 'browser.cpp',
    version: '1.2.3',
  });
  writeJson(path.join(repoRoot, 'manifest.json'), {
    manifest_version: 3,
    name: 'browser.cpp',
    version: '1.2.3',
  });
  writeJson(path.join(repoRoot, 'dist', 'manifest.json'), {
    manifest_version: 3,
    name: 'browser.cpp',
    version: '1.2.3',
  });
  fs.writeFileSync(path.join(repoRoot, 'dist', 'bundle.js'), 'console.log("bundle");\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'dist', 'styles.css'), 'body{color:#fff;}\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'dist', 'icons'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'dist', 'icons', 'icon16.png'), 'icon', 'utf8');
  return repoRoot;
}

test('e2e: release version sync fails on source manifest mismatch', () => {
  const repoRoot = makeRepoFixture();
  writeJson(path.join(repoRoot, 'manifest.json'), {
    manifest_version: 3,
    name: 'browser.cpp',
    version: '9.9.9',
  });

  assert.throws(
    () => validateReleaseVersionSync({ repoRoot }),
    /package\.json version \(1\.2\.3\) does not match manifest\.json version \(9\.9\.9\)/
  );
});

test('e2e: clean release workspace removes stale dist and release outputs', () => {
  const repoRoot = makeRepoFixture();
  fs.writeFileSync(path.join(repoRoot, 'dist', 'stale.txt'), 'stale\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'release'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'release', 'old.zip'), 'old\n', 'utf8');

  cleanReleaseWorkspace({ repoRoot });

  assert.equal(fs.existsSync(path.join(repoRoot, 'dist')), false);
  assert.equal(fs.existsSync(path.join(repoRoot, 'release')), false);
});

test('e2e: release packaging creates all browser artifacts and metadata', () => {
  const repoRoot = makeRepoFixture();
  const result = createReleaseArtifacts({ repoRoot });

  assert.equal(result.artifacts.length, TARGETS.length);

  const manifest = JSON.parse(fs.readFileSync(result.releaseManifestPath, 'utf8'));
  assert.equal(manifest.version, '1.2.3');
  assert.deepEqual(
    manifest.artifacts.map((artifact) => artifact.target),
    TARGETS.map((target) => target.key)
  );

  const checksumLines = fs
    .readFileSync(result.checksumPath, 'utf8')
    .trim()
    .split('\n');
  assert.equal(checksumLines.length, TARGETS.length);

  const hashes = new Set(result.artifacts.map((artifact) => artifact.sha256));
  assert.equal(hashes.size, 1);

  for (const artifact of result.artifacts) {
    assert.equal(fs.existsSync(artifact.filePath), true);
    assert.match(artifact.fileName, /^browser-cpp-(chrome|edge|brave|chromium)-v1\.2\.3\.zip$/);
  }
});

test('e2e: release packaging refuses mismatched built manifest versions', () => {
  const repoRoot = makeRepoFixture();
  writeJson(path.join(repoRoot, 'dist', 'manifest.json'), {
    manifest_version: 3,
    name: 'browser.cpp',
    version: '2.0.0',
  });

  assert.throws(
    () => createReleaseArtifacts({ repoRoot }),
    /dist\/manifest\.json version \(2\.0\.0\) does not match package\.json version \(1\.2\.3\)/
  );
});
