import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ensureFirefoxBuild, runWebExt } = require('./firefox-webext.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const manifestPath = ensureFirefoxBuild(repoRoot);
  const manifest = readJson(manifestPath);

  assert.equal(manifest.background?.service_worker, undefined);
  assert.deepEqual(manifest.background?.scripts, ['firefox-background.js']);
  assert.equal(manifest.browser_specific_settings?.gecko?.id, 'browser.cpp@kbuffardi.github.io');

  runWebExt([
    'lint',
    '--source-dir',
    path.join(repoRoot, 'dist-firefox'),
    '--self-hosted',
  ], { repoRoot });

  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-cpp-firefox-smoke-'));
  runWebExt([
    'build',
    '--source-dir',
    path.join(repoRoot, 'dist-firefox'),
    '--artifacts-dir',
    artifactsDir,
  ], { repoRoot });

  const builtArtifacts = fs.readdirSync(artifactsDir).filter((item) => item.endsWith('.zip'));
  assert.ok(builtArtifacts.length > 0, 'Expected web-ext build to emit a Firefox package.');

  console.log(`Firefox smoke validation passed with ${builtArtifacts[0]}.`);
  console.log('Runtime compile/run verification remains part of the manual Firefox release QA checklist.');
}

main();
