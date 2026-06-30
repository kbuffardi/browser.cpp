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
