import { FiDownload } from 'react-icons/fi';
import { fileProxyUrl } from '../../services/api';
import { formatBytes } from '../../utils/files';
import { FileTypeIcon } from '../Icons';

export function ViewerLoader({ message = 'Chargement de l’aperçu…' }) {
  return (
    <div className="preview-loader">
      <span />
      <p>{message}</p>
    </div>
  );
}

export function ViewerError({ file, message, action }) {
  return (
    <div className="download-prompt office-fallback">
      <span className={`download-prompt-icon kind-${file.kind || 'office'}`}>
        <FileTypeIcon kind={file.kind || 'office'} size={34} />
      </span>
      <h3>Aperçu indisponible</h3>
      <p>{message}</p>
      <div className="viewer-error-actions">
        {action && (
          <button type="button" className="viewer-switch" onClick={action.onClick}>
            {action.label}
          </button>
        )}
        <a href={fileProxyUrl(file.path, true)} download>
          <FiDownload aria-hidden="true" /> Télécharger · {formatBytes(file.size)}
        </a>
      </div>
    </div>
  );
}
