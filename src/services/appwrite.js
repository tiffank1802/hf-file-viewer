import { Account, Client, TablesDB } from 'appwrite';
import {
  APPWRITE_DATABASE_ID,
  APPWRITE_ENABLED,
  APPWRITE_ENDPOINT,
  APPWRITE_FAVORITES_TABLE_ID,
  APPWRITE_PROFILE_TABLE_ID,
  APPWRITE_PROJECT_ID,
} from '../config.js';

/**
 * Client Appwrite partagé par toute l'app (projet « Django objects »).
 *
 * Un seul `Client` pour tous les services : il porte l'endpoint, le projet et
 * le cookie de session, et évite d'instancier un XHR/fetch par composant.
 */
const client = new Client()
  .setEndpoint(APPWRITE_ENDPOINT)
  .setProject(APPWRITE_PROJECT_ID);

const account = new Account(client);
const tables = new TablesDB(client);

/**
 * État du test de connexion (`client.ping()`), exposé à l'interface.
 * idle → pending → online | offline | not-provisionned.
 */
const listeners = new Set();
let pingState = { status: APPWRITE_ENABLED ? 'idle' : 'disabled', detail: null, checkedAt: null };
let pingPromise = null;

function setPingState(next) {
  pingState = { ...pingState, ...next };
  for (const listener of listeners) listener(pingState);
}

/** Abonnement minimal (pattern useSyncExternalStore) — pas de contexte global. */
export function subscribeAppwritePing(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAppwritePingState() {
  return pingState;
}

/**
 * Vérifie que le frontend joint le backend Appwrite : un appel, une seule fois
 * par chargement de page (`ensureAppwritePing()` au démarrage de l'app).
 *
 * `ping` est public et ne requiert pas de session : il valide l'endpoint, l'ID
 * de projet et les en-têtes CORS (domaines autorisés dans la console Appwrite).
 */
export function ensureAppwritePing() {
  if (!APPWRITE_ENABLED) {
    setPingState({ status: 'disabled', detail: 'APPWRITE_ENDPOINT / APPWRITE_PROJECT_ID non renseignés.' });
    return Promise.resolve(pingState);
  }
  if (pingPromise) return pingPromise;

  setPingState({ status: 'pending', detail: null });
  pingPromise = client.ping()
    .then(() => {
      const next = { status: 'online', detail: null, checkedAt: Date.now() };
      setPingState(next);
      return next;
    })
    .catch((error) => {
      const next = {
        status: 'offline',
        detail: error?.message || 'Appwrite injoignable (réseau ou origine CORS non autorisée).',
        checkedAt: Date.now(),
      };
      setPingState(next);
      return next;
    });

  return pingPromise;
}

/** Force une nouvelle mesure (bouton « réessayer » de la pastille d'état). */
export function retryAppwritePing() {
  pingPromise = null;
  return ensureAppwritePing();
}

/** Les tables de l'app ne vivent que si la base a été provisionnée. */
export function hasDatabase() {
  return APPWRITE_ENABLED && Boolean(APPWRITE_DATABASE_ID);
}

export const DATABASE_ID = APPWRITE_DATABASE_ID;
export const PROFILE_TABLE_ID = APPWRITE_PROFILE_TABLE_ID;
export const FAVORITES_TABLE_ID = APPWRITE_FAVORITES_TABLE_ID;

/**
 * Traduit une erreur Appwrite en message lisible pour l'utilisateur.
 *
 * En SDK web 27, `AppwriteException.code` est le **statut HTTP** et `type` porte
 * le **code métier** (`user_already_exists`, `invalid_credentials`, …) : on
 * cherche d'abord `type`, avec repli sur `code` pour les SDK plus anciens.
 * Les codes `user_*` sont les seuls que les formulaires d'authentification
 * rencontrent en pratique.
 */
const FRENCH_ERRORS = {
  user_already_exists: 'Un compte existe déjà avec cette adresse email.',
  user_inactive: 'Ce compte n’est pas encore activé : consulte l’email de confirmation.',
  user_blocked: 'Ce compte est bloqué. Contacte un administrateur de la bibliothèque.',
  user_missing: 'Aucune session active. Connecte-toi pour continuer.',
  user_password_mismatch: 'Le mot de passe actuel est incorrect.',
  invalid_credentials: 'Email ou mot de passe incorrect.',
  password_policy: 'Mot de passe trop faible : 8 caractères minimum.',
  rate_limit_exceeded: 'Trop de tentatives. Réessaie dans quelques minutes.',
  general_unknown: 'Appwrite n’a pas répondu. Vérifie ta connexion ou réessaie.',
  invalid_origin: 'Origine non autorisée : ajoute ce domaine dans Settings → Domains & Platforms de la console Appwrite.',
};

/** Erreurs de transport (pas de réponse HTTP) : le navigateur n’a pas joigné Appwrite. */
const TRANSPORT_ERRORS = /^(fetch failed|failed to fetch|networkerror|load failed|opener? (blocked|error)|econn|err_)/i;

export function describeAppwriteError(error, fallback = 'Action impossible pour le moment.') {
  if (!error) return fallback;
  const type = typeof error.type === 'string' ? error.type : error.code;
  const known = FRENCH_ERRORS[type];
  if (known) return known;
  if (error.code === 401) return 'Session expirée ou invalide. Reconnecte-toi.';
  const message = typeof error.response === 'string' && error.response.trim()
    ? error.response
    : (typeof error.message === 'string' ? error.message : '');
  const clean = message.trim();
  if (!clean || clean === 'Unknown Error') return fallback;
  // Un « Fetch failed » brut ne parle à personne : c'est presque toujours le
  // réseau, une origine non déclarée en CORS, ou un projet injoignable.
  if (TRANSPORT_ERRORS.test(clean) && error.code === undefined) {
    return 'Appwrite est injoignable : réseau coupé, ou ce domaine n’est pas déclaré dans Settings → Domains & Platforms.';
  }
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** Vrai quand l'erreur signifie simplement « pas de session » (cas normal). */
export function isMissingSession(error) {
  return error?.type === 'user_missing' || error?.code === 401;
}

export { client, account, tables };
