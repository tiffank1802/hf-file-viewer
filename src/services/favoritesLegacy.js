/**
 * Vidage de l'ancien miroir `localStorage` des favoris.
 *
 * Depuis que le compte est la seule source des favoris, plus rien n'est écrit
 * ici. Ce module ne fait qu'une chose : récupérer ce qu'une version antérieure
 * y avait laissé (favoris épinglés avant la bascule, ou pendant une panne de
 * permission sur la table `favorites`) et signaler ce qui n'a pas pu partir.
 *
 * Les clés sont supprimées dès qu'elles sont vides — après un premier sync
 * réussi, il ne reste rien en local, ce qui est exactement la demande.
 *
 * Le stockage est injectable : les tests Node tournent sans `window`.
 */

import { normalizeFavoriteList } from '../utils/favoritesEntry.js';

export const LEGACY_FAVORITES_KEY = 'enise-docs:favorites';
export const LEGACY_TOMBSTONES_KEY = 'enise-docs:favorites:removed';

function resolveStorage(storage) {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  return window.localStorage ?? null;
}

function readKey(storage, key) {
  try {
    const raw = storage?.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Une clé illisible (JSON cassé, quota, mode privé) ne doit pas casser la synchro.
    return [];
  }
}

/** Favoris laissés par la version à miroir local, nettoyés. */
export function readLegacyFavorites(storage) {
  const store = resolveStorage(storage);
  if (!store) return [];
  return normalizeFavoriteList(readKey(store, LEGACY_FAVORITES_KEY));
}

/** Reste-t-il quelque chose à récupérer ? (un simple `getItem` suffit) */
export function hasLegacyFavorites(storage) {
  const store = resolveStorage(storage);
  if (!store) return false;
  try {
    return Boolean(store.getItem(LEGACY_FAVORITES_KEY)) || Boolean(store.getItem(LEGACY_TOMBSTONES_KEY));
  } catch {
    return false;
  }
}

/**
 * Ecrit ce qui n'a pas pu être importé — ou supprime la clé quand tout est parti.
 *
 * `remaining` ne contient que des entrées déjà refusées : la liste affichée,
 * elle, vient toujours du compte.
 */
export function drainLegacyFavorites(remaining = [], storage) {
  const store = resolveStorage(storage);
  if (!store) return 0;
  const list = normalizeFavoriteList(remaining);
  try {
    if (list.length) store.setItem(LEGACY_FAVORITES_KEY, JSON.stringify(list));
    else store.removeItem(LEGACY_FAVORITES_KEY);
    // La file de suppressions locales n'a plus de sens sans miroir : on la jette.
    store.removeItem(LEGACY_TOMBSTONES_KEY);
  } catch {
    // Quota ou stockage coupé : rien de grave, la prochaine synchro réessaiera.
  }
  return list.length;
}
