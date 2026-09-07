import { useEffect, useState } from 'react';
import {
  FiCheck,
  FiCopy,
  FiDownload,
  FiExternalLink,
  FiLock,
} from 'react-icons/fi';
import { fileProxyUrl } from '../../services/api';
import {
  describeShortcutTarget,
  formatBytes,
  parseInternetShortcut,
} from '../../utils/files';
import { FileTypeIcon } from '../Icons';
import { ViewerError, ViewerLoader } from './common';

function displayHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function displayUrl(url) {
  const value = String(url || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  return value.length > 90 ? `${value.slice(0, 87)}…` : value;
}

/**
 * Visualisation des raccourcis Windows `.url` (dont liens OneNote).
 *
 * Le fichier est parsé localement, puis la cible http(s) est enrichie via
 * `/api/link/preview` (titre, description, image Open Graph). Tout échec
 * d’enrichissement dégrade gracieusement vers une carte simple avec bouton
 * d’ouverture : l’aperçu ne bloque jamais l’accès au lien.
 */
export default function UrlViewer({ file }) {
  const [shortcut, setShortcut] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewReason, setPreviewReason] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [imageVisible, setImageVisible] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!file) return undefined;

    const controller = new AbortController();
    setShortcut(null);
    setPreview(null);
    setPreviewReason('');
    setError('');
    setLoading(true);

    fetch(fileProxyUrl(file.path), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Raccourci indisponible.');
        return response.text();
      })
      .then((text) => setShortcut(parseInternetShortcut(text)))
      .catch((fetchError) => {
        if (fetchError.name !== 'AbortError') setError(fetchError.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [file]);

  const target = shortcut?.url || '';
  const targetInfo = describeShortcutTarget(target);

  useEffect(() => {
    setPreview(null);
    setPreviewReason('');
    setImageVisible(true);
    if (!target) return undefined;
    const kind = describeShortcutTarget(target).kind;
    if (kind !== 'web' && kind !== 'onenote-web') return undefined;

    const controller = new AbortController();
    setPreviewLoading(true);
    fetch(`/api/link/preview?url=${encodeURIComponent(target)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!payload) return;
        if (payload.ok) setPreview(payload);
        else if (payload.reason) setPreviewReason(payload.reason);
      })
      .catch(() => {
        // Aperçu indisponible : la carte simple reste affichée.
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewLoading(false);
      });

    return () => controller.abort();
  }, [target]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(target);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  if (loading || (!shortcut && !error)) {
    return <ViewerLoader message="Lecture du raccourci…" />;
  }

  if (error) {
    return <ViewerError file={file} message={error} action={null} />;
  }

  if (!target) {
    return (
      <ViewerError
        file={file}
        message="Aucune adresse n’a été trouvée dans ce raccourci."
        action={null}
      />
    );
  }

  const canOpen = ['web', 'onenote-web', 'onenote-app', 'unknown'].includes(targetInfo.kind);
  const title = preview?.title || displayHost(target) || file.name;
  const showAuthHelp = previewReason === 'auth-required' && targetInfo.kind === 'onenote-web';

  return (
    <div className="office-local-scroll url-preview">
      <div className="url-card">
        {preview?.image && imageVisible && (
          <div className="url-cover">
            <img
              src={preview.image}
              alt=""
              loading="lazy"
              onError={() => setImageVisible(false)}
            />
          </div>
        )}
        <div className="url-body">
          <div className="url-heading">
            <span className="url-icon"><FileTypeIcon kind="office" size={26} /></span>
            <div>
              <p className={`url-badge kind-${targetInfo.kind}`}>{targetInfo.label}</p>
              <h3>{title}</h3>
            </div>
          </div>

          {preview?.description && <p className="url-description">{preview.description}</p>}
          {(preview?.siteName || displayHost(target)) && (
            <p className="url-site">{preview?.siteName || displayHost(target)}</p>
          )}
          <p className="url-target" title={target}>{displayUrl(target)}</p>

          {showAuthHelp && (
            <div className="url-auth" role="note">
              <p className="url-auth-title">
                <FiLock aria-hidden="true" /> Contenu privé — connexion Microsoft requise
              </p>
              <p>
                Ce carnet n’est visible que par son propriétaire : les autres
                visiteurs ne peuvent pas le consulter depuis ce lien. Pour le
                rendre visualisable comme les autres documents :
              </p>
              <ol>
                <li>
                  partagez-le en «&nbsp;Toute personne disposant du lien peut
                  afficher&nbsp;» depuis OneDrive/OneNote&nbsp;;
                </li>
                <li>
                  ou exportez les pages en <strong>PDF</strong> ou{' '}
                  <strong>Word</strong> (OneNote → Fichier → Exporter) puis
                  déposez le fichier dans la bibliothèque.
                </li>
              </ol>
            </div>
          )}

          {targetInfo.kind === 'file' && (
            <p className="url-hint">
              Ce raccourci pointe vers un fichier de l’ordinateur d’origine :
              il ne peut pas être ouvert depuis le navigateur.
            </p>
          )}
          {targetInfo.kind === 'onenote-app' && (
            <p className="url-hint">
              Ce lien applicatif ouvre le bloc-notes dans Microsoft OneNote
              installé sur votre appareil.
            </p>
          )}
          {previewLoading && <p className="url-loading">Récupération de l’aperçu du lien…</p>}

          <div className="url-actions">
            {canOpen && (
              <a className="url-open" href={target} target="_blank" rel="noreferrer">
                <FiExternalLink aria-hidden="true" /> Ouvrir la ressource
              </a>
            )}
            <button type="button" className="url-copy" onClick={copyLink} title="Copier le lien">
              {copied ? <FiCheck aria-hidden="true" /> : <FiCopy aria-hidden="true" />}
              {copied ? 'Copié !' : 'Copier'}
            </button>
            <a className="url-download" href={fileProxyUrl(file.path, true)} download>
              <FiDownload aria-hidden="true" /> .url · {formatBytes(file.size)}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
