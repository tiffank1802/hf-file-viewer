import { ID, Permission, Query, Role } from 'appwrite';
import {
  FAVORITES_TABLE_ID,
  describeAppwriteError,
  hasDatabase,
  isMissingRow,
  rows,
} from './appwrite.js';
import {
  favoriteFromRow,
  favoritePathHash,
  favoriteToRow,
  normalizeFavoriteList,
  normalizeFavoritePath,
} from '../utils/favoritesMerge.js';

/**
 * Favoris synchronisés dans la table `favorites` (TablesDB).
 *
 * Une ligne = un (utilisateur, chemin). Les permissions sont posées à
 * l'écriture sur le seul propriétaire : un autre compte connecté ne voit ni ne
 * modifie les lignes d'à côté, y compris en listant la table.
 *
 * Le SDK client ne permet pas de supprimer par requête : les suppressions
 * passent par le `rowId`, d'où le `list` préalable quand l'appelant ne l'a pas.
 */

export const FAVORITES_PAGE_LIMIT = 200;
const PUSH_BATCH = 5;

export function favoritesEnabled() {
  return hasDatabase();
}

function rowPermissions(userId) {
  return [
    Permission.read(Role.user(userId)),
    Permission.update(Role.user(userId)),
    Permission.delete(Role.user(userId)),
  ];
}

function fail(error, fallback) {
  return new Error(describeAppwriteError(error, fallback));
}

/** Favoris du compte, du plus récemment épinglé au plus ancien. */
export async function listFavorites(userId) {
  if (!favoritesEnabled() || !userId) return [];
  try {
    const result = await rows.list({
      tableId: FAVORITES_TABLE_ID,
      queries: [
        Query.equal('userId', userId),
        Query.orderDesc('$createdAt'),
        Query.limit(FAVORITES_PAGE_LIMIT),
      ],
    });
    return (Array.isArray(result.rows) ? result.rows : []).map(favoriteFromRow).filter(Boolean);
  } catch (error) {
    // Table absente (projet non provisionné) : le site retombe sur le miroir local.
    if (isMissingRow(error) || error?.code === 403) return null;
    throw fail(error, 'Lecture des favoris impossibles.');
  }
}

export async function addFavorite(userId, entry) {
  if (!favoritesEnabled() || !userId) return null;
  const row = favoriteToRow(entry);
  try {
    const created = await rows.create({
      tableId: FAVORITES_TABLE_ID,
      rowId: ID.unique(),
      data: { userId, pathKey: await favoritePathHash(row.filePath), ...row },
      permissions: rowPermissions(userId),
    });
    return favoriteFromRow(created);
  } catch (error) {
    // Index unique (userId, pathKey) : le favori existait déjà, tant mieux.
    if (error?.type === 'duplicate_unique') return favoriteFromRow({ ...entry, path: row.filePath });
    throw fail(error, 'Enregistrement du favori impossible.');
  }
}

export async function removeFavorite(userId, { rowId, path }) {
  if (!favoritesEnabled() || !userId) return false;
  try {
    let target = rowId;
    if (!target) {
      const rows = await listFavorites(userId);
      target = (rows || []).find((item) => normalizeFavoritePath(item.path) === normalizeFavoritePath(path))?.rowId;
    }
    if (!target) return false;
    await rows.remove({ tableId: FAVORITES_TABLE_ID, rowId: target });
    return true;
  } catch (error) {
    if (isMissingRow(error)) return true;
    throw fail(error, 'Suppression du favori impossible.');
  }
}

export async function setFavoriteNote(userId, rowId, note) {
  if (!favoritesEnabled() || !userId || !rowId) return null;
  try {
    return await rows.update({
      tableId: FAVORITES_TABLE_ID,
      rowId,
      data: { note: String(note ?? '').slice(0, 280) },
    });
  } catch (error) {
    throw fail(error, 'Note non enregistrée.');
  }
}

/**
 * Envoi par petits lots : l'index unique rend l'opération rejouable, donc une
 * migration interrompue se reprend sans doublon ni perte.
 */
export async function pushFavorites(userId, entries) {
  const list = normalizeFavoriteList(entries);
  // Fonctionnalité coupée ou rien à envoyer : « aucun échec », sinon la pastille
  // afficherait des favoris en attente qui n'existent pas.
  if (!favoritesEnabled() || !userId) return { pushed: 0, failed: [] };
  if (!list.length) return { pushed: 0, failed: [] };

  const failed = [];
  let pushed = 0;
  for (let index = 0; index < list.length; index += PUSH_BATCH) {
    const batch = list.slice(index, index + PUSH_BATCH);
    const results = await Promise.allSettled(batch.map((entry) => addFavorite(userId, entry)));
    results.forEach((result, offset) => {
      if (result.status === 'fulfilled') pushed += 1;
      else failed.push(batch[offset].path);
    });
  }
  return { pushed, failed };
}

/** Supprime côté cloud les chemins attendus par la file de suppressions locales. */
export async function deleteFavoritePaths(userId, paths) {
  if (!favoritesEnabled() || !userId || !paths?.length) return { deleted: 0, failed: [] };
  const rows = (await listFavorites(userId)) || [];
  const wanted = new Set(paths.map(normalizeFavoritePath));
  const targets = rows.filter((row) => wanted.has(normalizeFavoritePath(row.path)));
  const results = await Promise.allSettled(
    targets.map((row) => rows.remove({ tableId: FAVORITES_TABLE_ID, rowId: row.rowId })),
  );
  const deleted = results.filter((r) => r.status === 'fulfilled').length;
  const failed = targets.filter((row, index) => results[index].status === 'rejected').map((row) => row.path);
  // Un chemin déjà absent du cloud est considéré comme supprimé.
  return { deleted: deleted + (paths.length - targets.length), failed };
}
