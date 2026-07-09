import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  createBrowserCompatibilityReport,
  formatBrowserCompatibilityMessage,
  getFirefoxMajor,
} from '../src/ui/browser-capabilities.mjs';

const require = createRequire(import.meta.url);
const {
  buildTargetManifests,
  createFirefoxManifest,
} = require('./build-target-manifest.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function firefoxLikeRoot(overrides = {}) {
  return {
    navigator: {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0',
    },
    browser: {
      runtime: { getURL() {} },
      tabs: {},
      storage: { local: {} },
    },
    Worker() {},
    WebAssembly: { instantiate() {} },
    SharedArrayBuffer() {},
    Atomics: { waitAsync() {} },
    crossOriginIsolated: true,
    ...overrides,
  };
}

test('e2e: extracts Firefox major versions from Firefox user agents', () => {
  assert.equal(getFirefoxMajor('Firefox/140.0'), 140);
  assert.equal(getFirefoxMajor('Chrome/126.0.0.0 Safari/537.36'), null);
});

test('e2e: Firefox compatibility report accepts supported fallback-based capabilities', () => {
  const report = createBrowserCompatibilityReport(firefoxLikeRoot());
  const message = formatBrowserCompatibilityMessage(report);

  assert.equal(report.ok, true);
  assert.equal(report.capabilities.browserFamily, 'firefox');
  assert.equal(report.capabilities.supportLevel, 'compatible');
  assert.deepEqual(report.missing, []);
  assert.ok(report.limitations.some((item) => item.key === 'firefoxWorkspacePersistence'));
  assert.ok(message.includes('Persistent folder write-back'));
});

test('e2e: target manifest generation creates a Firefox manifest without Chromium-only background keys', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-cpp-firefox-manifest-'));
  writeJson(path.join(repoRoot, 'manifest.json'), {
    manifest_version: 3,
    name: 'browser.cpp',
    version: '1.2.3',
    minimum_chrome_version: '105',
    background: {
      service_worker: 'service-worker.js',
      type: 'module',
    },
  });
  writeJson(path.join(repoRoot, 'manifest.firefox.json'), {
    browser_specific_settings: {
      gecko: {
        id: 'browser.cpp@example.test',
        strict_min_version: '140.0',
        data_collection_permissions: {
          required: ['none'],
        },
      },
    },
  });
  fs.mkdirSync(path.join(repoRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'dist', 'bundle.js'), 'console.log("bundle");\n', 'utf8');

  const result = buildTargetManifests({ repoRoot });
  const firefoxManifest = JSON.parse(
    fs.readFileSync(path.join(result.firefoxDistDir, 'manifest.json'), 'utf8')
  );

  assert.equal(firefoxManifest.minimum_chrome_version, undefined);
  assert.equal(firefoxManifest.background.service_worker, undefined);
  assert.deepEqual(firefoxManifest.background.scripts, ['firefox-background.js']);
  assert.equal(firefoxManifest.browser_specific_settings.gecko.id, 'browser.cpp@example.test');
});

test('e2e: createFirefoxManifest strips Chromium-specific background configuration', () => {
  const manifest = createFirefoxManifest(
    {
      manifest_version: 3,
      background: {
        service_worker: 'service-worker.js',
        type: 'module',
      },
      minimum_chrome_version: '105',
    },
    {
      browser_specific_settings: {
        gecko: {
          id: 'browser.cpp@example.test',
        },
      },
    }
  );

  assert.equal(manifest.minimum_chrome_version, undefined);
  assert.equal(manifest.background.service_worker, undefined);
  assert.deepEqual(manifest.background.scripts, ['firefox-background.js']);
});
