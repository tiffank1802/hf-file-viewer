import { useEffect, useState } from 'react';
import { MAX_LOCAL_PREVIEW_BYTES } from '../config';
import { fileProxyUrl } from '../services/api';
import { formatBytes } from '../utils/files';

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
        return response.arrayBuffer();
      })
      .then((arrayBuffer) => {
        if (arrayBuffer.byteLength > MAX_LOCAL_PREVIEW_BYTES) {
          throw new Error(
            `Ce fichier (${formatBytes(arrayBuffer.byteLength)}) dépasse la limite `
            + `d’aperçu local (${formatBytes(MAX_LOCAL_PREVIEW_BYTES)}).`,
          );
        }
        setBuffer(arrayBuffer);
      })
      .catch((fetchError) => {
        if (fetchError.name !== 'AbortError') setError(fetchError.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [file]);

  return { buffer, loading, error };
}
