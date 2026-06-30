'use strict';

import { getExtensionAPI } from '../extension-api.mjs';

const MINIMUM_CHROMIUM_MAJOR = 105;

const REQUIRED_CAPABILITIES = [
  { key: 'extensionRuntime', label: 'Extension runtime API' },
  { key: 'extensionStorage', label: 'Extension storage API' },
  { key: 'fileOpenPicker', label: 'File open picker' },
  { key: 'directoryPicker', label: 'Directory picker' },
  { key: 'fileSavePicker', label: 'File save picker' },
  { key: 'worker', label: 'Web Worker' },
  { key: 'webAssembly', label: 'WebAssembly' },
  { key: 'sharedArrayBuffer', label: 'SharedArrayBuffer' },
  { key: 'atomicsWaitAsync', label: 'Atomics.waitAsync' },
];

function hasFunction(value) {
  return typeof value === 'function';
}

export function getChromiumMajor(userAgent = '') {
  const match = String(userAgent).match(/(?:Chrome|Chromium|Edg|Brave)\/(\d+)/);
  return match ? Number(match[1]) : null;
}

export function collectBrowserCapabilities(root = globalThis) {
  const nav = root.navigator ?? {};
  const api = getExtensionAPI(root);
  const atomics = root.Atomics ?? {};
  const chromiumMajor = getChromiumMajor(nav.userAgent);

  return {
    userAgent: nav.userAgent ?? '',
    chromiumMajor,
    minimumChromiumMajor: MINIMUM_CHROMIUM_MAJOR,
    extensionRuntime: !!api?.runtime?.getURL,
    extensionTabs: !!api?.tabs,
    extensionStorage: !!api?.storage?.local,
    fileOpenPicker: hasFunction(root.showOpenFilePicker),
    directoryPicker: hasFunction(root.showDirectoryPicker),
    fileSavePicker: hasFunction(root.showSaveFilePicker),
    worker: hasFunction(root.Worker),
    webAssembly: !!root.WebAssembly?.instantiate,
    sharedArrayBuffer: hasFunction(root.SharedArrayBuffer),
    atomicsWaitAsync: hasFunction(atomics.waitAsync),
    crossOriginIsolated: root.crossOriginIsolated === true,
  };
}

export function createBrowserCompatibilityReport(root = globalThis) {
  const capabilities = collectBrowserCapabilities(root);
  const missing = REQUIRED_CAPABILITIES
    .filter(({ key }) => !capabilities[key])
    .map(({ key, label }) => ({ key, label }));

  const warnings = [];
  if (
    capabilities.chromiumMajor !== null &&
    capabilities.chromiumMajor < capabilities.minimumChromiumMajor
  ) {
    warnings.push({
      key: 'minimumChromiumVersion',
      label: `Chromium ${capabilities.minimumChromiumMajor}+ is required for full File System Access support`,
    });
  }
  if (!capabilities.crossOriginIsolated) {
    warnings.push({
      key: 'crossOriginIsolated',
      label: 'Page is not cross-origin isolated; SharedArrayBuffer may be blocked by browser policy',
    });
  }

  return {
    ok: missing.length === 0,
    capabilities,
    missing,
    warnings,
  };
}

export function formatBrowserCompatibilityMessage(report) {
  const lines = [];
  if (report.missing.length) {
    lines.push('Browser compatibility warning: required capabilities are missing:');
    for (const item of report.missing) {
      lines.push(`- ${item.label}`);
    }
  }
  if (report.warnings.length) {
    if (!lines.length) lines.push('Browser compatibility notes:');
    for (const item of report.warnings) {
      lines.push(`- ${item.label}`);
    }
  }
  return lines.join('\n');
}
