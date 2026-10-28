import { useEffect, useMemo, useRef, useState } from 'react';
import { FiDownload, FiExternalLink, FiInfo, FiShield, FiX } from 'react-icons/fi';
import {
  APP_PLATFORMS,
  buildAppAssetUrl,
  detectClientPlatform,
  getPlatformById,
  resolveReleasePageUrl,
} from '../utils/appDownloads.js';
import { isTauriRuntime, openExternalUrl } from '../utils/runtime.js';

function PlatformGlyph({ id }) {
  if (id === 'windows') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
        <path d="M3 5.3 10.8 4.2v7.2H3V5.3Zm8.8-1.2L21 2.8v8.6h-9.2V4.1ZM3 12.6h7.8v7.2L3 18.7v-6.1Zm8.8 0H21v8.6l-9.2-1.3v-7.3Z" />
      </svg>
    );
  }
  if (id === 'macos' || id === 'ios') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
        <path d="M16.7 12.7c0-2.2 1.8-3.3 1.9-3.4-1-1.5-2.6-1.7-3.2-1.8-1.4-.1-2.6.8-3.3.8-.7 0-1.8-.8-2.9-.8-1.5 0-2.9.9-3.7 2.2-1.6 2.7-.4 6.8 1.1 9 .7 1.1 1.6 2.3 2.8 2.2 1.1 0 1.6-.7 2.9-.7 1.4 0 1.8.7 3 .7 1.2 0 2-1.1 2.7-2.2.9-1.3 1.2-2.5 1.2-2.6-.1 0-2.5-1-2.5-3.4ZM14.4 6c.6-.8 1.1-1.8 1-2.9-.9 0-2 .6-2.7 1.4-.6.7-1.1 1.8-1 2.8 1 .1 2.1-.5 2.7-1.3Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M17.6 9.5 19.4 6.4a.5.5 0 0 0-.9-.5l-1.9 3.2a11.3 11.3 0 0 0-9.2 0L5.5 5.9a.5.5 0 1 0-.9.5l1.8 3.1A9.7 9.7 0 0 0 2 17.5h20a9.7 9.7 0 0 0-4.4-8ZM7.5 14.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm9 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
    </svg>
  );
}

export default function AppDownloadModal({ open, onClose }) {
  const client = useMemo(() => detectClientPlatform(), []);
  const [selectedId, setSelectedId] = useState(client.id || 'windows');
  const closeRef = useRef(null);
  const dialogRef = useRef(null);
  const inTauri = isTauriRuntime();

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    document.body.classList.add('modal-open');
    closeRef.current?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll('a[href], button:not([disabled])');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.classList.remove('modal-open');
      window.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const activePlatform = getPlatformById(selectedId);
  const primaryUrl = buildAppAssetUrl(activePlatform.primary.fileName);
  const secondaryUrl = activePlatform.secondary ? buildAppAssetUrl(activePlatform.secondary.fileName) : '';
  const checksumsUrl = buildAppAssetUrl('SHA256SUMS.txt');
  const releasePageUrl = resolveReleasePageUrl();

  const handleExternalClick = (event, url) => {
    if (inTauri) {
      event.preventDefault();
      void openExternalUrl(url);
    }
  };

  return (
    <div
      className="modal-backdrop auth-backdrop app-download-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        ref={dialogRef}
        className="app-download-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-download-title"
        aria-describedby="app-download-intro"
      >
        <button
          ref={closeRef}
          type="button"
          className="auth-close"
          onClick={onClose}
          aria-label="Fermer la fenêtre de téléchargement"
        >
          <FiX aria-hidden="true" />
        </button>

        <div className="app-download-head">
          <span className="app-download-badge">Application pour ordinateur et mobile</span>
          <h2 id="app-download-title">Télécharger ENISE Docs</h2>
          <p id="app-download-intro">Choisissez votre appareil pour télécharger l’application. Les fichiers sont hébergés sur GitHub Releases.</p>
        </div>

        <div className="app-download-featured" aria-live="polite">
          <div className="app-download-featured-info">
            <span className="app-download-os-icon is-featured">
              <PlatformGlyph id={activePlatform.id} />
            </span>
            <div>
              <div className="app-download-featured-title">
                <strong>{activePlatform.label}</strong>
                {client.detected && client.id === activePlatform.id && (
                  <span className="app-download-detected-pill">Votre appareil</span>
                )}
              </div>
              <small>{activePlatform.subtitle}</small>
            </div>
          </div>

          <div className="app-download-featured-actions">
            <a className="app-download-primary-btn" href={primaryUrl} onClick={(event) => handleExternalClick(event, primaryUrl)}>
              <FiDownload aria-hidden="true" />
              <span>{activePlatform.primary.label}</span>
            </a>
            {activePlatform.secondary && (
              <div className="app-download-subactions">
                <a className="app-download-secondary-link" href={secondaryUrl} onClick={(event) => handleExternalClick(event, secondaryUrl)}>
                  {activePlatform.secondary.label}
                </a>
              </div>
            )}
          </div>

          <p className="app-download-note">
            <FiInfo aria-hidden="true" />
            <span>{activePlatform.note}</span>
          </p>
        </div>

        <ul className="app-download-grid" aria-label="Choisir une plateforme">
          {APP_PLATFORMS.map((platform) => (
            <li key={platform.id}>
              <button
                type="button"
                className={`app-download-tile ${platform.id === activePlatform.id ? 'is-active' : ''}`}
                aria-pressed={platform.id === activePlatform.id}
                onClick={() => setSelectedId(platform.id)}
              >
                <span className="app-download-os-icon"><PlatformGlyph id={platform.id} /></span>
                <span className="app-download-tile-meta">
                  <strong>{platform.label}</strong>
                  <small>{platform.primary.shortLabel}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="app-download-footer">
          <a href={checksumsUrl} onClick={(event) => handleExternalClick(event, checksumsUrl)}>
            <FiShield aria-hidden="true" /> Empreintes SHA-256
          </a>
          <a href={releasePageUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => handleExternalClick(event, releasePageUrl)}>
            Toutes les versions GitHub <FiExternalLink aria-hidden="true" />
          </a>
        </div>
      </div>
    </div>
  );
}
