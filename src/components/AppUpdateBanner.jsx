import { useEffect, useRef, useState } from 'react';
import { FiRefreshCw } from 'react-icons/fi';
import { DEFAULT_RELEASE_PAGE_URL } from '../utils/appDownloads';
import { fetchUpdateJson, findNativeUpdate, getWebUpdate, installedRelease } from '../utils/appUpdates';
import { CHECK_UPDATE_EVENT } from '../utils/finderCommands';
import { isTauriRuntime, openExternalUrl } from '../utils/runtime';

const CHECK_PERIOD = 5 * 60_000;
const MIN_CHECK_GAP = 30_000;

export default function AppUpdateBanner({ suspended = false }) {
  const [offer, setOffer] = useState(null);
  const [dismissed, setDismissed] = useState('');
  const [manual, setManual] = useState(false);
  const [checkState, setCheckState] = useState('');
  const [current, setCurrent] = useState('');
  const [installState, setInstallState] = useState('');
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
      if (signal.aborted || document.visibilityState === 'hidden' || running.current || installedVersion.current || checking || (!force && Date.now() - lastCheck < MIN_CHECK_GAP)) return;
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
        if (useUpdater) {
          try {
            const { check: findSignedUpdate } = await import('@tauri-apps/plugin-updater');
            const update = await findSignedUpdate({ timeout: 10000 });
            if (signal.aborted || running.current) { await update?.close(); return; }
            const previous = signed.current;
            signed.current = update;
            void previous?.close().catch(() => {});
            if (update) { setOffer({ version: update.version, kind: 'signed' }); return; }
          } catch { /* A missing signed feed must not prevent release notifications. */ }
        }
        const { invoke } = await import('@tauri-apps/api/core');
        const releases = await invoke('list_app_releases');
        if (!Array.isArray(releases)) throw new Error('invalid releases');
        if (!signal.aborted) setOffer(findNativeUpdate(version, releases));
      } catch {
        if (!signal.aborted) setCheckState('error');
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
      void signed.current?.close().catch(() => {});
      signed.current = null;
    };
  }, [inTauri, previewTag, webBuild, useUpdater]);

  const activeOffer = offer && offer.version !== dismissed ? offer : null;
  if ((suspended && !manual) || (!manual && !activeOffer)) return null;

  const updateNow = async () => {
    if (activeOffer.kind === 'web') { window.location.reload(); return; }
    if (activeOffer.url) { await openExternalUrl(activeOffer.url); return; }
    const update = signed.current;
    if (!update || running.current) return;
    running.current = true;
    setInstallState('Téléchargement de la mise à jour…');
    try {
      await update.downloadAndInstall();
      installedVersion.current = update.version;
      setInstallState('Mise à jour installée. Fermez puis rouvrez l’application.');
    } catch {
      setInstallState('Installation impossible. Vous pouvez réessayer ou consulter les versions publiées.');
    } finally { running.current = false; }
  };
  const installed = installState.startsWith('Mise à jour installée');
  const installing = installState.startsWith('Téléchargement');
  const message = installState || (activeOffer
    ? `${activeOffer.kind === 'preview' ? 'Nouvelle préversion' : 'Nouvelle version'} ${inTauri ? `${activeOffer.version} ` : ''}disponible.`
    : checkState === 'checking' ? 'Recherche de mises à jour…'
      : checkState === 'error' ? 'Impossible de vérifier les mises à jour. Vérifiez votre connexion et réessayez.'
        : 'Aucune mise à jour disponible sur votre canal.');
  const label = activeOffer?.kind === 'preview' ? 'Télécharger la préversion' : activeOffer?.kind === 'release' ? 'Voir la mise à jour' : 'Mettre à jour';
  return (
    <aside className="app-update-banner" aria-label="Mise à jour de l’application">
      <p role="status"><FiRefreshCw aria-hidden="true" /><span>{message}</span></p>
      {manual && current && <small>Version installée : {current}</small>}
      <div>
        {activeOffer && !installed && <button type="button" onClick={updateNow} disabled={installing || checkState === 'checking'}>{label}</button>}
        {installState.startsWith('Installation impossible') && <button type="button" onClick={() => openExternalUrl(DEFAULT_RELEASE_PAGE_URL)}>Versions publiées</button>}
        {!installing && <button type="button" onClick={() => { if (offer) setDismissed(offer.version); setManual(false); if (!installed) setInstallState(''); }}>{activeOffer && !installed ? 'Plus tard' : 'Fermer'}</button>}
      </div>
    </aside>
  );
}
