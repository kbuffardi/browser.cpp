'use strict';

const TARGETS = Object.freeze([
  {
    key: 'chrome',
    label: 'Chrome',
    channel: 'Chrome Web Store',
    packageStrategy: 'shared-artifact:chromium-family',
    artifactKey: 'chromium-family',
    payloadGroup: 'chromium-mv3',
    publishable: true,
    notes: 'Primary public store listing using the shared Chromium-family payload.',
  },
  {
    key: 'edge',
    label: 'Edge',
    channel: 'Microsoft Edge Add-ons',
    packageStrategy: 'shared-artifact:chromium-family',
    artifactKey: 'chromium-family',
    payloadGroup: 'chromium-mv3',
    publishable: true,
    notes: 'Uses the shared Chromium-family payload.',
  },
  {
    key: 'firefox',
    label: 'Firefox',
    channel: 'Firefox Add-ons / signed XPI',
    packageStrategy: 'distinct',
    artifactKey: null,
    payloadGroup: 'firefox-webext',
    publishable: false,
    blockReason: 'Firefox unsigned ZIP generation is disabled; use the signed unlisted XPI.',
    signing: {
      listed: 'manual-owner-submission',
      unlisted: 'required-release-artifact',
    },
    notes:
      'Firefox uses a browser-specific manifest, background script entry, and a separate packaging/signing flow.',
  },
  {
    key: 'brave',
    label: 'Brave',
    channel: 'Chrome Web Store compatibility',
    packageStrategy: 'shared-artifact:chromium-family',
    artifactKey: 'chromium-family',
    payloadGroup: 'chromium-mv3',
    publishable: true,
    notes: 'Uses the shared Chromium-family payload for Brave validation.',
  },
  {
    key: 'chromium',
    label: 'Chromium',
    channel: 'GitHub/manual distribution',
    packageStrategy: 'distinct',
    artifactKey: 'chromium-family',
    payloadGroup: 'chromium-mv3',
    publishable: true,
    notes: 'Canonical shared artifact for Chromium-family distribution.',
  },
]);

function getReleaseTargets() {
  return TARGETS.map((target) => ({ ...target }));
}

function getPublishableReleaseTargets() {
  return getReleaseTargets().filter((target) => target.publishable);
}

function getReleaseArtifactTargets() {
  return getPublishableReleaseTargets().filter(
    (target) => target.packageStrategy === 'distinct' && target.artifactKey
  );
}

function getReleaseTarget(key) {
  return getReleaseTargets().find((target) => target.key === key) || null;
}

function getArtifactFileName(target, version) {
  if (target.artifactKey === 'chromium-family') {
    return `browser-cpp-chromium-family-v${version}.zip`;
  }
  return `browser-cpp-${target.key}-v${version}.zip`;
}

module.exports = {
  TARGETS,
  getArtifactFileName,
  getReleaseArtifactTargets,
  getPublishableReleaseTargets,
  getReleaseTarget,
  getReleaseTargets,
};
