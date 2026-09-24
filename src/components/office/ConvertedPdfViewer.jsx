import { useEffect, useState } from 'react';
import { officePdfUrl } from '../../services/api';
import { ViewerError, ViewerLoader } from './common';

/**
 * Affiche le PDF généré par le backend LibreOffice (`/api/office/pdf`).
 *
 * Le PDF est récupéré en `fetch` puis affiché via URL blob : contrairement à
 * un iframe direct, les erreurs (conversion impossible, backend non
 * configuré) sont détectées et affichées proprement au lieu d’une page vide.
 */
export default function ConvertedPdfViewer({ file, onSwitchMode }) {
  const [blobUrl, setBlobUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!file) return undefined;

    const controller = new AbortController();
    let objectUrl = '';
    setBlobUrl('');
    setError('');
    setLoading(true);

    fetch(officePdfUrl(file), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          return response.json()
            .catch(() => ({}))
            .then((payload) => {
              if (payload.status === 'not-configured') {
                throw new Error(
                  'La conversion PDF n’est pas configurée sur ce site. '
                  + 'Contactez l’administrateur ou utilisez un autre mode.',
                );
              }
              throw new Error(payload.error || 'La conversion en PDF a échoué.');
            });
        }
        return response.blob();
      })
      .then((blob) => {
        if (!blob || controller.signal.aborted) return;
        if (blob.type && !blob.type.includes('pdf')) {
          throw new Error('Le serveur n’a pas renvoyé un PDF valide.');
        }
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch((fetchError) => {
        if (fetchError.name !== 'AbortError') setError(fetchError.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  if (loading || (!blobUrl && !error)) {
    return (
      <ViewerLoader message="Conversion en PDF… (compter jusqu’à une minute si le service dormait)" />
    );
  }

  if (error) {
    return <ViewerError file={file} message={error} action={onSwitchMode} />;
  }

  return (
    <div className="office-web-preview">
      <iframe
        className="office-web-frame"
        src={blobUrl}
        title={`PDF converti de ${file.name}`}
        allowFullScreen
      />
    </div>
  );
}
