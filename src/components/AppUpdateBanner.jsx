import { useEffect, useRef, useState } from 'react';
import { FiRefreshCw } from 'react-icons/fi';
import { DEFAULT_RELEASE_PAGE_URL } from '../utils/appDownloads';
import { fetchUpdateJson, findNativeUpdate, getNativeRelease, getWebUpdate, installedRelease } from '../utils/appUpdates';
import { CHECK_UPDATE_EVENT, requestUpdateCheck } from '../utils/finderCommands';
import { isTauriRuntime, openExternalUrl } from '../utils/runtime';

const CHECK_PERIOD = 5 * 60_000;
const MIN_CHECK_GAP = 30_000;
const DOWNLOAD_TIMEOUT = 4 * 60_000;

async function releaseUpdate(update) {
  await update?.close().catch(() => {});
}

export default function AppUpdateBanner({ suspended = false }) {
  const [offer, setOffer] = useState(null);
  const [dismissed, setDismissed] = useState('');
  const [manual, setManual] = useState(false);
  const [checkState, setCheckState] = useState('');
  const [current, setCurrent] = useState('');
  const [phase, setPhase] = useState('');
  const signed = useRef(null);
  const running = useRef(false);
  const installedVersion = useRef(null);
  const inTauri = isTauriRuntime();
  const webBuild = import.meta.env.VITE_ENISE_BUILD_ID;
  const useUpdater = import.meta.env.VITE_ENISE_SIGNED_UPDATER === '1';
  const previewTag = import.meta.env.VITE_ENISE_PREVIEW_TAG;

  useEffect(() => {
    if (!inTauri && !webBuild) return undefined;
    const controller = new AbortController();
    const { signal } = controller;
    let lastCheck = -Infinity;
    let checking = false;
    const check = async (force = false) => {
      if (signal.aborted || document.visibilityState === 'hidden' || running.current || installedVersion.current || signed.current || checking || (!force && Date.now() - lastCheck < MIN_CHECK_GAP)) return;
      checking = true;
      lastCheck = Date.now();
      setCheckState('checking');
      try {
        if (!inTauri) {
          const payload = await fetchUpdateJson('/version.json', signal);
          if (!signal.aborted && payload?.id) setOffer(getWebUpdate(webBuild, payload) ? { version: payload.id, kind: 'web' } : null);
          return;
        }
        const { getVersion } = await import('@tauri-apps/api/app');
        const version = installedRelease(await getVersion(), previewTag);
        if (signal.aborted) return;
        setCurrent(version);
        if (useUpdater && !previewTag) {
          let update;
          try {
            const { check: findSignedUpdate } = await import('@tauri-apps/plugin-updater');
            update = await findSignedUpdate({ timeout: 10_000 });
          } catch { /* No signed feed for this package: retain release notifications. */ }
          if (update) {
            if (signal.aborted || !getNativeRelease(version, { tag_name: update.version })) {
              await releaseUpdate(update);
              if (signal.aborted) return;
            } else {
              setOffer({ version: update.version, kind: 'signed' });
              setPhase('downloading');
              try {
                // Tauri verifies the artifact signature before retaining the bytes.
                await update.download(undefined, { timeout: DOWNLOAD_TIMEOUT });
                if (signal.aborted) { await releaseUpdate(update); return; }
                signed.current = update;
                setPhase('ready');
              } catch {
                await releaseUpdate(update);
                if (!signal.aborted) setPhase('download-error');
              }
              return;
            }
          }
        }
        if (signal.aborted) return;
        const { invoke } = await import('@tauri-apps/api/core');
        const releases = await invoke('list_app_releases');
        if (!Array.isArray(releases)) throw new Error('invalid releases');
        if (!signal.aborted) { setOffer(findNativeUpdate(version, releases)); setPhase(''); }
      } catch {
        if (!signal.aborted) { setCheckState('error'); setOffer(null); setPhase(''); }
      } finally {
        checking = false;
        if (!signal.aborted) setCheckState((state) => state === 'checking' ? 'done' : state);
      }
    };
    const automatic = () => { void check(); };
    const manualCheck = () => {
      setManual(true);
      setDismissed('');
      void check(true);
    };
    automatic();
    const timer = window.setInterval(automatic, CHECK_PERIOD);
    window.addEventListener(CHECK_UPDATE_EVENT, manualCheck);
    window.addEventListener('focus', automatic);
    window.addEventListener('online', automatic);
    document.addEventListener('visibilitychange', automatic);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener(CHECK_UPDATE_EVENT, manualCheck);
      window.removeEventListener('focus', automatic);
      window.removeEventListener('online', automatic);
      document.removeEventListener('visibilitychange', automatic);
      if (!running.current) void releaseUpdate(signed.current);
      signed.current = null;
    };
  }, [inTauri, previewTag, webBuild, useUpdater]);

  const activeOffer = offer && offer.version !== dismissed ? offer : null;
  if ((suspended && !manual) || (!manual && !activeOffer)) return null;

  const updateNow = async () => {
    if (!activeOffer) return;
    if (activeOffer.kind === 'web') { window.location.reload(); return; }
    if (activeOffer.url) { await openExternalUrl(activeOffer.url); return; }
    if (phase === 'download-error' || phase === 'install-error') { requestUpdateCheck(); return; }
    const update = signed.current;
    if (suspended || phase !== 'ready' || !update || running.current) return;
    running.current = true;
    setPhase('installing');
    let result = 'install-error';
    try {
      // On Windows Tauri launches the updater and exits; on macOS/Linux the
      // running process is unaffected until the user reopens the application.
      await update.install();
      installedVersion.current = update.version;
      result = 'installed';
    } catch {
      // The failed installation may have consumed the staged bytes.
    } finally {
      signed.current = null;
      await releaseUpdate(update);
      running.current = false;
      setPhase(result);
    }
  };
  const installed = phase === 'installed';
  const busy = phase === 'downloading' || phase === 'installing';
  const failed = phase === 'download-error' || phase === 'install-error';
  const status = {
    downloading: 'Préparation de la mise à jour signée en arrière-plan…',
    ready: suspended ? 'Mise à jour prête. Fermez le document ou le panneau en cours avant de l’appliquer.'
      : `Version ${offer?.version} prête à être appliquée. Enregistrez votre travail avant de continuer.`,
    installing: 'Application de la mise à jour…',
    installed: 'Mise à jour appliquée. Fermez puis rouvrez l’application pour utiliser la nouvelle version.',
    'download-error': 'Impossible de préparer la mise à jour signée. Réessayez ou consultez les versions publiées.',
    'install-error': 'Impossible d’appliquer la mise à jour. Réessayez ou consultez les versions publiées.',
  };
  const message = installed || (activeOffer?.kind === 'signed' && phase) ? status[phase] : (activeOffer
    ? `${activeOffer.kind === 'preview' ? 'Nouvelle préversion' : 'Nouvelle version'} ${inTauri ? `${activeOffer.version} ` : ''}disponible.`
    : checkState === 'checking' ? 'Recherche de mises à jour…'
      : checkState === 'error' ? 'Impossible de vérifier les mises à jour. Vérifiez votre connexion et réessayez.'
        : 'Aucune mise à jour disponible sur votre canal.');
  const label = activeOffer?.kind === 'preview' ? 'Télécharger la préversion'
    : activeOffer?.kind === 'release' ? 'Voir la mise à jour'
      : activeOffer?.kind === 'signed' ? (failed ? 'Réessayer' : 'Appliquer la mise à jour') : 'Mettre à jour';
  return (
    <aside className="app-update-banner" aria-label="Mise à jour de l’application">
      <p role="status"><FiRefreshCw aria-hidden="true" /><span>{message}</span></p>
      {manual && current && <small>Version installée : {current}</small>}
      <div>
        {activeOffer && !installed && <button type="button" onClick={updateNow} disabled={busy || checkState === 'checking' || (suspended && phase === 'ready')}>{label}</button>}
        {activeOffer && failed && <button type="button" onClick={() => openExternalUrl(DEFAULT_RELEASE_PAGE_URL)}>Versions publiées</button>}
        {phase !== 'installing' && <button type="button" onClick={() => { if (offer) setDismissed(offer.version); setManual(false); }}>{activeOffer && !installed ? 'Plus tard' : 'Fermer'}</button>}
      </div>
    </aside>
  );
}
