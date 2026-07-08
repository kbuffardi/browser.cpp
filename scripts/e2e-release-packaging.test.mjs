import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { readProjectVersion } = require('./project-version.js');
const { synchronizeVersionFromManifest } = require('./sync-version-from-manifest.js');
const { validateReleaseVersionSync } = require('./check-release-version-sync.js');
const { cleanReleaseWorkspace } = require('./clean-release-workspace.js');
const {
  getPublishableReleaseTargets,
  getReleaseTarget,
  getReleaseTargets,
} = require('./release-targets.js');
const {
  TARGETS,
  createReleaseArtifacts,
} = require('./package-extension-release.js');
const {
  detectManifestVersionChange,
} = require('./detect-manifest-version-change.js');

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
  writeJson(path.join(repoRoot, 'package-lock.json'), {
    name: 'browser.cpp',
    version: '1.2.3',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'browser.cpp',
        version: '1.2.3',
      },
    },
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
  writeJson(path.join(repoRoot, 'dist-firefox', 'manifest.json'), {
    manifest_version: 3,
    name: 'browser.cpp',
    version: '1.2.3',
    background: {
      scripts: ['firefox-background.js'],
    },
  });
  fs.writeFileSync(path.join(repoRoot, 'dist', 'bundle.js'), 'console.log("bundle");\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'dist-firefox', 'bundle.js'), 'console.log("bundle");\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'dist', 'styles.css'), 'body{color:#fff;}\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'dist-firefox', 'styles.css'), 'body{color:#fff;}\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'dist', 'icons'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'dist-firefox', 'icons'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'dist', 'icons', 'icon16.png'), 'icon', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'dist-firefox', 'icons', 'icon16.png'), 'icon', 'utf8');
  return repoRoot;
}

function initGitRepo(repoRoot) {
  const { execFileSync } = require('node:child_process');
  execFileSync('git', ['init'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: repoRoot });
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
    /manifest\.json version \(9\.9\.9\) does not match package\.json version \(1\.2\.3\)/
  );
});

test('e2e: release version sync fails on package-lock mismatch', () => {
  const repoRoot = makeRepoFixture();
  writeJson(path.join(repoRoot, 'package-lock.json'), {
    name: 'browser.cpp',
    version: '3.0.0',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'browser.cpp',
        version: '3.0.0',
      },
    },
  });

  assert.throws(
    () => validateReleaseVersionSync({ repoRoot }),
    /manifest\.json version \(1\.2\.3\) does not match package-lock\.json version \(3\.0\.0\)/
  );
});

test('e2e: sync-version-from-manifest updates package and lock versions', () => {
  const repoRoot = makeRepoFixture();
  writeJson(path.join(repoRoot, 'manifest.json'), {
    manifest_version: 3,
    name: 'browser.cpp',
    version: '4.5.6',
  });

  const result = synchronizeVersionFromManifest({ repoRoot });
  assert.equal(result.version, '4.5.6');
  assert.ok(result.changes.length >= 2);

  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));

  assert.equal(pkg.version, '4.5.6');
  assert.equal(lock.version, '4.5.6');
  assert.equal(lock.packages[''].version, '4.5.6');
  assert.equal(readProjectVersion({ repoRoot }), '4.5.6');
});

test('e2e: sync-version-from-manifest check mode reports drift without writing', () => {
  const repoRoot = makeRepoFixture();
  writeJson(path.join(repoRoot, 'manifest.json'), {
    manifest_version: 3,
    name: 'browser.cpp',
    version: '7.8.9',
  });

  const result = synchronizeVersionFromManifest({ repoRoot, check: true });
  assert.ok(result.changes.length >= 2);

  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '1.2.3');
});

test('e2e: clean release workspace removes stale dist and release outputs', () => {
  const repoRoot = makeRepoFixture();
  fs.writeFileSync(path.join(repoRoot, 'dist', 'stale.txt'), 'stale\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'dist-firefox', 'stale.txt'), 'stale\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'release'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'release', 'old.zip'), 'old\n', 'utf8');

  cleanReleaseWorkspace({ repoRoot });

  assert.equal(fs.existsSync(path.join(repoRoot, 'dist')), false);
  assert.equal(fs.existsSync(path.join(repoRoot, 'dist-firefox')), false);
  assert.equal(fs.existsSync(path.join(repoRoot, 'release')), false);
});

test('e2e: release packaging creates all browser artifacts and metadata', () => {
  const repoRoot = makeRepoFixture();
  const result = createReleaseArtifacts({ repoRoot });

  const publishableTargets = getPublishableReleaseTargets();
  assert.equal(result.artifacts.length, publishableTargets.length);

  const manifest = JSON.parse(fs.readFileSync(result.releaseManifestPath, 'utf8'));
  assert.equal(manifest.version, '1.2.3');
  assert.deepEqual(
    manifest.artifacts.map((artifact) => artifact.target),
    publishableTargets.map((target) => target.key)
  );
  assert.deepEqual(
    manifest.targets.map((target) => target.target),
    getReleaseTargets().map((target) => target.key)
  );

  const checksumLines = fs
    .readFileSync(result.checksumPath, 'utf8')
    .trim()
    .split('\n');
  assert.equal(checksumLines.length, publishableTargets.length);

  const firefoxTarget = manifest.targets.find((target) => target.target === 'firefox');
  assert.equal(firefoxTarget.publishable, true);
  assert.equal(firefoxTarget.packageStrategy, 'distinct');
  assert.equal(firefoxTarget.fileName, 'browser-cpp-firefox-v1.2.3.zip');
  assert.equal(firefoxTarget.signing.listed, 'manual-owner-submission');
  assert.equal(firefoxTarget.signing.unlisted, 'required-release-artifact');

  const edgeArtifact = manifest.artifacts.find((artifact) => artifact.target === 'edge');
  assert.equal(edgeArtifact.packageStrategy, 'shared-with:chrome');
  assert.equal(edgeArtifact.payloadGroup, 'chromium-mv3');

  const firefoxArtifact = manifest.artifacts.find((artifact) => artifact.target === 'firefox');
  assert.equal(firefoxArtifact.packageStrategy, 'distinct');
  assert.equal(firefoxArtifact.payloadGroup, 'firefox-webext');
  assert.equal(firefoxArtifact.sharedPayload, false);
  assert.equal(firefoxArtifact.format, 'zip');
  assert.equal(firefoxArtifact.sourceDir, 'dist-firefox');

  for (const artifact of result.artifacts) {
    assert.equal(fs.existsSync(artifact.filePath), true);
    assert.match(artifact.fileName, /^browser-cpp-(chrome|edge|firefox|brave|chromium)-v1\.2\.3\.zip$/);
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
    /dist\/manifest\.json version \(2\.0\.0\) does not match manifest\.json version \(1\.2\.3\)/
  );
});

test('e2e: release-target metadata includes Firefox and shared Chromium payloads', () => {
  assert.deepEqual(
    TARGETS.map((target) => target.key),
    ['chrome', 'edge', 'firefox', 'brave', 'chromium']
  );

  const firefox = getReleaseTarget('firefox');
  assert.equal(firefox.packageStrategy, 'distinct');
  assert.equal(firefox.publishable, true);
  assert.equal(firefox.payloadGroup, 'firefox-webext');

  const publishableTargets = getPublishableReleaseTargets();
  assert.deepEqual(
    publishableTargets.map((target) => target.key),
    ['chrome', 'edge', 'firefox', 'brave', 'chromium']
  );
});

test('e2e: manifest version change detection reports same-repo version bumps', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-cpp-version-diff-'));
  initGitRepo(repoRoot);
  writeJson(path.join(repoRoot, 'manifest.json'), {
    manifest_version: 3,
    name: 'browser.cpp',
    version: '0.1.0',
  });
  writeJson(path.join(repoRoot, 'package.json'), {
    name: 'browser.cpp',
    version: '0.1.0',
  });
  const { execFileSync } = require('node:child_process');
  execFileSync('git', ['add', 'manifest.json', 'package.json'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: repoRoot });

  writeJson(path.join(repoRoot, 'manifest.json'), {
    manifest_version: 3,
    name: 'browser.cpp',
    version: '0.2.1',
  });
  execFileSync('git', ['add', 'manifest.json'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'bump manifest'], { cwd: repoRoot });

  const baseRef = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const result = detectManifestVersionChange({ repoRoot, baseRef, headRef: 'HEAD' });

  assert.equal(result.changed, true);
  assert.equal(result.baseVersion, '0.1.0');
  assert.equal(result.headVersion, '0.2.1');
});
