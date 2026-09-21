import { FiActivity, FiRefreshCw } from 'react-icons/fi';
import { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_PROJECT_NAME } from '../config.js';
import { useAppwritePing } from '../hooks/useAppwritePing.js';

const LABELS = {
  idle: 'Appwrite · test en attente',
  pending: 'Appwrite · vérification…',
  online: 'Appwrite · connecté',
  offline: 'Appwrite · injoignable',
  disabled: 'Appwrite · non configuré',
};

/**
 * Pastille de confirmation de l'intégration Appwrite : elle affiche le
 * résultat du `client.ping()` déclenché au démarrage de l'app.
 *
 * Visible en développement (ou avec `?appwrite` dans l'URL) : en production
 * elle n'a pas vocation à être vue par les visiteurs.
 */
export default function AppwriteStatus() {
  const { status, detail, checkedAt, retry } = useAppwritePing();
  const env = typeof import.meta.env === 'object' && import.meta.env ? import.meta.env : {};
  const debugParam = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('appwrite');

  if (env.PROD && !debugParam) return null;

  const title = [
    `Projet : ${APPWRITE_PROJECT_NAME} (${APPWRITE_PROJECT_ID})`,
    `Endpoint : ${APPWRITE_ENDPOINT}`,
    detail,
    checkedAt ? `Contrôle le ${new Date(checkedAt).toLocaleTimeString('fr-FR')}` : null,
  ].filter(Boolean).join('\n');

  return (
    <span className={`appwrite-status appwrite-status--${status}`} title={title} role="status" aria-live="polite">
      <FiActivity aria-hidden="true" />
      <span>{LABELS[status] || 'Appwrite'}</span>
      {status === 'offline' && (
        <button type="button" onClick={retry}>
          <FiRefreshCw aria-hidden="true" />
          Réessayer
        </button>
      )}
    </span>
  );
}
