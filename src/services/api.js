import { BUCKET_ID, BUCKET_URL } from '../config.js';
import { normalizeBucketItem } from '../utils/files.js';

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

export async function fetchCounts(prefix = '', signal) {
  const params = new URLSearchParams();
  if (prefix) params.set('prefix', prefix);
  const suffix = params.size ? `?${params}` : '';
  const payload = await getJson(`/api/counts${suffix}`, signal);
  return {
    ...payload,
    counts: payload.counts && typeof payload.counts === 'object' ? payload.counts : {},
    totalFiles: Number.isFinite(Number(payload.totalFiles)) ? Number(payload.totalFiles) : null,
    dataSource: payload.source || 'index-json',
  };
}

export async function fetchIndex(signal) {
  const payload = await getJson('/api/index', signal);
  return {
    ...payload,
    items: (payload.items || []).map(normalizeBucketItem),
    counts: payload.counts && typeof payload.counts === 'object' ? payload.counts : {},
    totalFiles: Number.isFinite(Number(payload.totalFiles)) ? Number(payload.totalFiles) : null,
    dataSource: payload.source || 'index-json',
  };
}

export function fileProxyUrl(path, download = false) {
  const params = new URLSearchParams({ path });
  if (download) params.set('download', '1');
  return `/api/file?${params}`;
}

/**
 * URL du PDF généré par le backend LibreOffice pour un document Office.
 * `size` et `mtime` stabilisent la clé de cache côté Worker.
 */
export function officePdfUrl(file) {
  const params = new URLSearchParams({ path: file.path });
  if (Number.isFinite(Number(file.size))) params.set('size', String(file.size));
  if (file.mtime) params.set('mtime', String(file.mtime));
  return `/api/office/pdf?${params}`;
}

/**
 * URL du GLB généré par le backend FreeCAD pour un modèle 3D.
 * `quality` vaut draft, standard ou fine et fait partie de la clé de cache.
 */
export function model3dGlbUrl(file, quality = 'standard') {
  const params = new URLSearchParams({ path: file.path, quality });
  if (Number.isFinite(Number(file.size))) params.set('size', String(file.size));
  if (file.mtime) params.set('mtime', String(file.mtime));
  return `/api/model3d/glb?${params}`;
}

const SHARECAD_FRAME_URL = 'https://iframe.sharecad.org/cadframe/load';

/**
 * URL proxy « propre » du fichier (`/api/file/<chemin>`, sans query string).
 * ShareCAD détecte le format CAO depuis l’extension dans l’URL : sans elle
 * (ou avec une URL à paramètres), son convertisseur ne démarre pas.
 */
export function shareCadFileUrl(file) {
  const suffix = String(file.path || '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `/api/file/${suffix}`;
}

/**
 * URL de l’iframe ShareCAD pour un fichier (proxy ci-dessus en absolu, encodé).
 * Les serveurs ShareCAD téléchargent le fichier depuis cette URL publique.
 */
export function shareCadFrameUrl(file) {
  const absoluteUrl = `${window.location.origin}${shareCadFileUrl(file)}`;
  return `${SHARECAD_FRAME_URL}?url=${encodeURIComponent(absoluteUrl)}`;
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
