'use strict';

import { getExtensionAPI } from '../extension-api.mjs';

const MINIMUM_CHROMIUM_MAJOR = 105;
const MINIMUM_FIREFOX_MAJOR = 140;

const CORE_REQUIRED_CAPABILITIES = [
  { key: 'extensionRuntime', label: 'Extension runtime API' },
  { key: 'extensionStorage', label: 'Extension storage API' },
  { key: 'worker', label: 'Web Worker' },
  { key: 'webAssembly', label: 'WebAssembly' },
  { key: 'sharedArrayBuffer', label: 'SharedArrayBuffer' },
  { key: 'atomicsWaitAsync', label: 'Atomics.waitAsync' },
];

const CHROMIUM_FULL_PARITY_CAPABILITIES = [
  ...CORE_REQUIRED_CAPABILITIES,
  { key: 'fileOpenPicker', label: 'File open picker' },
  { key: 'directoryPicker', label: 'Directory picker' },
  { key: 'fileSavePicker', label: 'File save picker' },
];

function hasFunction(value) {
  return typeof value === 'function';
}

export function getChromiumMajor(userAgent = '') {
  const match = String(userAgent).match(/(?:Chrome|Chromium|Edg|Brave)\/(\d+)/);
  return match ? Number(match[1]) : null;
}

export function getFirefoxMajor(userAgent = '') {
  const match = String(userAgent).match(/Firefox\/(\d+)/);
  return match ? Number(match[1]) : null;
}

function getBrowserProfile(userAgent = '') {
  const firefoxMajor = getFirefoxMajor(userAgent);
  if (firefoxMajor !== null) {
    return {
      family: 'firefox',
      versionMajor: firefoxMajor,
      minimumVersionMajor: MINIMUM_FIREFOX_MAJOR,
      supportLevel: 'compatible',
    };
  }

  const chromiumMajor = getChromiumMajor(userAgent);
  if (chromiumMajor !== null) {
    return {
      family: 'chromium',
      versionMajor: chromiumMajor,
      minimumVersionMajor: MINIMUM_CHROMIUM_MAJOR,
      supportLevel: 'full',
    };
  }

  return {
    family: 'unknown',
    versionMajor: null,
    minimumVersionMajor: null,
    supportLevel: 'unknown',
  };
}

export function collectBrowserCapabilities(root = globalThis) {
  const nav = root.navigator ?? {};
  const api = getExtensionAPI(root);
  const atomics = root.Atomics ?? {};
  const chromiumMajor = getChromiumMajor(nav.userAgent);
  const firefoxMajor = getFirefoxMajor(nav.userAgent);
  const profile = getBrowserProfile(nav.userAgent);

  return {
    userAgent: nav.userAgent ?? '',
    browserFamily: profile.family,
    supportLevel: profile.supportLevel,
    chromiumMajor,
    firefoxMajor,
    minimumChromiumMajor: MINIMUM_CHROMIUM_MAJOR,
    minimumFirefoxMajor: MINIMUM_FIREFOX_MAJOR,
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
  const requiredCapabilities = capabilities.browserFamily === 'chromium'
    ? CHROMIUM_FULL_PARITY_CAPABILITIES
    : CORE_REQUIRED_CAPABILITIES;
  const missing = requiredCapabilities
    .filter(({ key }) => !capabilities[key])
    .map(({ key, label }) => ({ key, label }));

  const warnings = [];
  const limitations = [];

  if (
    capabilities.browserFamily === 'chromium' &&
    capabilities.chromiumMajor !== null &&
    capabilities.chromiumMajor < capabilities.minimumChromiumMajor
  ) {
    warnings.push({
      key: 'minimumChromiumVersion',
      label: `Chromium ${capabilities.minimumChromiumMajor}+ is required for full File System Access support`,
    });
  }
  if (
    capabilities.browserFamily === 'firefox' &&
    capabilities.firefoxMajor !== null &&
    capabilities.firefoxMajor < capabilities.minimumFirefoxMajor
  ) {
    warnings.push({
      key: 'minimumFirefoxVersion',
      label: `Firefox ${capabilities.minimumFirefoxMajor}+ is recommended for the supported browser.cpp Firefox release path`,
    });
  }
  if (!capabilities.crossOriginIsolated) {
    warnings.push({
      key: 'crossOriginIsolated',
      label: 'Page is not cross-origin isolated; SharedArrayBuffer may be blocked by browser policy',
    });
  }
  if (capabilities.browserFamily === 'firefox') {
    limitations.push({
      key: 'firefoxFileFallbacks',
      label: 'Firefox uses fallback file and folder flows instead of the Chromium File System Access APIs.',
    });
    limitations.push({
      key: 'firefoxWorkspacePersistence',
      label: 'Persistent folder write-back and automatic directory-handle restore may be limited in Firefox.',
    });
  }
  if (capabilities.browserFamily === 'unknown') {
    warnings.push({
      key: 'unknownBrowser',
      label: 'This browser target is not part of the supported release matrix.',
    });
  }

  return {
    ok: missing.length === 0,
    capabilities,
    missing,
    warnings,
    limitations,
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
  if (report.limitations?.length) {
    if (!lines.length) lines.push('Browser compatibility notes:');
    for (const item of report.limitations) {
      lines.push(`- ${item.label}`);
    }
  }
  return lines.join('\n');
}
