import test from 'node:test';
import assert from 'node:assert/strict';

class FakeFileHandle {
  constructor(name) {
    this.kind = 'file';
    this.name = name;
  }

  async getFile() {
    return { lastModified: 1, size: 1 };
  }
}

class FakeDirectoryHandle {
  constructor(name) {
    this.kind = 'directory';
    this.name = name;
    this.children = new Map();
  }

  async *entries() {
    yield* this.children;
  }
}

async function importFreshFilesystem() {
  return import(`../src/ui/filesystem.js?scan-progress=${Math.random()}`);
}

test('e2e: folder scanning reports a preview after each completed directory depth', async () => {
  const fs = await importFreshFilesystem();
  const root = new FakeDirectoryHandle('project');
  const src = new FakeDirectoryHandle('src');
  const lib = new FakeDirectoryHandle('lib');
  root.children.set('README.md', new FakeFileHandle('README.md'));
  root.children.set('src', src);
  src.children.set('main.cpp', new FakeFileHandle('main.cpp'));
  src.children.set('lib', lib);
  lib.children.set('util.hpp', new FakeFileHandle('util.hpp'));

  const progress = [];
  const workspace = await fs.openFolderFromHandle(root, {
    onScanProgress(update) {
      progress.push({
        depth: update.completedDepth,
        paths: update.workspace.entries.map((entry) => entry.path),
        loadingDirectoryPaths: update.loadingDirectoryPaths,
      });
    },
  });

  assert.deepEqual(progress, [
    {
      depth: 0,
      paths: ['README.md', 'src'],
      loadingDirectoryPaths: ['src'],
    },
    {
      depth: 1,
      paths: ['README.md', 'src', 'src/lib', 'src/main.cpp'],
      loadingDirectoryPaths: ['src', 'src/lib'],
    },
    {
      depth: 2,
      paths: ['README.md', 'src', 'src/lib', 'src/lib/util.hpp', 'src/main.cpp'],
      loadingDirectoryPaths: [],
    },
  ]);
  assert.deepEqual(workspace.entries.map((entry) => entry.path), progress.at(-1).paths);
});
