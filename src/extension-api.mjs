'use strict';

/**
 * Return the extension API namespace exposed by Chromium-family browsers.
 *
 * Chrome, Edge, Brave, and Chromium expose the `chrome` namespace. The
 * `browser` fallback keeps the rest of the app insulated from namespace
 * differences if a future target provides the Promise-based WebExtensions API.
 */
export function getExtensionAPI(root = globalThis) {
  return root.browser ?? root.chrome ?? null;
}

export function getExtensionRuntimeError(api = getExtensionAPI()) {
  return api?.runtime?.lastError ?? null;
}

/** Return the installed extension's status-bar label, or an empty string outside an extension. */
export function getExtensionVersionLabel(root = globalThis) {
  try {
    const version = getExtensionAPI(root)?.runtime?.getManifest?.()?.version;
    return typeof version === 'string' && version.trim()
      ? `browser.cpp v${version}`
      : '';
  } catch (_) {
    return '';
  }
}
