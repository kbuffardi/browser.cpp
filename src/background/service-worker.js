/**
 * src/background/service-worker.js
 *
 * Manifest V3 background service worker.
 * - Opens a full-page IDE tab when the toolbar icon is clicked.
 * - On install, pre-warms the extension page so the first open is faster.
 */

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('index.html');

  // Reuse an existing browser.cpp tab if one is already open
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length > 0) {
    chrome.tabs.update(tabs[0].id, { active: true });
    chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url });
  }
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    // Open the IDE automatically on first install
    chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
  }
});
