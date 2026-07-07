'use strict';

const fs = require('fs');
const path = require('path');

const {
  getRepoRoot,
  readJson,
  readProjectVersion,
} = require('./project-version');

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function synchronizeVersionFromManifest(options = {}) {
  const repoRoot = getRepoRoot(options);
  const version = readProjectVersion({ repoRoot });
  const packagePath = path.join(repoRoot, 'package.json');
  const packageLockPath = path.join(repoRoot, 'package-lock.json');

  const pkg = readJson(packagePath);
  const lock = readJson(packageLockPath);
  const changes = [];

  if (pkg.version !== version) {
    changes.push({
      filePath: packagePath,
      field: 'package.json version',
      current: pkg.version,
      expected: version,
    });
    if (!options.check) {
      pkg.version = version;
      writeJson(packagePath, pkg);
    }
  }

  if (lock.version !== version) {
    changes.push({
      filePath: packageLockPath,
      field: 'package-lock.json version',
      current: lock.version,
      expected: version,
    });
    if (!options.check) {
      lock.version = version;
    }
  }

  const rootPackageVersion = lock.packages && lock.packages[''] ? lock.packages[''].version : undefined;
  if (rootPackageVersion !== version) {
    changes.push({
      filePath: packageLockPath,
      field: 'package-lock.json packages[""].version',
      current: rootPackageVersion,
      expected: version,
    });
    if (!options.check) {
      lock.packages = lock.packages || {};
      lock.packages[''] = lock.packages[''] || {};
      lock.packages[''].version = version;
    }
  }

  if (!options.check && changes.some((change) => change.filePath === packageLockPath)) {
    writeJson(packageLockPath, lock);
  }

  return {
    version,
    changes,
    packagePath,
    packageLockPath,
  };
}

function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const result = synchronizeVersionFromManifest({ check });

  if (check) {
    if (result.changes.length) {
      console.error(`Version sync check failed for manifest.json version ${result.version}:`);
      for (const change of result.changes) {
        console.error(`- ${change.field} is ${change.current ?? 'missing'} but expected ${change.expected}.`);
      }
      process.exit(1);
    }
    console.log(`Version sync check passed for manifest.json version ${result.version}.`);
    return;
  }

  if (!result.changes.length) {
    console.log(`package.json and package-lock.json already match manifest.json version ${result.version}.`);
    return;
  }

  for (const change of result.changes) {
    console.log(`Updated ${change.field} from ${change.current ?? 'missing'} to ${change.expected}.`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  synchronizeVersionFromManifest,
};
