/**
 * Règles de fusion des favoris entre le cloud Appwrite et le miroir local.
 *
 * Fonctions pures (aucun import de `appwrite`) : elles sont testées dans
 * `tests/favorites-merge.test.js` et utilisées hors navigateur par le Worker
 * ou un futur script d’export.
 */

export const FAVORITES_STORAGE_KEY = 'enise-docs:favorites';
export const FAVORITES_TOMBSTONES_KEY = 'enise-docs:favorites:removed';
export const MAX_TOMBSTONES = 200;
export const MAX_FAVORITE_NOTE = 280;

/** Un seul séparateur, sans bordure ni espace oisif : `GM/3A GM/td1.pdf`. */
export function normalizeFavoritePath(path) {
  return String(path ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

export function normalizeFavorite(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const path = normalizeFavoritePath(entry.path);
  if (!path) return null;
  return {
    path,
    name: String(entry.name || path.split('/').pop() || path).slice(0, 240),
    type: entry.type === 'directory' ? 'directory' : 'file',
    size: Number(entry.size) || 0,
    note: typeof entry.note === 'string' ? entry.note.slice(0, MAX_FAVORITE_NOTE) : '',
  };
}

/** Liste nettoyée, dédupliquée par chemin, ordre conservé. */
export function normalizeFavoriteList(list) {
  const seen = new Set();
  const items = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const entry = normalizeFavorite(raw);
    if (!entry || seen.has(entry.path)) continue;
    seen.add(entry.path);
    items.push(entry);
  }
  return items;
}

/**
 * Union `cloud ⊕ local`, moins les suppressions en attente (tombstones).
 *
 * - `pending` : favoris présents seulement en local → à envoyer au cloud
 *   (migration à la première connexion, ou ajouts faits hors ligne) ;
 * - `toDelete` : favoris présents dans le cloud mais marqués supprimés en
 *   local → à retirer du cloud (suppression faite hors ligne) ;
 * - un élément à la fois absent du cloud et dans les tombstones est ignoré :
 *   c'est ce qui empêche une suppression locale de ressusciter au sync.
 */
export function mergeFavorites({ cloud = [], local = [], tombstones = [] } = {}) {
  const cloudList = normalizeFavoriteList(cloud);
  const localList = normalizeFavoriteList(local);
  const removed = new Set(
    (Array.isArray(tombstones) ? tombstones : []).map(normalizeFavoritePath).filter(Boolean),
  );

  const toDelete = cloudList.filter((entry) => removed.has(entry.path)).map((entry) => entry.path);
  const kept = cloudList.filter((entry) => !removed.has(entry.path));
  const byPath = new Map(kept.map((entry) => [entry.path, entry]));
  const pending = [];

  for (const entry of localList) {
    if (removed.has(entry.path) || byPath.has(entry.path)) continue;
    byPath.set(entry.path, entry);
    pending.push(entry);
  }

  return { items: [...byPath.values()], pending, toDelete };
}

/** Les tombstones grossissent à l'infini sans borne : on garde les plus récents. */
export function pruneTombstones(tombstones) {
  const seen = new Set();
  const list = [];
  for (const raw of Array.isArray(tombstones) ? tombstones : []) {
    const path = normalizeFavoritePath(raw);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    list.push(path);
  }
  return list.slice(-MAX_TOMBSTONES);
}

export function withoutTombstones(tombstones, paths) {
  const done = new Set((Array.isArray(paths) ? paths : []).map(normalizeFavoritePath));
  return pruneTombstones((Array.isArray(tombstones) ? tombstones : []).filter((p) => !done.has(normalizeFavoritePath(p))));
}

/**
 * Clé courte et déterministe pour l'index unique Appwrite (`userId` + `pathKey`).
 *
 * `crypto.subtle` (SHA-256) est utilisé quand le contexte est sécurisé ; sinon
 * un hash FNV-1a 64 bits sert de repli pour que la clé reste stable et courte.
 * Le repli n'est pas un mécanisme de sécurité, juste un identifiant de ligne.
 */
export function favoritePathHashSync(path) {
  const value = normalizeFavoritePath(path);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export async function favoritePathHash(path) {
  const value = normalizeFavoritePath(path);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof TextEncoder !== 'function') return favoritePathHashSync(path);
  try {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
    const bytes = Array.from(new Uint8Array(digest).slice(0, 16));
    return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    // Un navigateur sans WebCrypto (contexte non sécurisé) garde une clé stable.
    return favoritePathHashSync(path);
  }
}

/** Ligne `favorites` d'Appwrite → entrée locale (`rowId` sert aux mises à jour). */
export function favoriteFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  const entry = normalizeFavorite({
    path: row.filePath ?? row.path,
    name: row.title,
    type: row.kind === 'folder' ? 'directory' : 'file',
    note: row.note,
  });
  if (!entry) return null;
  return {
    ...entry,
    rowId: row.$id ?? null,
    updatedAt: row.$updatedAt ?? row.$createdAt ?? null,
  };
}

/** Entrée locale → ligne `favorites` d'Appwrite (`pathKey` ajouté par l'appelant). */
export function favoriteToRow(entry) {
  const normalized = normalizeFavorite(entry) || { path: '', name: '', type: 'file', note: '' };
  return {
    filePath: normalized.path,
    title: normalized.name,
    kind: normalized.type === 'directory' ? 'folder' : 'file',
    note: normalized.note,
  };
}
