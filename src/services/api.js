import { BUCKET_ID, BUCKET_URL } from '../config';
import { normalizeBucketItem } from '../utils/files';

export class LibraryApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'LibraryApiError';
    this.status = status;
  }
}

async function getJson(url, signal) {
  let response;
  try {
    response = await fetch(url, {
      signal,
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new LibraryApiError('Connexion au service documentaire impossible.');
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new LibraryApiError('Le service a renvoyé une réponse illisible.', response.status);
  }

  if (!response.ok) {
    throw new LibraryApiError(payload.error || 'Impossible de charger la bibliothèque.', response.status);
  }

  return {
    ...payload,
    cacheStatus: response.headers.get('X-Cache-Status') || 'BROWSER',
  };
}

export async function fetchTree(prefix = '', signal) {
  const params = new URLSearchParams();
  if (prefix) params.set('prefix', prefix);
  const suffix = params.size ? `?${params}` : '';
  const payload = await getJson(`/api/tree${suffix}`, signal);
  return {
    ...payload,
    items: (payload.items || []).map(normalizeBucketItem),
  };
}

export async function fetchIndex(signal) {
  const payload = await getJson('/api/index', signal);
  return {
    ...payload,
    items: (payload.items || []).map(normalizeBucketItem),
  };
}

export function fileProxyUrl(path, download = false) {
  const params = new URLSearchParams({ path });
  if (download) params.set('download', '1');
  return `/api/file?${params}`;
}

export function huggingFaceFileUrl(path) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `${BUCKET_URL}/resolve/${encodedPath}?download=false`;
}

export function huggingFaceFolderUrl(path = '') {
  if (!path) return BUCKET_URL;
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `${BUCKET_URL}/tree/${encodedPath}`;
}

export function bucketLabel() {
  return BUCKET_ID;
}
