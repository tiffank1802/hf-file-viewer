import { useEffect, useRef, useState } from 'react';
import { FiDownload, FiInfo } from 'react-icons/fi';
import { AUTODESK_VIEWER_API_URL } from '../config';
import { fileProxyUrl } from '../services/api';
import { formatBytes } from '../utils/files';
import { FileTypeIcon } from './Icons';

const VIEWER_SCRIPT_ID = 'autodesk-viewer-api';
const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 2 * 60 * 1000;
const VIEWER_INIT_TIMEOUT_MS = 30 * 1000;

function AutodeskFallback({ file, message }) {
  return (
    <div className="download-prompt autodesk-fallback">
      <span className={`download-prompt-icon kind-${file.kind || 'model'}`}>
        <FileTypeIcon kind="model" size={34} />
      </span>
      <h3>Visionneuse 3D indisponible</h3>
      <p>{message}</p>
      <a href={fileProxyUrl(file.path, true)} download>
        <FiDownload aria-hidden="true" /> Télécharger · {formatBytes(file.size)}
      </a>
    </div>
  );
}

function viewerQuery(file) {
  const params = new URLSearchParams({ path: file.path });
  if (Number.isFinite(Number(file.size))) params.set('size', String(file.size));
  if (file.mtime) params.set('mtime', String(file.mtime));
  return params;
}

export default function AutodeskViewer({ file }) {
  const containerRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('Préparation du modèle 3D…');

  useEffect(() => {
    const container = containerRef.current;
    if (!file || !container) return undefined;

    let disposed = false;
    let viewerInstance = null;
    let script = null;
    let loadHandler = null;
    let errorHandler = null;
    let pollController = null;
    let viewerTimer = 0;
    let initTimer = 0;
    let forceRequested = false;
    let tokenError = '';
    let pendingUrn = '';

    setReady(false);
    setError('');
    setMessage('Connexion au service Autodesk…');

    const getAccessToken = (callback) => {
      fetch('/api/aps/token', { cache: 'no-store' })
        .then((response) => {
          if (!response.ok) throw new Error('Token Autodesk indisponible');
          return response.json();
        })
        .then((payload) => callback(payload.access_token, payload.expires_in))
        .catch((tokenIssue) => {
          console.error('Cannot retrieve Autodesk token', tokenIssue);
          tokenError = 'Le jeton Autodesk est indisponible. Vérifiez que les secrets APS sont configurés sur le Worker.';
          callback(null, 0);
        });
    };

    const onDocumentLoadSuccess = (doc) => {
      if (disposed || !viewerInstance) return;
      try {
        viewerInstance.loadDocumentNode(doc, doc.getRoot().getDefaultGeometry());
        setReady(true);
        setMessage('Modèle 3D chargé.');
      } catch (loadError) {
        console.error('Cannot load Autodesk model', loadError);
        setError('Le modèle 3D n’a pas pu être affiché. Téléchargez le fichier pour le consulter.');
      }
    };

    const onDocumentLoadFailure = (viewerErrorCode, viewerErrorMessage) => {
      console.error('Autodesk load failure', viewerErrorCode, viewerErrorMessage);
      if (!forceRequested) {
        forceRequested = true;
        setMessage('Relance de la conversion 3D…');
        requestModel(true);
        return;
      }
      setError('Le modèle 3D n’est pas disponible. Téléchargez le fichier pour le consulter.');
    };

    const initViewer = () =>
      new Promise((resolve) => {
        if (disposed) {
          resolve(false);
          return;
        }
        const Autodesk = window.Autodesk;
        if (!Autodesk || !Autodesk.Viewing) {
          setError('La bibliothèque Autodesk Viewer n’a pas pu être chargée.');
          resolve(false);
          return;
        }

        let finished = false;
        const finish = (value) => {
          if (finished || disposed) return;
          finished = true;
          if (initTimer) window.clearTimeout(initTimer);
          resolve(value);
        };

        initTimer = window.setTimeout(() => {
          const message = tokenError
            || 'Le Viewer Autodesk ne répond pas. Vérifiez que le site est accessible publiquement et que Autodesk peut joindre l’URL du fichier.';
          setError(message);
          finish(false);
        }, VIEWER_INIT_TIMEOUT_MS);

        Autodesk.Viewing.Initializer(
          {
            env: 'AutodeskProduction',
            getAccessToken,
          },
          () => {
            if (disposed) {
              finish(false);
              return;
            }
            if (tokenError) {
              setError(tokenError);
              finish(false);
              return;
            }
            try {
              const viewer = new Autodesk.Viewing.GuiViewer3D(container, {
                extensions: ['Autodesk.DocumentBrowser'],
              });
              viewerInstance = viewer;
              viewer.start();
              viewer.setTheme('light-theme');
              finish(true);
            } catch (initError) {
              console.error('Cannot start Autodesk viewer', initError);
              setError('La visionneuse 3D n’a pas pu démarrer.');
              finish(false);
            }
          },
        );
      });

    const loadModel = (urn) => {
      if (disposed) return;
      const Autodesk = window.Autodesk;
      if (!Autodesk || !Autodesk.Viewing) {
        pendingUrn = urn;
        setMessage('Préparation de la visionneuse 3D…');
        return;
      }
      if (!viewerInstance) {
        pendingUrn = urn;
        return;
      }
      setMessage('Chargement du modèle 3D…');
      Autodesk.Viewing.Document.load(
        `urn:${urn}`,
        onDocumentLoadSuccess,
        onDocumentLoadFailure,
      );
    };

    const flushPendingModel = () => {
      if (pendingUrn && viewerInstance) {
        loadModel(pendingUrn);
      }
    };

    const pollStatus = (attempt = 0) => {
      if (disposed) return;
      if (attempt > Math.ceil(MAX_WAIT_MS / POLL_INTERVAL_MS)) {
        setError('La conversion 3D est toujours en cours. Réessayez plus tard ou téléchargez le fichier.');
        return;
      }

      pollController = new AbortController();
      fetch(`/api/aps/status?${viewerQuery(file)}`, {
        cache: 'no-store',
        signal: pollController.signal,
      })
        .then((response) => {
          if (!response.ok) throw new Error('Statut Autodesk indisponible');
          return response.json();
        })
        .then((payload) => {
          if (disposed) return;
          if (payload.status === 'success' && payload.urn) {
            setMessage('Modèle 3D prêt.');
            loadModel(payload.urn);
            return;
          }
          if (payload.status === 'failed') {
            setError(payload.message || 'La conversion 3D a échoué.');
            return;
          }
          const progress = Number(payload.progress);
          if (Number.isFinite(progress) && progress > 0) {
            setMessage(`Conversion du modèle 3D… ${Math.round(progress)} %`);
          } else {
            setMessage('Conversion du modèle 3D en cours…');
          }
          viewerTimer = window.setTimeout(() => pollStatus(attempt + 1), POLL_INTERVAL_MS);
        })
        .catch((pollError) => {
          if (pollError.name === 'AbortError' || disposed) return;
          setError('La conversion 3D n’a pas pu être suivie. Téléchargez le fichier pour le consulter.');
        });
    };

    const requestModel = async (force = false) => {
      try {
        const params = viewerQuery(file);
        if (force) params.set('force', '1');
        const response = await fetch(`/api/aps/view?${params}`, {
          method: 'POST',
          cache: 'no-store',
        });
        const payload = await response.json();
        if (disposed) return;
        if (!response.ok) {
          setError(
            payload.status === 'not-configured'
              ? 'Autodesk APS n’est pas configuré sur ce site. Téléchargez le fichier pour le consulter.'
              : (payload.error || 'La préparation 3D a échoué.'),
          );
          return;
        }
        if (payload.status === 'success' && payload.urn) {
          setMessage('Modèle 3D prêt.');
          loadModel(payload.urn);
          return;
        }
        if (payload.status === 'failed') {
          setError(payload.message || 'La conversion 3D a échoué.');
          return;
        }
        pollStatus();
      } catch {
        if (disposed) return;
        setError('Le service 3D Autodesk est indisponible. Téléchargez le fichier pour le consulter.');
      }
    };

    const onLoad = () => {
      initViewer()
        .then((ready) => {
          if (disposed) return;
          flushPendingModel();
          if (ready) requestModel();
        });
    };
    const onError = () => {
      if (disposed) return;
      setError('Le script Autodesk Viewer n’a pas pu être chargé.');
    };

    if (typeof window.Autodesk !== 'undefined') {
      onLoad();
    } else {
      script = document.getElementById(VIEWER_SCRIPT_ID);
      if (script) {
        loadHandler = onLoad;
        errorHandler = onError;
        script.addEventListener('load', loadHandler, { once: true });
        script.addEventListener('error', errorHandler, { once: true });
      } else {
        script = document.createElement('script');
        script.id = VIEWER_SCRIPT_ID;
        script.src = AUTODESK_VIEWER_API_URL;
        script.async = true;
        script.onload = onLoad;
        script.onerror = onError;
        document.head.appendChild(script);
      }
    }

    return () => {
      disposed = true;
      pollController?.abort();
      if (viewerTimer) window.clearTimeout(viewerTimer);
      if (initTimer) window.clearTimeout(initTimer);
      if (script && loadHandler) script.removeEventListener('load', loadHandler);
      if (script && errorHandler) script.removeEventListener('error', errorHandler);
      if (viewerInstance) {
        try {
          if (typeof viewerInstance.finish === 'function') viewerInstance.finish();
          else if (typeof viewerInstance.uninitialize === 'function') viewerInstance.uninitialize();
        } catch {
          // Le viewer peut déjà être en cours de destruction.
        }
      }
    };
  }, [file]);

  if (error) return <AutodeskFallback file={file} message={error} />;

  return (
    <div className="autodesk-preview">
      {!ready && (
        <div className="preview-loader">
          <span />
          <p>{message}</p>
        </div>
      )}
      <div
        ref={containerRef}
        className="autodesk-viewer"
        role="region"
        aria-label={`Visionneuse 3D de ${file.name}`}
      />
      <div className="autodesk-hint">
        <FiInfo aria-hidden="true" />
        <span>Molette pour zoomer · clic gauche pour faire pivoter · clic droit pour déplacer.</span>
      </div>
    </div>
  );
}
