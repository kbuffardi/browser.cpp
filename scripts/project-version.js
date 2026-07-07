'use strict';

const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getRepoRoot(options = {}) {
  return options.repoRoot || path.resolve(__dirname, '..');
}

function getManifestPath(options = {}) {
  return path.join(getRepoRoot(options), 'manifest.json');
}

function readProjectManifest(options = {}) {
  return readJson(getManifestPath(options));
}

function readProjectVersion(options = {}) {
  const manifest = readProjectManifest(options);
  const version = manifest.version;
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('manifest.json is missing a non-empty string version.');
  }
  return version;
}

module.exports = {
  getManifestPath,
  getRepoRoot,
  readJson,
  readProjectManifest,
  readProjectVersion,
};
