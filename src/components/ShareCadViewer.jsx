import { useState } from 'react';
import { FiDownload, FiPlay } from 'react-icons/fi';
import { fileProxyUrl, shareCadFrameUrl } from '../services/api';
import { formatBytes } from '../utils/files';
import { FileTypeIcon } from './Icons';
import { ViewerError } from './office/common';

const MAX_SHARECAD_BYTES = 50 * 1024 * 1024;

/**
 * Aperçu via le plugin iframe gratuit ShareCAD (DWG, STEP, SLDPRT… sans
 * conversion ni compte). Le fichier transite par les serveurs ShareCAD
 * (stocké chez eux, limite 50 Mo) : chargement sur clic explicite uniquement.
 */
export default function ShareCadViewer({ file }) {
  const [loaded, setLoaded] = useState(false);

  const size = Number(file.size);
  if (Number.isFinite(size) && size > MAX_SHARECAD_BYTES) {
    return (
      <ViewerError
        file={file}
        message={`Ce fichier dépasse la limite ShareCAD (50 Mo, ici ${formatBytes(file.size)}).`}
        action={null}
      />
    );
  }

  if (!loaded) {
    return (
      <div className="download-prompt sharecad-consent">
        <span className={`download-prompt-icon kind-${file.kind || 'model'}`}>
          <FileTypeIcon kind="model" size={34} />
        </span>
        <h3>Aperçu ShareCAD</h3>
        <p>
          Service tiers gratuit : en chargeant l’aperçu, le fichier sera téléchargé
          et stocké sur les serveurs de <strong>sharecad.org</strong> (limite 50 Mo).
          À réserver aux documents non confidentiels.
        </p>
        <div className="viewer-error-actions">
          <button type="button" className="viewer-switch" onClick={() => setLoaded(true)}>
            <FiPlay aria-hidden="true" /> Charger l’aperçu ShareCAD
          </button>
          <a href={fileProxyUrl(file.path, true)} download>
            <FiDownload aria-hidden="true" /> Télécharger · {formatBytes(file.size)}
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="sharecad-viewer">
      <iframe
        title={`Aperçu ShareCAD de ${file.name}`}
        src={shareCadFrameUrl(file)}
        scrolling="no"
        className="sharecad-frame"
      />
    </div>
  );
}
