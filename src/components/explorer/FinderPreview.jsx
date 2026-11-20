import { useEffect, useState } from 'react';
import { FiDownload, FiEye, FiX } from 'react-icons/fi';
import { fileProxyUrl } from '../../services/api';
import { canPreviewInGallery, itemType } from '../../utils/explorer';
import { formatBytes, formatDate, formatFolderCount } from '../../utils/files';
import { INLINE_TEXT_LIMIT, readTextPreview } from '../../utils/textPreview';
import { FileTypeIcon } from '../Icons';

const PDF_INLINE_LIMIT = 20 * 1024 * 1024;
const supportedAudio = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
const supportedVideo = new Set(['mp4', 'webm']);

function TextSample({ url }) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal, headers: { Range: `bytes=0-${INLINE_TEXT_LIMIT - 1}` } })
      .then((response) => readTextPreview(response))
      .then((value) => { if (!controller.signal.aborted) setResult(value); })
      .catch(() => { if (!controller.signal.aborted) setResult({ error: true }); });
    return () => controller.abort();
  }, [url]);

  if (!result) return <p className="finder-preview-note" role="status">Chargement du texte…</p>;
  if (result.error) return <p className="finder-preview-note">Texte indisponible.</p>;
  return <>
    {result.text ? <pre className="finder-preview-text" tabIndex={0} aria-label="Extrait du fichier">{result.text}</pre>
      : <p className="finder-preview-note">Ce fichier est vide.</p>}
    {result.truncated && <p className="finder-preview-note">Extrait du début du fichier.</p>}
  </>;
}

function PreviewContent({ item, gallery }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const extension = itemType(item).toLowerCase();
  const alreadyInGallery = gallery && canPreviewInGallery(item);
  const renderable = item.type !== 'directory' && (canPreviewInGallery(item) || item.kind === 'text'
    || (item.kind === 'pdf' && item.size > 0 && item.size <= PDF_INLINE_LIMIT)
    || (item.kind === 'audio' && supportedAudio.has(extension))
    || (item.kind === 'video' && supportedVideo.has(extension)));

  // Navigating rapidly through the list should not start a series of loads.
  useEffect(() => {
    if (alreadyInGallery || !renderable) return undefined;
    const timer = window.setTimeout(() => setReady(true), 160);
    return () => window.clearTimeout(timer);
  }, [alreadyInGallery, renderable]);

  if (alreadyInGallery || !renderable || failed) return <div className="finder-preview-placeholder">
    <FileTypeIcon kind={item.kind} size={68} />
    {item.type === 'file' && !alreadyInGallery && <p>{failed ? 'Le navigateur ne peut pas afficher cet aperçu.' : 'Ouvre le fichier pour voir le document complet.'}</p>}
  </div>;
  if (!ready) return <div className="finder-preview-placeholder" role="status">Préparation de l’aperçu…</div>;

  const url = fileProxyUrl(item.path);
  if (item.kind === 'image') return <img className="finder-preview-image" src={url} alt={item.name} onError={() => setFailed(true)} />;
  if (item.kind === 'text') return <TextSample url={url} />;
  if (item.kind === 'pdf') return <iframe className="finder-preview-pdf" src={`${url}#page=1&toolbar=0&view=FitH`} title={`Prévisualisation PDF : ${item.name}`} />;
  if (item.kind === 'audio') return <audio className="finder-preview-media" controls preload="metadata" src={url} onError={() => setFailed(true)} />;
  return <video className="finder-preview-media" controls preload="metadata" src={url} onError={() => setFailed(true)} />;
}

export default function FinderPreview({ item, gallery, showDetails, onClose, onOpen }) {
  const directory = item?.type === 'directory';
  return (
    <aside className="finder-preview-pane" aria-label="Prévisualisation">
      <header><h3><FiEye aria-hidden="true" /> Prévisualisation</h3><button type="button" onClick={onClose} aria-label="Masquer la prévisualisation"><FiX aria-hidden="true" /></button></header>
      {!item ? <div className="finder-preview-placeholder finder-preview-unselected"><FiEye aria-hidden="true" /><p>Sélectionne un fichier ou un dossier.</p></div> : <>
        <div className="finder-preview-body"><PreviewContent key={`${item.path}:${item.mtime}:${gallery}`} {...{ item, gallery }} /></div>
        <div className="finder-preview-caption">
          <strong>{item.name}</strong>
          {showDetails && <dl className="finder-preview-details">
            <div><dt>Type</dt><dd>{itemType(item)}</dd></div>
            <div><dt>{directory ? 'Contenu' : 'Taille'}</dt><dd>{directory ? formatFolderCount(item) : formatBytes(item.size)}</dd></div>
            <div><dt>Modification</dt><dd>{item.mtime ? formatDate(item.mtime) : '—'}</dd></div>
            <div><dt>Chemin</dt><dd>{item.path}</dd></div>
          </dl>}
          <div className="finder-preview-actions">
            <button type="button" onClick={() => onOpen(item)}>{directory ? 'Ouvrir le dossier' : 'Ouvrir en grand'}</button>
            {!directory && <a href={fileProxyUrl(item.path, true)} download aria-label={`Télécharger ${item.name}`}><FiDownload aria-hidden="true" /></a>}
          </div>
        </div>
      </>}
    </aside>
  );
}
