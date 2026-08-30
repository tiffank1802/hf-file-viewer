import { useEffect, useState } from 'react';
import { FiDownload, FiExternalLink } from 'react-icons/fi';
import { OFFICE_WEB_VIEWER_BASE_URL } from '../config';
import { fileProxyUrl } from '../services/api';
import {
  extractUrlFromShortcut,
  formatBytes,
  getExtension,
  isOfficeExtension,
  isOfficeWebViewerExtension,
  isOneNoteExtension,
} from '../utils/files';
import { FileTypeIcon } from './Icons';

function OfficeFallback({ file, message }) {
  return (
    <div className="download-prompt office-fallback">
      <span className={`download-prompt-icon kind-${file.kind || 'office'}`}>
        <FileTypeIcon kind="office" size={34} />
      </span>
      <h3>Aperçu Office indisponible</h3>
      <p>{message}</p>
      <a href={fileProxyUrl(file.path, true)} download>
        <FiDownload aria-hidden="true" /> Télécharger · {formatBytes(file.size)}
      </a>
    </div>
  );
}

function ShortcutViewer({ file, targetUrl, loading }) {
  if (loading) {
    return (
      <div className="preview-loader">
        <span />
        <p>Lecture du raccourci…</p>
      </div>
    );
  }

  return (
    <div className="shortcut-preview">
      <span className="shortcut-icon"><FileTypeIcon kind="office" size={38} /></span>
      <h3>Raccourci Microsoft OneNote</h3>
      <p>Ce fichier `.url` pointe vers une ressource externe.</p>
      {targetUrl ? (
        <a className="shortcut-open" href={targetUrl} target="_blank" rel="noreferrer">
          <FiExternalLink aria-hidden="true" /> Ouvrir la ressource
        </a>
      ) : (
        <p className="shortcut-empty">Aucune adresse n’a été trouvée dans ce raccourci.</p>
      )}
      <a className="shortcut-download" href={fileProxyUrl(file.path, true)} download>
        <FiDownload aria-hidden="true" /> Télécharger · {formatBytes(file.size)}
      </a>
    </div>
  );
}

export default function OfficeViewer({ file }) {
  const extension = getExtension(file.path);
  const [shortcutContent, setShortcutContent] = useState('');
  const [shortcutLoading, setShortcutLoading] = useState(false);
  const [shortcutError, setShortcutError] = useState('');

  useEffect(() => {
    if (!file || !isOneNoteExtension(extension) || extension !== 'url') return undefined;

    const controller = new AbortController();
    setShortcutLoading(true);
    setShortcutError('');
    fetch(fileProxyUrl(file.path), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Raccourci indisponible.');
        return response.text();
      })
      .then((text) => setShortcutContent(text))
      .catch((error) => {
        if (error.name !== 'AbortError') setShortcutError(error.message);
      })
      .finally(() => setShortcutLoading(false));

    return () => controller.abort();
  }, [file, extension]);

  if (!isOfficeExtension(extension)) {
    return <OfficeFallback file={file} message="Ce format n’est pas pris en charge par le viewer Office." />;
  }

  if (extension === 'url') {
    if (shortcutError) {
      return <OfficeFallback file={file} message={shortcutError} />;
    }
    return (
      <ShortcutViewer
        file={file}
        loading={shortcutLoading}
        targetUrl={extractUrlFromShortcut(shortcutContent)}
      />
    );
  }

  if (isOneNoteExtension(extension)) {
    return (
      <OfficeFallback
        file={file}
        message="Les blocs-notes OneNote (`one`/`onenote`) ne peuvent pas être affichés dans un navigateur. Téléchargez le fichier pour l’ouvrir dans Microsoft OneNote."
      />
    );
  }

  if (!isOfficeWebViewerExtension(extension)) {
    return (
      <OfficeFallback
        file={file}
        message="Ce format OpenDocument n’est pas pris en charge par le viewer Office Web de Microsoft. Téléchargez le fichier pour le consulter."
      />
    );
  }

  const fileUrl = new URL(fileProxyUrl(file.path), window.location.origin).href;
  const viewerUrl = `${OFFICE_WEB_VIEWER_BASE_URL}?src=${encodeURIComponent(fileUrl)}`;

  return (
    <div className="office-web-preview">
      <iframe
        className="office-web-frame"
        src={viewerUrl}
        title={`Aperçu de ${file.name}`}
        allowFullScreen
      />
    </div>
  );
}
