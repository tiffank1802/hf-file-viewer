/**
 * Entrées de favori : normalisation, pont avec la table `favorites`, file d’import.
 *
 * Fonctions pures (pas d’`appwrite`, pas de `window`) : testées dans
 * `tests/favorites-entry.test.js` et réutilisables hors navigateur (Worker, export).
 *
 * Deux décisions, nées chacune d’un comportement observé :
 *
 * 1. **le compte est la seule source des favoris.** Rien n’est écrit dans
 *    `localStorage` : la liste affichée vient de `listFavorites()`, les ajouts et
 *    retraits partent directement dans la table. Conséquence assumée : sans
 *    réseau, ou contre une table dont la permission `create()` est refusée,
 *    l’action **échoue à l’écran** (message + retour en arrière de l’interface)
 *    au lieu d’être mise de côté. Un favori que l’on croit épinglé et qui ne
 *    l’est pas est pire qu’un favori refusé bruyamment.
 * 2. **deux vocabulaires `kind` cohabitent** : celui de l’app (`pdf`, `office`,
 *    `model`… ce que `PreviewModal` sait rendre) et celui de la table (`file` /
 *    `folder`). Le `kind` de l’entrée est dérivé du chemin à chaque lecture et
 *    n’est jamais stocké en base ; le pont se fait dans `favoriteToRow` /
 *    `favoriteFromRow`. Sans ce champ, ouvrir un favori retombait sur l’écran de
 *    téléchargement faute de renderer.
 */

import { getFileKind } from './files.js';

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
  const type = entry.type === 'directory' ? 'directory' : 'file';
  return {
    path,
    name: String(entry.name || path.split('/').pop() || path).slice(0, 240),
    type,
    size: Number(entry.size) || 0,
    note: typeof entry.note === 'string' ? entry.note.slice(0, MAX_FAVORITE_NOTE) : '',
    // Le renderer suit le chemin, jamais la valeur transportée : une ligne du
    // compte ne porte que `file`/`folder`, et un favori épinglé avant l'ajout
    // d'une extension doit rester ouvrable sans migration.
    kind: getFileKind(path, type),
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
 * Ce que l’ancien miroir `localStorage` contient encore et que le compte n’a pas.
 *
 * À sens unique : ces entrées sont envoyées une fois, la clé est supprimée quand
 * elle est vide, et rien de nouveau n’y est jamais écrit. C’est ce qui évite de
 * perdre les favoris épinglés avant la bascule (ou pendant une panne de
 * permission sur `favorites`).
 *
 * `cloud === null` (lecture en échec) n’empêche pas l’envoi : l’index unique
 * `(userId, pathKey)` rend chaque doublon inoffensif, donc on retente.
 */
export function planImport({ cloud = null, legacy = [] } = {}) {
  const legacyList = normalizeFavoriteList(legacy);
  if (!legacyList.length) return { pending: [], known: [] };
  const known = new Set(
    Array.isArray(cloud) ? normalizeFavoriteList(cloud).map((entry) => entry.path) : [],
  );
  return {
    pending: legacyList.filter((entry) => !known.has(entry.path)),
    known: legacyList.filter((entry) => known.has(entry.path)),
  };
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

/** Ligne `favorites` d'Appwrite → entrée affichable (`rowId` sert aux mises à jour). */
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

/** Entrée affichable → ligne `favorites` d'Appwrite (`pathKey` ajouté par l'appelant). */
export function favoriteToRow(entry) {
  const normalized = normalizeFavorite(entry) || { path: '', name: '', type: 'file', note: '' };
  return {
    filePath: normalized.path,
    title: normalized.name,
    kind: normalized.type === 'directory' ? 'folder' : 'file',
    note: normalized.note,
  };
}
