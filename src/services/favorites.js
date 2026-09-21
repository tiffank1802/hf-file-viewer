import { ID, Permission, Query, Role } from 'appwrite';
import { APPWRITE_ENABLED } from '../config.js';
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
  normalizeFavorite,
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

/** Les écritures de favoris sont-elles possibles dans ce build, session comprise ? */
export function favoritesEnabled() {
  return hasDatabase();
}

/**
 * Pourquoi rien n'est envoyé au compte, en clair.
 *
 * La table `favorites` ne se remplit que si ces trois conditions sont vraies en
 * même temps ; la version précédente confondait « table absente » et « permission
 * refusée » sous un seul état `unprovisioned`, qui coupait le `push` sans
 * message — d'où un panneau de compte apparemment synchronisé et une table vide.
 */
export function favoritesBlockers(userId) {
  const reasons = [];
  if (!APPWRITE_ENABLED) reasons.push('endpoint ou ID de projet absent de ce build.');
  if (!hasDatabase()) reasons.push('VITE_APPWRITE_DATABASE_ID vide dans ce build (redémarre le serveur après l’avoir mis dans .env.local).');
  if (!userId) reasons.push('aucune session : les favoris restent locaux, c’est voulu.');
  return reasons;
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
    // Table absente du projet : le site retombe sur le miroir local, sans bruit.
    if (isMissingRow(error) || error?.type === 'table_not_found' || error?.type === 'collection_not_found') return null;
    // 403, lui, n'est PAS « non provisionné » : la table existe, c'est sa
    // permission d'accès qui manque. Le taire, c'est laisser l'app croire que
    // tout est normal pendant que la table reste vide.
    if (error?.code === 403 || error?.type === 'user_unauthorized' || error?.type === 'missing_scope') {
      const translated = fail(error, 'Permission refusée sur la table des favoris.');
      throw Object.assign(
        new Error(`${translated.message} — npm run appwrite:status indique quelles permissions manquent.`),
        { forbidden: true },
      );
    }
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
    // Repli sur l'entrée envoyée : une réponse Appwrite sans `filePath` ne doit
    // pas faire perdre le `rowId` (sans lui, la suppression devrait relister).
    return favoriteFromRow(created) || { ...normalizeFavorite(entry), rowId: created?.$id ?? null };
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
      // Nom local différent du service importé : `const rows` ici masquait
      // `rows.remove` plus bas et transformait chaque suppression en
      // « TypeError: rows.remove is not a function ».
      const cloud = (await listFavorites(userId)) || [];
      target = cloud.find((item) => normalizeFavoritePath(item.path) === normalizeFavoritePath(path))?.rowId;
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
  const blockers = favoritesBlockers(userId);
  if (blockers.length) return { pushed: 0, failed: [], saved: [], blockers };
  if (!list.length) return { pushed: 0, failed: [], saved: [], blockers };

  const failed = [];
  const saved = [];
  let pushed = 0;
  for (let index = 0; index < list.length; index += PUSH_BATCH) {
    const batch = list.slice(index, index + PUSH_BATCH);
    const results = await Promise.allSettled(batch.map((entry) => addFavorite(userId, entry)));
    results.forEach((result, offset) => {
      if (result.status === 'fulfilled') {
        pushed += 1;
        // Le `rowId` revient avec l'entrée : sans lui, chaque suppression devrait
        // relister la table pour retrouver la ligne à supprimer.
        if (result.value) saved.push(result.value);
      }
      // La raison voyage avec le chemin : « 3 en attente » sans dire pourquoi
      // est exactement le silence qui a fait chercher du côté d'Appwrite au lieu
      // des permissions de table.
      else failed.push({ path: batch[offset].path, reason: result.reason?.message || 'écriture refusée.' });
    });
  }
  return { pushed, failed, saved, blockers };
}

/** Supprime côté cloud les chemins attendus par la file de suppressions locales. */
export async function deleteFavoritePaths(userId, paths) {
  if (!favoritesEnabled() || !userId || !paths?.length) return { deleted: 0, failed: [] };
  const cloud = (await listFavorites(userId)) || [];
  const wanted = new Set(paths.map(normalizeFavoritePath));
  const targets = cloud.filter((row) => wanted.has(normalizeFavoritePath(row.path)));
  const results = await Promise.allSettled(
    targets.map((row) => rows.remove({ tableId: FAVORITES_TABLE_ID, rowId: row.rowId })),
  );
  const deleted = results.filter((r) => r.status === 'fulfilled').length;
  const failed = targets.filter((row, index) => results[index].status === 'rejected').map((row) => row.path);
  // Un chemin déjà absent du cloud est considéré comme supprimé.
  return { deleted: deleted + (paths.length - targets.length), failed };
}
