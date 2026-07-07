'use strict';

const TARGETS = Object.freeze([
  {
    key: 'chrome',
    label: 'Chrome',
    channel: 'Chrome Web Store',
    packageStrategy: 'distinct',
    payloadGroup: 'chromium-mv3',
    publishable: true,
    notes: 'Primary public store listing and canonical Chromium-family payload.',
  },
  {
    key: 'edge',
    label: 'Edge',
    channel: 'Microsoft Edge Add-ons',
    packageStrategy: 'shared-with:chrome',
    payloadGroup: 'chromium-mv3',
    publishable: true,
    notes: 'Browser-labeled asset that intentionally reuses the Chrome payload.',
  },
  {
    key: 'firefox',
    label: 'Firefox',
    channel: 'Firefox Add-ons',
    packageStrategy: 'blocked',
    payloadGroup: null,
    publishable: false,
    blockReason:
      'Firefox packaging is blocked until browser-specific manifest and API compatibility work exists.',
    notes: 'Tracked in the release matrix but intentionally not packaged yet.',
  },
  {
    key: 'brave',
    label: 'Brave',
    channel: 'Chrome Web Store compatibility',
    packageStrategy: 'shared-with:chrome',
    payloadGroup: 'chromium-mv3',
    publishable: true,
    notes: 'Browser-labeled asset for Brave validation against the Chrome payload.',
  },
  {
    key: 'chromium',
    label: 'Chromium',
    channel: 'GitHub/manual distribution',
    packageStrategy: 'shared-with:chrome',
    payloadGroup: 'chromium-mv3',
    publishable: true,
    notes: 'Browser-labeled asset for unmanaged Chromium distribution.',
  },
]);

function getReleaseTargets() {
  return TARGETS.map((target) => ({ ...target }));
}

function getPublishableReleaseTargets() {
  return getReleaseTargets().filter((target) => target.publishable);
}

function getReleaseTarget(key) {
  return getReleaseTargets().find((target) => target.key === key) || null;
}

function getArtifactFileName(target, version) {
  return `browser-cpp-${target.key}-v${version}.zip`;
}

module.exports = {
  TARGETS,
  getArtifactFileName,
  getPublishableReleaseTargets,
  getReleaseTarget,
  getReleaseTargets,
};
