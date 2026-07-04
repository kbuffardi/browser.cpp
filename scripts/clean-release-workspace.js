'use strict';

const fs = require('fs');
const path = require('path');

function cleanReleaseWorkspace(options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const targets = [
    path.join(repoRoot, 'dist'),
    path.join(repoRoot, 'release'),
  ];

  for (const targetPath of targets) {
    fs.rmSync(targetPath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 200,
    });
  }

  return targets;
}

function main() {
  const removed = cleanReleaseWorkspace();
  for (const targetPath of removed) {
    console.log(`Removed ${path.relative(path.resolve(__dirname, '..'), targetPath) || targetPath}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  cleanReleaseWorkspace,
};
