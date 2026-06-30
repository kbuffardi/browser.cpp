/**
 * src/background/service-worker.js
 *
 * Manifest V3 background service worker.
 * - Opens a full-page IDE tab when the toolbar icon is clicked.
 * - On install, pre-warms the extension page so the first open is faster.
 */

import { getExtensionAPI } from '../extension-api.mjs';

const extensionAPI = getExtensionAPI();

extensionAPI.action.onClicked.addListener(async () => {
  const url = extensionAPI.runtime.getURL('index.html');

  // Reuse an existing browser.cpp tab if one is already open
  const tabs = await extensionAPI.tabs.query({ url });
  if (tabs.length > 0) {
    extensionAPI.tabs.update(tabs[0].id, { active: true });
    extensionAPI.windows.update(tabs[0].windowId, { focused: true });
  } else {
    extensionAPI.tabs.create({ url });
  }
});

extensionAPI.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    // Open the IDE automatically on first install
    extensionAPI.tabs.create({ url: extensionAPI.runtime.getURL('index.html') });
  }
});
