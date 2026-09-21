import { Account, Client, Databases, TablesDB } from 'appwrite';
import {
  APPWRITE_DATABASE_ID,
  APPWRITE_FLAVOR,
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
const databases = new Databases(client);

/** 'tablesdb' (Appwrite 2.x) ou 'databases' (API héritée 1.x). */
export const FLAVOR = APPWRITE_FLAVOR;

import {
  describeTransportVerdict,
  getCachedTransportVerdict,
  isTransportError,
  probeAppwriteTransport,
} from './appwriteTransport.js';

/** Une « table » et une « collection » sont le même objet selon le dialecte. */
const CONTAINER = FLAVOR === 'databases' ? 'collection' : 'table';

/** Vrai quand la ligne visée n'existe pas encore (les deux dialectes ne disent pas la même chose). */
export function isMissingRow(error) {
  return error?.type === 'row_missing' || error?.type === 'document_missing' || error?.code === 404;
}

/**
 * Façade de lignes : le reste de l'app ignore le dialecte.
 *
 * `list` normalise la réponse (`rows` pour TablesDB, `documents` pour
 * l'API héritée) pour que `useFavorites` n'ait pas de branche de compat.
 */
export const rows = {
  get({ tableId, rowId }) {
    return FLAVOR === 'databases'
      ? databases.getDocument(DATABASE_ID, tableId, rowId)
      : tables.getRow({ databaseId: DATABASE_ID, tableId, rowId });
  },

  async list({ tableId, queries = [] }) {
    const result = FLAVOR === 'databases'
      ? await databases.listDocuments(DATABASE_ID, tableId, queries)
      : await tables.listRows({ databaseId: DATABASE_ID, tableId, queries });
    return {
      rows: result?.documents ?? result?.rows ?? [],
      total: result?.total ?? 0,
    };
  },

  create({ tableId, rowId, data, permissions }) {
    return FLAVOR === 'databases'
      ? databases.createDocument(DATABASE_ID, tableId, rowId, data, permissions)
      : tables.createRow({ databaseId: DATABASE_ID, tableId, rowId, data, permissions });
  },

  update({ tableId, rowId, data, permissions }) {
    return FLAVOR === 'databases'
      ? databases.updateDocument(DATABASE_ID, tableId, rowId, data, permissions)
      : tables.updateRow({ databaseId: DATABASE_ID, tableId, rowId, data, permissions });
  },

  remove({ tableId, rowId }) {
    return FLAVOR === 'databases'
      ? databases.deleteDocument(DATABASE_ID, tableId, rowId)
      : tables.deleteRow({ databaseId: DATABASE_ID, tableId, rowId });
  },

  /** L'API héritée n'a pas d'upsert : on le simule, sans écraser les permissions. */
  async upsert({ tableId, rowId, data, permissions }) {
    if (FLAVOR !== 'databases') {
      return tables.upsertRow({ databaseId: DATABASE_ID, tableId, rowId, data, permissions });
    }
    try {
      return await databases.updateDocument(DATABASE_ID, tableId, rowId, data);
    } catch (error) {
      if (!isMissingRow(error)) throw error;
      return databases.createDocument(DATABASE_ID, tableId, rowId, data, permissions);
    }
  },
};

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
    .catch(async (error) => {
      // Un ping qui échoue sans statut HTTP n'est pas « Appwrite est mort » :
      // le navigateur a refusé la requête. On identifie laquelle des trois
      // causes (CSP, origine non déclarée, réseau) avant d'écrire le message.
      let detail = error?.message || 'Appwrite injoignable.';
      if (isTransportError(error)) {
        const verdict = await probeAppwriteTransport({ projectId: APPWRITE_PROJECT_ID }).catch(() => null);
        detail = describeTransportVerdict(verdict ?? getCachedTransportVerdict()) || detail;
        if (verdict) console.warn('[appwrite] ping échoué — diagnostic :', verdict.code, '\n' + detail);
      }
      const next = { status: 'offline', detail, checkedAt: Date.now() };
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
  user_unauthorized: 'Permission refusée par Appwrite : ce compte n’a pas accès à cette donnée.',
  table_not_found: 'Table absente du projet : relance npm run appwrite:setup.',
  collection_not_found: 'Collection absente du projet : relance npm run appwrite:setup.',
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
  // Un « Fetch failed » brut ne parle à personne : le navigateur n'a pas
  // terminé la requête. Si la sonde du ping a déjà nommé la cause (CSP, origine
  // non déclarée, réseau), on la rapporte ; sinon on donne les deux pistes et
  // où les lire, ce qui reste actionnable.
  if (TRANSPORT_ERRORS.test(clean) && error.code === undefined) {
    const diagnosed = describeTransportVerdict(getCachedTransportVerdict());
    if (diagnosed) return diagnosed;
    return 'Appwrite est injoignable : réseau coupé, ou ce domaine n’est pas déclaré '
      + 'dans Settings → Domains & Platforms. Console du navigateur (F12) : « Refused to '
      + 'connect » = CSP, « No \u2018Access-Control-Allow-Origin\u2019 header » = origine à déclarer.';
  }
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** Vrai quand l'erreur signifie simplement « pas de session » (cas normal). */
export function isMissingSession(error) {
  return error?.type === 'user_missing' || error?.code === 401;
}

export { client, account, tables, databases, CONTAINER };
