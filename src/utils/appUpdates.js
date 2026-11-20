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
