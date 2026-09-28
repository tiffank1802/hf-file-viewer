import { LibraryApiError } from './api.js';

const RETRY_DELAYS = [200, 700];
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

async function readerJson(url, signal) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        signal,
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      lastError = new LibraryApiError('Connexion au lecteur documentaire impossible.');
      if (attempt >= RETRY_DELAYS.length) throw lastError;
      await abortableDelay(RETRY_DELAYS[attempt], signal);
      continue;
    }

    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    lastError = new LibraryApiError(payload.error || 'Le document structuré est indisponible.', response.status);
    if (!TRANSIENT_STATUSES.has(response.status) || attempt >= RETRY_DELAYS.length) throw lastError;
    const retryAfter = retryAfterMs(response.headers.get('Retry-After'));
    await abortableDelay(retryAfter ?? RETRY_DELAYS[attempt], signal);
  }
  throw lastError || new LibraryApiError('Le document structuré est indisponible.');
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

export function retryAfterMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.min(2000, Math.max(0, Number(raw) * 1000));
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.min(2000, Math.max(0, date - Date.now())) : null;
}

function abortableDelay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, Math.max(0, milliseconds));
    signal?.addEventListener('abort', aborted, { once: true });
    function cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', aborted);
    }
    function done() {
      cleanup();
      resolve();
    }
    function aborted() {
      cleanup();
      reject(abortError());
    }
  });
}

function abortError() {
  return new DOMException('La requête a été annulée.', 'AbortError');
}
