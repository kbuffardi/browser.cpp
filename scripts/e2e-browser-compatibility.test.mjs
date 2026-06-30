import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectBrowserCapabilities,
  createBrowserCompatibilityReport,
  formatBrowserCompatibilityMessage,
  getChromiumMajor,
} from '../src/ui/browser-capabilities.mjs';

function chromiumLikeRoot(overrides = {}) {
  return {
    navigator: {
      userAgent:
        'Mozilla/5.0 AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
    },
    chrome: {
      runtime: { getURL() {} },
      tabs: {},
      storage: { local: {} },
    },
    showOpenFilePicker() {},
    showDirectoryPicker() {},
    showSaveFilePicker() {},
    Worker() {},
    WebAssembly: { instantiate() {} },
    SharedArrayBuffer() {},
    Atomics: { waitAsync() {} },
    crossOriginIsolated: true,
    ...overrides,
  };
}

test('e2e: extracts Chromium major versions from Chrome and Edge user agents', () => {
  assert.equal(getChromiumMajor('Chrome/126.0.0.0 Safari/537.36'), 126);
  assert.equal(getChromiumMajor('Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'), 126);
  assert.equal(getChromiumMajor('Firefox/127.0'), null);
});

test('e2e: reports full Chromium-family capability support', () => {
  const report = createBrowserCompatibilityReport(chromiumLikeRoot());

  assert.equal(report.ok, true);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.capabilities.directoryPicker, true);
  assert.equal(report.capabilities.sharedArrayBuffer, true);
});

test('e2e: reports missing full-parity browser APIs', () => {
  const root = chromiumLikeRoot({
    showDirectoryPicker: undefined,
    SharedArrayBuffer: undefined,
    crossOriginIsolated: false,
  });

  const report = createBrowserCompatibilityReport(root);
  const message = formatBrowserCompatibilityMessage(report);

  assert.equal(report.ok, false);
  assert.deepEqual(report.missing.map((item) => item.key), [
    'directoryPicker',
    'sharedArrayBuffer',
  ]);
  assert.ok(message.includes('Directory picker'));
  assert.ok(message.includes('SharedArrayBuffer'));
  assert.ok(message.includes('cross-origin isolated'));
});

test('e2e: warns when Chromium is below the minimum full-parity version', () => {
  const report = createBrowserCompatibilityReport(chromiumLikeRoot({
    navigator: {
      userAgent:
        'Mozilla/5.0 AppleWebKit/537.36 Chrome/104.0.0.0 Safari/537.36',
    },
  }));

  assert.equal(report.ok, true);
  assert.deepEqual(report.warnings.map((item) => item.key), ['minimumChromiumVersion']);
});

test('e2e: supports browser namespace in addition to chrome namespace', () => {
  const root = chromiumLikeRoot({
    chrome: undefined,
    browser: {
      runtime: { getURL() {} },
      tabs: {},
      storage: { local: {} },
    },
  });

  assert.equal(collectBrowserCapabilities(root).extensionRuntime, true);
  assert.equal(collectBrowserCapabilities(root).extensionStorage, true);
});
