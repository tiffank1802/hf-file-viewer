import {
  FiArrowRight,
  FiDownload,
  FiEye,
  FiHeart,
} from 'react-icons/fi';
import { fileProxyUrl } from '../services/api';
import { formatBytes, formatCount, formatDate, getExtension, isPreviewable } from '../utils/files';
import { FileTypeIcon } from './Icons';

export default function FileItem({ item, view, onOpen, onNavigate, favorite, onToggleFavorite }) {
  const isFolder = item.type === 'directory';
  const extension = getExtension(item.path);
  const metadata = isFolder
    ? `${formatCount(item.count) || 'Plusieurs'} ressource${item.count === 1 ? '' : 's'}`
    : `${extension ? extension.toUpperCase() : 'FICHIER'} · ${formatBytes(item.size)}`;

  const handlePrimaryAction = () => {
    if (isFolder) onNavigate(item.path);
    else onOpen(item);
  };

  return (
    <article className={`file-item-card ${view === 'list' ? 'file-row' : ''} kind-${item.kind}`}>
      <button className="file-primary-action" type="button" onClick={handlePrimaryAction}>
        <span className="file-type-visual">
          <FileTypeIcon kind={item.kind} size={view === 'list' ? 21 : 26} />
          {!isFolder && extension && <small>{extension.slice(0, 4).toUpperCase()}</small>}
        </span>
        <span className="file-copy">
          <strong title={item.name}>{item.name}</strong>
          <small>{metadata}</small>
        </span>
        {view === 'list' && (
          <>
            <span className="file-date">{formatDate(item.mtime)}</span>
            <span className="file-size-column">{isFolder ? formatCount(item.count) || '—' : formatBytes(item.size)}</span>
          </>
        )}
        <span className="file-open-indicator" aria-hidden="true">
          {isFolder ? <FiArrowRight /> : isPreviewable(item) ? <FiEye /> : <FiDownload />}
        </span>
      </button>

      {!isFolder && (
        <div className="file-quick-actions">
          <button
            type="button"
            className={favorite ? 'is-favorite' : ''}
            onClick={() => onToggleFavorite(item)}
            aria-label={favorite ? `Retirer ${item.name} des favoris` : `Ajouter ${item.name} aux favoris`}
            title={favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
          >
            <FiHeart aria-hidden="true" />
          </button>
          <a
            href={fileProxyUrl(item.path, true)}
            download
            onClick={(event) => event.stopPropagation()}
            aria-label={`Télécharger ${item.name}`}
            title="Télécharger"
          >
            <FiDownload aria-hidden="true" />
          </a>
        </div>
      )}
    </article>
  );
}
