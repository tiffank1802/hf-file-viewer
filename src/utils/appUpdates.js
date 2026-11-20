const BUILD_ID = /^[a-f0-9]{32}$|^[a-f0-9]{40}$/;
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

export const RELEASE_API = 'https://api.github.com/repos/tiffank1802/hf-file-viewer/releases/latest';

export function getWebUpdate(current, payload) {
  const id = payload?.id;
  return typeof current === 'string' && BUILD_ID.test(current) && typeof id === 'string' && BUILD_ID.test(id) && current !== id ? id : null;
}

export function getNativeRelease(current, payload) {
  if (payload?.draft || payload?.prerelease) return null;
  const local = VERSION.exec(current ?? '');
  const remote = VERSION.exec(payload?.tag_name ?? '');
  if (!local || !remote) return null;
  for (let i = 1; i <= 3; i += 1) {
    const delta = Number(remote[i]) - Number(local[i]);
    if (delta) return delta > 0 ? remote[0].replace(/^v/, '') : null;
  }
  return null;
}

export async function fetchUpdateJson(url, signal) {
  const response = await fetch(url, {
    cache: 'no-store', signal, credentials: 'omit', headers: { Accept: 'application/json' },
  });
  if (!response.ok || !response.headers.get('Content-Type')?.includes('json')) return null;
  return response.json();
}

const PREVIEW = /^v(\d+)\.(\d+)\.(\d+)-test\.(\d+)$/;
const RELEASE_PAGE = 'https://github.com/tiffank1802/hf-file-viewer/releases/tag/';

function releaseParts(match, preview) {
  return [...match.slice(1, 4).map(Number), preview ? Number(match[4]) : Infinity];
}

function compareRelease(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

// The preview channel is set by the installer build, never inferred from the
// most recently published release. Stable installations never see test builds.
export function installedRelease(version, previewTag) {
  const stable = VERSION.exec(version ?? '');
  const preview = PREVIEW.exec(previewTag ?? '');
  return stable && preview && stable.slice(1, 4).join('.') === preview.slice(1, 4).join('.') ? previewTag : version;
}

export function findNativeUpdate(current, releases) {
  const preview = PREVIEW.exec(current ?? '');
  const stable = VERSION.exec(current ?? '');
  if ((!stable && !preview) || !Array.isArray(releases)) return null;
  const installed = releaseParts(preview || stable, Boolean(preview));
  let newest = null;
  for (const payload of releases) {
    if (!payload || payload.draft || typeof payload.tag_name !== 'string') continue;
    const isPreview = payload.prerelease === true;
    const match = isPreview ? preview && PREVIEW.exec(payload.tag_name) : VERSION.exec(payload.tag_name);
    if (!match) continue;
    const parts = releaseParts(match, isPreview);
    if (compareRelease(parts, installed) <= 0 || (newest && compareRelease(parts, newest.parts) <= 0)) continue;
    newest = { parts, version: payload.tag_name.replace(/^v/, ''), kind: isPreview ? 'preview' : 'release', url: `${RELEASE_PAGE}${encodeURIComponent(payload.tag_name)}` };
  }
  if (!newest) return null;
  const { version, kind, url } = newest;
  return { version, kind, url };
}
