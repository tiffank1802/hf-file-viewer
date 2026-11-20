import { useEffect, useState } from 'react';
import { MAX_LOCAL_PREVIEW_BYTES } from '../config';
import { fileProxyUrl } from '../services/api';
import { formatBytes } from '../utils/files';

function tooLarge() {
  return new Error(`Ce fichier dépasse la limite d’aperçu local (${formatBytes(MAX_LOCAL_PREVIEW_BYTES)}).`);
}

async function readOfficeBuffer(response) {
  const header = response.headers.get('content-length');
  if (header && Number(header) > MAX_LOCAL_PREVIEW_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) return response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_LOCAL_PREVIEW_BYTES) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer.buffer;
}

/**
 * Télécharge un document Office via le proxy `/api/file` et expose son
 * contenu binaire aux visionneuses locales (`docx-preview`, `xlsx`, …).
 *
 * Les fichiers dépassant `MAX_LOCAL_PREVIEW_BYTES` sont refusés avant même
 * le téléchargement quand la taille est connue, afin de ne pas figer
 * l’onglet du navigateur.
 */
export function useOfficeFile(file) {
  const [buffer, setBuffer] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!file) return undefined;

    const knownSize = Number(file.size);
    if (Number.isFinite(knownSize) && knownSize > MAX_LOCAL_PREVIEW_BYTES) {
      setBuffer(null);
      setError(
        `Ce fichier (${formatBytes(knownSize)}) dépasse la limite d’aperçu local `
        + `(${formatBytes(MAX_LOCAL_PREVIEW_BYTES)}).`,
      );
      return undefined;
    }

    const controller = new AbortController();
    setBuffer(null);
    setError('');
    setLoading(true);

    fetch(fileProxyUrl(file.path), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Aperçu indisponible.');
        return readOfficeBuffer(response);
      })
      .then((arrayBuffer) => {
        if (arrayBuffer.byteLength > MAX_LOCAL_PREVIEW_BYTES) {
          throw new Error(
            `Ce fichier (${formatBytes(arrayBuffer.byteLength)}) dépasse la limite `
            + `d’aperçu local (${formatBytes(MAX_LOCAL_PREVIEW_BYTES)}).`,
          );
        }
        if (!controller.signal.aborted) setBuffer(arrayBuffer);
      })
      .catch((fetchError) => {
        if (!controller.signal.aborted && fetchError.name !== 'AbortError') setError(fetchError.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [file]);

  return { buffer, loading, error };
}
