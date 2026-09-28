import { LibraryApiError } from './api';

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
