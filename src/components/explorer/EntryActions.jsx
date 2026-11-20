import { useEffect, useRef, useState } from 'react';
import { FiArrowRight, FiDownload, FiEye, FiHeart, FiInfo, FiLink, FiShare2, FiX } from 'react-icons/fi';
import { fileProxyUrl, huggingFaceFileUrl } from '../../services/api';
import { itemType } from '../../utils/explorer';
import { formatBytes, formatDate, formatFolderCount } from '../../utils/files';
import { hrefFromLibraryPath } from '../../utils/routes';
import { FileTypeIcon } from '../Icons';

export default function EntryActions({ menu, favorite, onToggleFavorite, onOpen, onClose, tags = [], onToggleTag }) {
  const dialog = useRef(null);
  const infoHeading = useRef(null);
  const [info, setInfo] = useState(menu.info ?? false);
  const [message, setMessage] = useState('');
  const { item, trigger, x, y } = menu;
  const directory = item.type === 'directory';

  useEffect(() => {
    const node = dialog.current;
    node.showModal();
    return () => {
      node.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [trigger]);

  useEffect(() => {
    if (info) infoHeading.current?.focus();
  }, [info]);

  const getLink = () => directory ? new URL(hrefFromLibraryPath(item.path), window.location.origin).href : huggingFaceFileUrl(item.path);
  const share = async () => {
    try {
      await navigator.share({ title: item.name, url: getLink() });
    } catch (error) {
      if (error.name !== 'AbortError') setMessage('Partage indisponible. Essayez « Copier le lien ».');
    }
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(getLink());
      setMessage('Lien copié.');
    } catch {
      setMessage('Impossible de copier le lien dans ce navigateur.');
    }
  };
  const anchored = Number.isFinite(x) && Number.isFinite(y) && !info;
  const style = anchored ? { left: `clamp(8px, ${x}px, calc(100vw - min(280px, 90vw) - 8px))`, top: `clamp(8px, ${y}px, calc(100dvh - 300px))` } : undefined;
  return (
    <dialog ref={dialog} className={`finder-dialog ${anchored ? 'finder-dialog-anchored' : ''}`} style={style}
      aria-labelledby="finder-item-heading" onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="finder-dialog-content">
        <div className="finder-dialog-heading">
          <FileTypeIcon kind={item.kind} size={32} />
          <h3 id="finder-item-heading" ref={infoHeading} tabIndex={-1}>{info ? 'Lire les informations' : item.name}</h3>
          <button type="button" aria-label="Fermer" onClick={onClose}><FiX aria-hidden="true" /></button>
        </div>
        {info ? (
          <>
            <dl className="finder-info">
              <div><dt>Nom</dt><dd>{item.name}</dd></div>
              <div><dt>Type</dt><dd>{itemType(item)}</dd></div>
              <div><dt>Chemin</dt><dd>{item.path}</dd></div>
              <div><dt>{directory ? 'Contenu' : 'Taille'}</dt><dd>{directory ? formatFolderCount(item) : formatBytes(item.size)}</dd></div>
              <div><dt>Modification</dt><dd>{item.mtime ? formatDate(item.mtime) : '—'}</dd></div>
            </dl>
            {onToggleTag && (
              <fieldset className="finder-item-tags">
                <legend>Tags sur cet appareil</legend>
                {tags.map((tag) => (
                  <button key={tag.id} type="button" aria-pressed={tag.active} onClick={() => onToggleTag(item.path, tag.id)}>
                    <i style={{ background: tag.color }} aria-hidden="true" />{tag.label}
                  </button>
                ))}
              </fieldset>
            )}
            <button type="button" className="finder-dialog-back" onClick={() => setInfo(false)}>Voir les actions</button>
          </>
        ) : (
          <div className="finder-action-list">
            <button type="button" onClick={() => { onClose(); onOpen(item); }}>{directory ? <FiArrowRight aria-hidden="true" /> : <FiEye aria-hidden="true" />}{directory ? 'Ouvrir le dossier' : 'Coup d’œil'}</button>
            {!directory && <a href={fileProxyUrl(item.path, true)} download><FiDownload aria-hidden="true" />Télécharger</a>}
            <button type="button" onClick={copyLink}><FiLink aria-hidden="true" />Copier le lien</button>
            {typeof navigator.share === 'function' && <button type="button" onClick={share}><FiShare2 aria-hidden="true" />Partager</button>}
            <button type="button" aria-pressed={favorite} onClick={() => { onClose(); onToggleFavorite(item); }}><FiHeart aria-hidden="true" />{favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}</button>
            <button type="button" onClick={() => setInfo(true)}><FiInfo aria-hidden="true" />Lire les informations</button>
            {message && <p role="status">{message}</p>}
          </div>
        )}
      </div>
    </dialog>
  );
}
