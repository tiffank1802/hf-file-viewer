import { useEffect, useRef, useState } from 'react';
import { FiRefreshCw } from 'react-icons/fi';
import { DEFAULT_RELEASE_PAGE_URL } from '../utils/appDownloads';
import { fetchUpdateJson, getNativeRelease, getWebUpdate, RELEASE_API } from '../utils/appUpdates';
import { isTauriRuntime, openExternalUrl } from '../utils/runtime';

const CHECK_PERIOD = 5 * 60_000;
const MIN_CHECK_GAP = 30_000;

export default function AppUpdateBanner({ suspended = false }) {
  const [offer, setOffer] = useState(null);
  const [dismissed, setDismissed] = useState('');
  const [installState, setInstallState] = useState('');
  const signed = useRef(null);
  const running = useRef(false);
  const installedVersion = useRef(null);
  const inTauri = isTauriRuntime();
  const webBuild = import.meta.env.VITE_ENISE_BUILD_ID;
  const useUpdater = import.meta.env.VITE_ENISE_SIGNED_UPDATER === '1';

  useEffect(() => {
    if (!inTauri && !webBuild) return undefined;
    const controller = new AbortController();
    const { signal } = controller;
    let lastCheck = -Infinity;
    let timedCheck = false;
    const check = async () => {
      if (signal.aborted || document.visibilityState === 'hidden' || running.current || installedVersion.current || timedCheck || Date.now() - lastCheck < MIN_CHECK_GAP) return;
      timedCheck = true;
      lastCheck = Date.now();
      try {
        if (!inTauri) {
          const payload = await fetchUpdateJson('/version.json', signal);
          const version = getWebUpdate(webBuild, payload);
          if (!signal.aborted && payload?.id) setOffer(version ? { version, kind: 'web' } : null);
          return;
        }
        if (useUpdater) {
          try {
            const { check: findSignedUpdate } = await import('@tauri-apps/plugin-updater');
            const update = await findSignedUpdate({ timeout: 10000 });
            if (signal.aborted || running.current) { await update?.close(); return; }
            const previous = signed.current;
            signed.current = update;
            void previous?.close().catch(() => {});
            if (update) { setOffer({ version: update.version, kind: 'signed' }); return; }
          } catch { /* Unavailable signed feed: fall back to the release page. */ }
        }
        const { getVersion } = await import('@tauri-apps/api/app');
        const [version, payload] = await Promise.all([getVersion(), fetchUpdateJson(RELEASE_API, signal)]);
        const next = getNativeRelease(version, payload);
        if (!signal.aborted && payload) setOffer(next ? { version: next, kind: 'release' } : null);
      } catch { /* An offline or malformed response must not interrupt the app. */ }
      finally { timedCheck = false; }
    };
    void check();
    const timer = window.setInterval(check, CHECK_PERIOD);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', check);
      void signed.current?.close().catch(() => {});
      signed.current = null;
    };
  }, [inTauri, webBuild, useUpdater]);

  if (suspended || !offer || offer.version === dismissed) return null;

  const updateNow = async () => {
    if (offer.kind === 'web') { window.location.reload(); return; }
    if (offer.kind === 'release') { await openExternalUrl(DEFAULT_RELEASE_PAGE_URL); return; }
    const update = signed.current;
    if (!update || running.current) return;
    running.current = true;
    setInstallState('Téléchargement de la mise à jour…');
    try {
      await update.downloadAndInstall();
      installedVersion.current = update.version;
      setInstallState('Mise à jour installée. Ferme puis rouvre l’application.');
    } catch {
      setInstallState('Installation impossible. Tu peux réessayer ou consulter les versions publiées.');
    } finally { running.current = false; }
  };
  const installed = installState.startsWith('Mise à jour installée');
  const installing = installState.startsWith('Téléchargement');
  return (
    <aside className="app-update-banner" aria-label="Mise à jour de l’application">
      <p role="status"><FiRefreshCw aria-hidden="true" /><span>{installState || `Nouvelle version ${inTauri ? `${offer.version} ` : ''}disponible.`}</span></p>
      <div>
        {!installed && <button type="button" onClick={updateNow} disabled={installing}>{offer.kind === 'release' ? 'Voir la mise à jour' : 'Mettre à jour'}</button>}
        {installState.startsWith('Installation impossible') && <button type="button" onClick={() => openExternalUrl(DEFAULT_RELEASE_PAGE_URL)}>Versions publiées</button>}
        {!installing && <button type="button" onClick={() => { setDismissed(offer.version); setInstallState(''); }}>{installed ? 'Fermer' : 'Plus tard'}</button>}
      </div>
    </aside>
  );
}
