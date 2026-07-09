'use strict';

const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeObjects(base, overlay) {
  const merged = clone(base);
  for (const [key, value] of Object.entries(overlay || {})) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      merged[key] &&
      typeof merged[key] === 'object' &&
      !Array.isArray(merged[key])
    ) {
      merged[key] = mergeObjects(merged[key], value);
    } else {
      merged[key] = clone(value);
    }
  }
  return merged;
}

function createChromiumManifest(baseManifest) {
  return clone(baseManifest);
}

function createFirefoxManifest(baseManifest, firefoxOverlay) {
  const manifest = mergeObjects(baseManifest, firefoxOverlay);
  delete manifest.minimum_chrome_version;
  manifest.background = {
    scripts: ['firefox-background.js'],
  };
  return manifest;
}

function buildTargetManifests(options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const distDir = options.distDir || path.join(repoRoot, 'dist');
  const firefoxDistDir = options.firefoxDistDir || path.join(repoRoot, 'dist-firefox');
  const sourceManifestPath = path.join(repoRoot, 'manifest.json');
  const firefoxOverlayPath = path.join(repoRoot, 'manifest.firefox.json');

  if (!fs.existsSync(distDir)) {
    throw new Error('dist/ is missing. Run `npm run build:webpack` before generating target manifests.');
  }

  const sourceManifest = readJson(sourceManifestPath);
  const firefoxOverlay = readJson(firefoxOverlayPath);
  const chromiumManifest = createChromiumManifest(sourceManifest);
  const firefoxManifest = createFirefoxManifest(sourceManifest, firefoxOverlay);

  writeJson(path.join(distDir, 'manifest.json'), chromiumManifest);

  fs.rmSync(firefoxDistDir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 200,
  });
  fs.cpSync(distDir, firefoxDistDir, { recursive: true });
  writeJson(path.join(firefoxDistDir, 'manifest.json'), firefoxManifest);

  return {
    distDir,
    firefoxDistDir,
    chromiumManifest,
    firefoxManifest,
  };
}

function main() {
  const result = buildTargetManifests();
  console.log(`Wrote ${path.relative(process.cwd(), path.join(result.distDir, 'manifest.json'))}`);
  console.log(`Wrote ${path.relative(process.cwd(), path.join(result.firefoxDistDir, 'manifest.json'))}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildTargetManifests,
  createChromiumManifest,
  createFirefoxManifest,
};
