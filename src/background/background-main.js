/**
 * Shared background bootstrap used by Chromium MV3 service workers and Firefox
 * background scripts.
 */

import { getExtensionAPI } from '../extension-api.mjs';

async function focusOrCreateIdeTab(extensionAPI) {
  const url = extensionAPI.runtime.getURL('index.html');
  const tabs = await extensionAPI.tabs.query({ url });

  if (tabs.length > 0) {
    extensionAPI.tabs.update(tabs[0].id, { active: true });
    extensionAPI.windows.update(tabs[0].windowId, { focused: true });
    return;
  }

  extensionAPI.tabs.create({ url });
}

export function registerBackgroundHandlers(extensionAPI = getExtensionAPI()) {
  if (!extensionAPI?.action?.onClicked || !extensionAPI?.runtime?.onInstalled) {
    throw new Error('Extension background APIs are unavailable.');
  }

  extensionAPI.action.onClicked.addListener(() => {
    void focusOrCreateIdeTab(extensionAPI);
  });

  extensionAPI.runtime.onInstalled.addListener(({ reason }) => {
    if (reason !== 'install') return;
    extensionAPI.tabs.create({ url: extensionAPI.runtime.getURL('index.html') });
  });

  return { focusOrCreateIdeTab };
}
