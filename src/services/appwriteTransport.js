/**
 * Diagnostic d'un appel Appwrite bloqué **par le navigateur**.
 *
 * Côté serveur, une erreur a un statut HTTP. Côté navigateur, un appel refusé
 * par la CSP, par CORS ou par le réseau se réduit à `TypeError: Failed to fetch`
 * (Chrome), `NetworkError` (Firefox), `Load failed` (Safari) : trois causes
 * sans rapport, un seul message. Ce module les sépare par deux sondes locales :
 *
 * 1. la CSP réellement appliquée à cette page (relue sur notre propre origine,
 *    donc sans CORS) dit si `connect-src` autorise l'hôte Appwrite ;
 * 2. une requête `no-cors` vers `/v1/ping` dit si l'hôte répond du tout.
 *
 * Aucun token, aucune dépendance, et silencieux en dehors d'un navigateur.
 */
import { APPWRITE_ENDPOINT } from '../config.js';
import { normalizeAppwriteEndpoint } from '../utils/appwriteEndpoint.js';

/** Erreurs sans réponse HTTP : le navigateur n'a pas terminé la requête. */
export const TRANSPORT_ERRORS = /^(fetch failed|failed to fetch|networkerror|load failed|opener? (blocked|error)|econn|err_|aborted)/i;

export function isTransportError(error) {
  if (!error) return false;
  // Aucun statut HTTP (ou 0) = pas de réponse : seul un `type` porté par un
  // statut (401/404…) disqualifie le diagnostic transport.
  if (error.code !== undefined && error.code !== 0) return false;
  if (error.status !== undefined && error.status !== 0) return false;
  const message = typeof error.response === 'string' && error.response.trim()
    ? error.response
    : (typeof error.message === 'string' ? error.message : '');
  return TRANSPORT_ERRORS.test(message.trim());
}

/**
 * `Content-Security-Policy` → `{ directive: [sources] }`.
 * Les commentaires et les lignes `_headers` vides sont ignorés.
 */
export function parseCsp(header) {
  if (typeof header !== 'string' || !header.trim()) return {};
  const directives = {};
  for (const chunk of header.split(';')) {
    const parts = chunk.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const [name, ...sources] = parts;
    directives[name.toLowerCase()] = sources;
  }
  return directives;
}

function matchesSource(source, url, pageOrigin) {
  const value = source.replace(/^['"]|['"]$/g, '');
  if (value === '*') return true;
  if (value === "'self'") return pageOrigin ? url.origin === pageOrigin : false;
  if (/^[a-z][a-z0-9+.-]*:$/.test(value)) return value.toLowerCase() === url.protocol.toLowerCase();
  if (/^[a-z-]+:$/i.test(value)) return `${url.protocol}//`.startsWith(value.slice(0, value.indexOf(':') + 1));
  // Joker de sous-domaine : `https://*.cloud.appwrite.io`. `*` n'étant pas un
  // caractère d'hôte valide, `new URL()` le refuserait : on le traite à part.
  const wildcard = value.match(/^([a-z][a-z0-9+.-]*):\/\/\*\.(.+)$/i);
  if (wildcard) {
    if (wildcard[1].toLowerCase() !== url.protocol.replace(':', '').toLowerCase()) return false;
    return url.hostname === wildcard[2] || url.hostname.endsWith(`.${wildcard[2]}`);
  }
  let candidate = value;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) candidate = `https://${candidate}`;
  let parsed;
  try { parsed = new URL(candidate); } catch { return false; }
  if (parsed.protocol !== url.protocol) return false;
  if (parsed.port && parsed.port !== url.port) return false;
  return parsed.hostname === url.hostname;
}

/**
 * La CSP autorise-t-elle `endpoint` pour `connect` ?
 * `connect-src` prime, `default-src` sert de repli ; l'absence des deux laisse
 * passer (aucune restriction de connexion déclarée).
 */
export function cspAllowsOrigin(header, endpoint, pageOrigin) {
  const directives = parseCsp(header);
  const sources = directives['connect-src'] ?? directives['default-src'];
  if (!sources) return { allowed: true, sources: null, header: null };
  const url = new URL(endpoint);
  const allowed = sources.some((source) => matchesSource(source, url, pageOrigin));
  return { allowed, sources, header: header ?? null };
}

const VERDICTS = {
  csp: (info) => `La politique de sécurité de ${info.pageOrigin} bloque l'appel : sa directive `
    + `connect-src n'inclut pas ${info.endpointOrigin}. Redéploie avec public/_headers à jour `
    + `(https://${info.host} et wss://${info.host} dans connect-src) — en local, \`vite dev\` ne sert `
    + `pas ce fichier, donc le symptôme n'apparaît qu'en production.`,
  origin: (info) => `Appwrite joint ${info.host}, mais le navigateur refuse de lire la réponse : `
    + `${info.pageOrigin} n'est pas déclarée dans Console → Settings → Domains & Platforms `
    + `(une entrée par origine, avec https, sans chemin).`,
  offline: (info) => `Le poste est hors ligne : ${info.host} n'a pas pu être résolu. `
    + `Les favoris restent lisibles en local, la connexion réessaiera au retour du réseau.`,
  unreachable: (info) => `Aucune réponse de ${info.host} : réseau d'établissement ou pare-feu qui filtre `
    + `le domaine, DNS, ou instance Appwrite indisponible. Teste depuis un autre réseau `
    + `(4G) pour confirmer.`,
  ok: (info) => `${info.host} répond depuis ${info.pageOrigin} : le blocage vient d'ailleurs `
    + `(session expirée, ou tables non provisionnées côté projet).`,
};

export function describeTransportVerdict(verdict) {
  if (!verdict || !VERDICTS[verdict.code]) return null;
  return VERDICTS[verdict.code](verdict);
}

/** Un verdict déjà calculé sert de cache pour les messages d'erreur suivants. */
let cached = null;

export function getCachedTransportVerdict() {
  return cached;
}

export function setCachedTransportVerdict(verdict) {
  cached = verdict ?? null;
  return cached;
}

/**
 * Détermine pourquoi l'appel n'a pas abouti. Renvoie `null` hors navigateur :
 * le diagnostic a besoin de `location` et d'en-têtes de réponse.
 */
export async function probeAppwriteTransport(options = {}) {
  const inBrowser = typeof globalThis.document !== 'undefined' && typeof globalThis.location?.href === 'string';
  if (!inBrowser && !options.pageUrl) return null;

  const endpoint = normalizeAppwriteEndpoint(options.endpoint || APPWRITE_ENDPOINT);
  const pageUrl = options.pageUrl || globalThis.location.href;
  const fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
  const online = options.online ?? globalThis.navigator?.onLine ?? true;
  if (!fetchImpl) return null;

  const endpointUrl = new URL(endpoint);
  const endpointOrigin = endpointUrl.origin;
  const pageOrigin = new URL(pageUrl).origin;
  const base = { endpointOrigin, pageOrigin, host: endpointUrl.hostname };
  const settle = (code) => setCachedTransportVerdict({ code, ...base });

  // 1. Notre propre réponse porte la CSP appliquée : lecture sans CORS.
  const own = await fetchImpl(pageUrl, { method: 'HEAD', cache: 'no-store' })
    .then((response) => response.headers?.get?.('content-security-policy') ?? null)
    .catch(() => null);
  const csp = cspAllowsOrigin(own, endpoint, pageOrigin);
  if (csp.allowed === false) return settle('csp');

  // 2. L'hôte répond-il ? `no-cors` suffit : on teste l'acheminement, pas le corps.
  if (online === false) return settle('offline');
  const reachable = await fetchImpl(`${endpointOrigin}/v1/ping`, { mode: 'no-cors', credentials: 'omit', cache: 'no-store' })
    .then(() => true)
    .catch(() => false);
  if (!reachable) return settle('unreachable');

  // 3. Hôte joignable et CSP correcte : ce qui a échoué est l'autorisation CORS
  //    (origine absente des Domains & Platforms) ou plus haut dans la pile.
  const withProject = await fetchImpl(`${endpointOrigin}/v1/ping`, {
    mode: 'cors',
    headers: { 'x-appwrite-project': options.projectId || '' },
    credentials: 'include',
    cache: 'no-store',
  }).then(() => true).catch(() => false);
  return settle(withProject ? 'ok' : 'origin');
}
