import { useEffect, useState } from 'react';
import { FiDownload } from 'react-icons/fi';
import { OFFICE_WEB_VIEWER_BASE_URL } from '../config';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { fileProxyUrl } from '../services/api';
import {
  formatBytes,
  getExtension,
  isOfficeConvertibleExtension,
  isOfficeExtension,
  isOfficeWebViewerExtension,
  isOneNoteExtension,
  officeLocalKind,
} from '../utils/files';
import { FileTypeIcon } from './Icons';
import ConvertedPdfViewer from './office/ConvertedPdfViewer';
import DocxViewer from './office/DocxViewer';
import OfficeModeTabs from './office/OfficeModeTabs';
import PptxViewer from './office/PptxViewer';
import UrlViewer from './office/UrlViewer';
import XlsxViewer from './office/XlsxViewer';
import { ViewerLoader } from './office/common';

const OFFICE_MODE_KEY = 'enise-docs:office-mode';

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

function OfficeWebFrame({ file }) {
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

/** Demande au Worker si la conversion PDF LibreOffice est configurée. */
function useConvertStatus(enabled) {
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    if (!enabled) {
      setStatus('disabled');
      return undefined;
    }

    const controller = new AbortController();
    setStatus('loading');
    fetch('/api/office/status', {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
      .then((response) => (response.ok ? response.json() : { status: 'not-configured' }))
      .then((payload) => setStatus(payload.status === 'ready' ? 'ready' : 'not-configured'))
      .catch((error) => {
        if (error.name !== 'AbortError') setStatus('not-configured');
      });

    return () => controller.abort();
  }, [enabled]);

  return status;
}

export default function OfficeViewer({ file }) {
  const extension = getExtension(file.path);
  const localKind = officeLocalKind(extension);
  const convertible = isOfficeConvertibleExtension(extension);
  const microsoftable = isOfficeWebViewerExtension(extension);
  const convertStatus = useConvertStatus(convertible);
  const [storedMode, setStoredMode] = useLocalStorage(OFFICE_MODE_KEY, '');

  if (!isOfficeExtension(extension)) {
    return <OfficeFallback file={file} message="Ce format n’est pas pris en charge par le viewer Office." />;
  }

  if (extension === 'url') {
    return <UrlViewer file={file} />;
  }

  if (isOneNoteExtension(extension)) {
    return (
      <OfficeFallback
        file={file}
        message="Les blocs-notes OneNote (`one`/`onenote`) ne peuvent pas être affichés dans un navigateur. Téléchargez le fichier pour l’ouvrir dans Microsoft OneNote."
      />
    );
  }

  const modes = [];
  if (localKind === 'docx') {
    modes.push({ id: 'local', label: 'Aperçu local', hint: 'Rendu local dans le navigateur (gratuit, fonctionne partout)' });
  } else if (localKind === 'xlsx') {
    modes.push({ id: 'local', label: 'Aperçu local', hint: 'Classeur lu localement dans le navigateur (gratuit, fonctionne partout)' });
  } else if (localKind === 'pptx') {
    modes.push({ id: 'local', label: 'Texte local', hint: 'Texte des diapositives extrait localement (sans mise en forme)' });
  }
  if (convertible && convertStatus === 'ready') {
    modes.push({ id: 'pdf', label: 'PDF', hint: 'Rendu fidèle converti en PDF côté serveur' });
  }
  if (microsoftable) {
    modes.push({ id: 'microsoft', label: 'Microsoft', hint: 'Viewer Office Web de Microsoft (fidélité maximale, site public requis)' });
  }

  // Le statut de conversion est encore inconnu et aucun mode n’est tranché.
  if (modes.length === 0 && convertStatus === 'loading') {
    return <ViewerLoader message="Préparation de l’aperçu…" />;
  }

  if (modes.length === 0) {
    return (
      <OfficeFallback
        file={file}
        message="Ce format OpenDocument n’est pas pris en charge par le viewer Office Web de Microsoft et la conversion PDF n’est pas configurée sur ce site. Téléchargez le fichier pour le consulter."
      />
    );
  }

  const activeMode = modes.some((mode) => mode.id === storedMode) ? storedMode : modes[0].id;

  const switchActionFor = (currentId) => {
    const target = modes.find((mode) => mode.id !== currentId);
    if (!target) return null;
    return { label: `Essayer : ${target.label}`, onClick: () => setStoredMode(target.id) };
  };

  const renderMode = () => {
    if (activeMode === 'local' && localKind === 'docx') {
      return <DocxViewer file={file} onSwitchMode={switchActionFor('local')} />;
    }
    if (activeMode === 'local' && localKind === 'xlsx') {
      return <XlsxViewer file={file} onSwitchMode={switchActionFor('local')} />;
    }
    if (activeMode === 'local' && localKind === 'pptx') {
      return <PptxViewer file={file} onSwitchMode={switchActionFor('local')} />;
    }
    if (activeMode === 'pdf') {
      return <ConvertedPdfViewer file={file} onSwitchMode={switchActionFor('pdf')} />;
    }
    return <OfficeWebFrame file={file} />;
  };

  return (
    <div className="office-viewer">
      <OfficeModeTabs modes={modes} active={activeMode} onChange={setStoredMode} />
      <div className="office-viewer-body">
        {renderMode()}
      </div>
    </div>
  );
}
