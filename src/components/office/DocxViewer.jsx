import { useEffect, useRef, useState } from 'react';
import { useOfficeFile } from '../../hooks/useOfficeFile';
import { ViewerError, ViewerLoader } from './common';

/**
 * Aperçu local des `.docx` / `.docm` avec `docx-preview`.
 *
 * La librairie est chargée en `import()` dynamique pour ne pas alourdir le
 * bundle initial : le chunk n’est téléchargé qu’à l’ouverture d’un document.
 */
export default function DocxViewer({ file, onSwitchMode }) {
  const { buffer, loading, error } = useOfficeFile(file);
  const containerRef = useRef(null);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState('');

  useEffect(() => {
    if (!buffer || !containerRef.current) return undefined;

    let cancelled = false;
    const container = containerRef.current;
    container.innerHTML = '';
    setRendering(true);
    setRenderError('');

    import('docx-preview')
      .then(({ renderAsync }) => {
        if (cancelled) return null;
        return renderAsync(buffer, container, null, {
          inWrapper: true,
          breakPages: true,
          ignoreHeight: true,
        });
      })
      .catch((renderIssue) => {
        console.error('Cannot render docx locally', renderIssue);
        if (!cancelled) {
          setRenderError(
            'Ce document n’a pas pu être affiché localement '
            + '(mise en forme non prise en charge ou fichier endommagé).',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setRendering(false);
      });

    return () => {
      cancelled = true;
    };
  }, [buffer]);

  if (loading || (!buffer && !error)) {
    return <ViewerLoader message="Téléchargement du document…" />;
  }

  if (error) {
    return (
      <ViewerError
        file={file}
        message={error}
        action={onSwitchMode}
      />
    );
  }

  if (renderError) {
    return (
      <ViewerError
        file={file}
        message={renderError}
        action={onSwitchMode}
      />
    );
  }

  return (
    <div className="office-local-scroll">
      {rendering && <ViewerLoader message="Mise en page du document…" />}
      <div
        ref={containerRef}
        className="docx-preview"
        role="document"
        aria-label={`Contenu de ${file.name}`}
      />
    </div>
  );
}
