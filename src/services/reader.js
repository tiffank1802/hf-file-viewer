import { LibraryApiError } from './api.js';

async function readerJson(url, signal) {
  let response;
  try {
    response = await fetch(url, {
      signal,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new LibraryApiError('Connexion au lecteur documentaire impossible.');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new LibraryApiError(payload.error || 'Le document structuré est indisponible.', response.status);
  }
  return payload;
}

export function fetchReaderDocument(sourcePath, artifactId = '', signal) {
  const params = new URLSearchParams({ path: sourcePath });
  if (artifactId) params.set('artifactId', artifactId);
  return readerJson(`/api/reader/document?${params}`, signal);
}

export function fetchReaderPage(sourcePath, artifactId, page, signal) {
  const params = new URLSearchParams({
    path: sourcePath,
    artifactId,
    page: String(page),
  });
  return readerJson(`/api/reader/page?${params}`, signal);
}

export function fetchReaderBlocks(sourcePath, artifactId, from = 1, limit = 40, signal) {
  const params = new URLSearchParams({
    path: sourcePath,
    artifactId,
    from: String(from),
    limit: String(limit),
  });
  return readerJson(`/api/reader/blocks?${params}`, signal);
}

export function fetchReaderBlock(sourcePath, artifactId, blockId, signal) {
  const params = new URLSearchParams({
    path: sourcePath,
    artifactId,
    blockId,
    limit: '8',
  });
  return readerJson(`/api/reader/blocks?${params}`, signal);
}

export function readerAssetUrl(sourcePath, artifactId, assetId) {
  const params = new URLSearchParams({
    path: sourcePath,
    artifactId,
    asset: assetId,
  });
  return `/api/reader/asset?${params}`;
}
