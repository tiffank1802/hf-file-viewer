import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalStorage } from './useLocalStorage.js';
import {
  FAVORITES_STORAGE_KEY,
  FAVORITES_TOMBSTONES_KEY,
  mergeFavorites,
  normalizeFavoriteList,
  normalizeFavoritePath,
  pruneTombstones,
  withoutTombstones,
} from '../utils/favoritesMerge.js';
import {
  addFavorite,
  deleteFavoritePaths,
  favoritesEnabled,
  listFavorites,
  pushFavorites,
  removeFavorite,
} from '../services/favorites.js';

/**
 * Favoris du visiteur : miroir `localStorage` en permanence, synchronisation
 * Appwrite (`tables favorites`) dès qu'une session existe.
 *
 * Trois états à connaître :
 * - `'local'`        : pas de session (ou Appwrite coupé) — comportement historique, tout marche ;
 * - `'synced'`/`'partial'` : le cloud a été lu, les écarts ont été poussés ;
 * - `'offline'`      : écriture locale appliquée, reprise au prochain `retry()`
 *   (ou au retour du réseau) grâce à l'index unique et à la file de tombstones.
 *
 * Les suppressions faites hors ligne sont enregistrées comme `tombstones` pour
 * ne pas ressusciter au sync suivant.
 */
export function useFavorites(user) {
  const userId = user?.$id ?? null;
  const cloudAvailable = favoritesEnabled() && Boolean(userId);

  const [stored, setStored] = useLocalStorage(FAVORITES_STORAGE_KEY, []);
  const [tombstones, setTombstones] = useLocalStorage(FAVORITES_TOMBSTONES_KEY, []);
  const [syncState, setSyncState] = useState(cloudAvailable ? 'loading' : 'local');
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [syncError, setSyncError] = useState(null);

  const items = useMemo(() => normalizeFavoriteList(stored), [stored]);
  const paths = useMemo(() => items.map((item) => item.path), [items]);
  const byPath = useMemo(() => new Map(items.map((item) => [item.path, item])), [items]);

  const itemsRef = useRef(items);
  const tombstonesRef = useRef(tombstones);
  const busyRef = useRef(false);

  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => { tombstonesRef.current = pruneTombstones(tombstones); }, [tombstones]);

  const sync = useCallback(async () => {
    if (!cloudAvailable || busyRef.current) return;
    busyRef.current = true;
    setSyncState('loading');
    setSyncError(null);
    try {
      const cloud = await listFavorites(userId);
      if (cloud === null) {
        // Table absente du projet : le miroir local reste la référence.
        setSyncState('unprovisioned');
        return;
      }

      const merged = mergeFavorites({ cloud, local: itemsRef.current, tombstones: tombstonesRef.current });
      const [pushResult, deleteResult] = await Promise.allSettled([
        pushFavorites(userId, merged.pending),
        merged.toDelete.length
          ? deleteFavoritePaths(userId, merged.toDelete)
          : Promise.resolve({ deleted: 0, failed: [] }),
      ]);

      const pushed = pushResult.status === 'fulfilled'
        ? pushResult.value
        : { pushed: 0, failed: merged.pending.map((entry) => entry.path) };
      const removed = deleteResult.status === 'fulfilled'
        ? deleteResult.value
        : { deleted: 0, failed: merged.toDelete };

      setStored(merged.items);
      setTombstones((current) =>
        withoutTombstones(current, merged.toDelete.filter((path) => !removed.failed.includes(path))),
      );
      setLastSyncAt(Date.now());

      const residual = pushed.failed.length + removed.failed.length;
      setSyncState(residual ? 'partial' : 'synced');
      if (residual) setSyncError(`${residual} modification(s) en attente de reconnexion.`);
    } catch (error) {
      setSyncState('offline');
      setSyncError(error?.message || 'Favoris non synchronisés pour le moment.');
    } finally {
      busyRef.current = false;
    }
  }, [cloudAvailable, setStored, setTombstones, userId]);

  useEffect(() => {
    if (!cloudAvailable) {
      setSyncState('local');
      return undefined;
    }
    void sync();
    const onOnline = () => void sync();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [cloudAvailable, sync]);

  const toggle = useCallback((entry) => {
    const path = normalizeFavoritePath(entry?.path);
    if (!path) return;
    const known = itemsRef.current.find((item) => item.path === path);

    setStored((current) => {
      const list = Array.isArray(current) ? current.filter((item) => item && typeof item === 'object') : [];
      if (known) return list.filter((item) => normalizeFavoritePath(item.path) !== path);
      return [...list, { ...entry, path }];
    });

    if (known) {
      setTombstones((current) => pruneTombstones([...(Array.isArray(current) ? current : []), path]));
    }

    if (!cloudAvailable) return;

    if (known) {
      removeFavorite(userId, { rowId: known.rowId, path })
        .then((done) => {
          if (done) setTombstones((current) => withoutTombstones(current, [path]));
        })
        .catch((error) => {
          setSyncState('offline');
          setSyncError(error?.message || 'Suppression à rejouer au prochain sync.');
        });
      return;
    }

    addFavorite(userId, { ...entry, path })
      .then(() => setLastSyncAt(Date.now()))
      .catch((error) => {
        // Le favori reste visible hors ligne et partira à la prochaine synchro.
        setSyncState('offline');
        setSyncError(error?.message || 'Ajout à rejouer au prochain sync.');
      });
  }, [cloudAvailable, setStored, setTombstones, userId]);

  const isFavorite = useCallback((path) => byPath.has(normalizeFavoritePath(path)), [byPath]);

  return {
    items,
    paths,
    toggle,
    isFavorite,
    sync: { state: syncState, lastSyncAt, error: syncError, retry: sync, enabled: cloudAvailable },
  };
}
