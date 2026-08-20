import { useEffect, useRef, useState } from 'react';
import {
  FiCheck,
  FiDownload,
  FiExternalLink,
  FiHeart,
  FiShare2,
  FiX,
} from 'react-icons/fi';
import { fileProxyUrl, huggingFaceFileUrl } from '../services/api';
import { formatBytes, getExtension } from '../utils/files';
import { FileTypeIcon } from './Icons';

const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

function DownloadPrompt({ file }) {
  return (
    <div className="download-prompt">
      <span className={`download-prompt-icon kind-${file.kind}`}><FileTypeIcon kind={file.kind} size={34} /></span>
      <h3>Aperçu non disponible</h3>
      <p>Ce format s’ouvre mieux dans son application d’origine. Téléchargez le document pour le consulter.</p>
      <a href={fileProxyUrl(file.path, true)} download>
        <FiDownload aria-hidden="true" /> Télécharger · {formatBytes(file.size)}
      </a>
    </div>
  );
}

export default function PreviewModal({ file, onClose, favorite, onToggleFavorite }) {
  const [textContent, setTextContent] = useState('');
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState('');
  const [shared, setShared] = useState(false);
  const closeRef = useRef(null);

  useEffect(() => {
    if (!file) return undefined;
    const previousActiveElement = document.activeElement;
    document.body.classList.add('modal-open');
    closeRef.current?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.classList.remove('modal-open');
      window.removeEventListener('keydown', onKeyDown);
      previousActiveElement?.focus?.();
    };
  }, [file, onClose]);

  useEffect(() => {
    setTextContent('');
    setTextError('');
    setShared(false);
    if (!file || file.kind !== 'text') return undefined;
    if (file.size > MAX_TEXT_PREVIEW_BYTES) {
      setTextError('Ce fichier est trop volumineux pour un aperçu texte.');
      return undefined;
    }

    const controller = new AbortController();
    setTextLoading(true);
    fetch(fileProxyUrl(file.path), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Aperçu indisponible.');
        return response.text();
      })
      .then((text) => {
        if (getExtension(file.path) === 'json') {
          try {
            setTextContent(JSON.stringify(JSON.parse(text), null, 2));
            return;
          } catch {
            // Le JSON invalide est tout de même affiché comme texte brut.
          }
        }
        setTextContent(text);
      })
      .catch((error) => {
        if (error.name !== 'AbortError') setTextError(error.message);
      })
      .finally(() => setTextLoading(false));

    return () => controller.abort();
  }, [file]);

  if (!file) return null;

  const proxyUrl = fileProxyUrl(file.path);
  const extension = getExtension(file.path).toUpperCase() || 'FICHIER';

  const shareFile = async () => {
    const shareUrl = huggingFaceFileUrl(file.path);
    try {
      if (navigator.share) {
        await navigator.share({ title: file.name, text: `Ressource ENISE Docs : ${file.name}`, url: shareUrl });
      } else {
        await navigator.clipboard.writeText(shareUrl);
      }
      setShared(true);
      window.setTimeout(() => setShared(false), 1800);
    } catch (error) {
      if (error.name !== 'AbortError') setShared(false);
    }
  };

  const renderPreview = () => {
    if (file.kind === 'pdf') {
      return <iframe className="pdf-frame" src={proxyUrl} title={`Aperçu de ${file.name}`} />;
    }
    if (file.kind === 'image') {
      return <div className="image-preview"><img src={proxyUrl} alt={file.name} /></div>;
    }
    if (file.kind === 'video') {
      return <div className="media-preview"><video src={proxyUrl} controls preload="metadata" /></div>;
    }
    if (file.kind === 'audio') {
      return (
        <div className="audio-preview">
          <span><FileTypeIcon kind="audio" size={42} /></span>
          <h3>{file.name}</h3>
          <p>Ressource audio · {formatBytes(file.size)}</p>
          <audio src={proxyUrl} controls preload="metadata" />
        </div>
      );
    }
    if (file.kind === 'text') {
      if (textLoading) return <div className="preview-loader"><span /><p>Chargement de l’aperçu…</p></div>;
      if (textError) return <DownloadPrompt file={file} />;
      return <pre className="text-preview"><code>{textContent}</code></pre>;
    }
    return <DownloadPrompt file={file} />;
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="preview-modal" role="dialog" aria-modal="true" aria-labelledby="preview-title">
        <header className="preview-header">
          <div className="preview-file-heading">
            <span className={`preview-file-icon kind-${file.kind}`}><FileTypeIcon kind={file.kind} size={22} /></span>
            <div>
              <h2 id="preview-title">{file.name}</h2>
              <p>{extension} · {formatBytes(file.size)} · <span>Hugging Face</span></p>
            </div>
          </div>
          <div className="preview-actions">
            <button
              type="button"
              className={favorite ? 'is-favorite' : ''}
              onClick={() => onToggleFavorite(file)}
              aria-label={favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
              title={favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
            >
              <FiHeart aria-hidden="true" />
            </button>
            <button type="button" onClick={shareFile} aria-label="Partager" title="Partager">
              {shared ? <FiCheck aria-hidden="true" /> : <FiShare2 aria-hidden="true" />}
            </button>
            <a href={huggingFaceFileUrl(file.path)} target="_blank" rel="noreferrer" aria-label="Ouvrir la source" title="Ouvrir la source">
              <FiExternalLink aria-hidden="true" />
            </a>
            <a className="preview-download" href={fileProxyUrl(file.path, true)} download>
              <FiDownload aria-hidden="true" /><span>Télécharger</span>
            </a>
            <button ref={closeRef} className="preview-close" type="button" onClick={onClose} aria-label="Fermer l’aperçu">
              <FiX aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className={`preview-body preview-${file.kind}`}>{renderPreview()}</div>
        <footer className="preview-footer">
          <span>{file.path}</span>
          <span><i /> Servi via Cloudflare</span>
        </footer>
      </section>
    </div>
  );
}
