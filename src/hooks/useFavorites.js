import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalStorage } from './useLocalStorage.js';
import {
  FAVORITES_STORAGE_KEY,
  FAVORITES_TOMBSTONES_KEY,
  normalizeFavoriteList,
  normalizeFavoritePath,
  planReconcile,
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
      // Étape 1 : lire le cloud. Un échec ici n'EST PAS un motif d'abandon —
      // voir `planReconcile` : les favoris locaux doivent quand même partir,
      // sinon une table un temps sans permission reste vide pour toujours.
      let cloud = null;
      let unreadable = false;
      let detail = null;
      try {
        const listed = await listFavorites(userId);
        if (listed === null) {
          // Table absente du projet : ni lecture possible, ni écriture utile.
          setSyncState('unprovisioned');
          return;
        }
        cloud = listed;
      } catch (error) {
        unreadable = true;
        detail = error?.message || 'Favoris illisibles pour le moment.';
      }

      const plan = planReconcile({
        cloud,
        local: itemsRef.current,
        tombstones: tombstonesRef.current,
        cloudUnavailable: unreadable,
      });

      // Étape 2 : écrire les écarts. L'index unique rend l'opération rejouable.
      const [pushResult, deleteResult] = await Promise.allSettled([
        pushFavorites(userId, plan.pending),
        plan.toDelete.length
          ? deleteFavoritePaths(userId, plan.toDelete)
          : Promise.resolve({ deleted: 0, failed: [] }),
      ]);
      const pushed = pushResult.status === 'fulfilled'
        ? pushResult.value
        : { pushed: 0, failed: plan.pending.map((entry) => ({ path: entry.path, reason: 'écriture interrompue.' })), saved: [] };
      const removed = deleteResult.status === 'fulfilled'
        ? deleteResult.value
        : { deleted: 0, failed: plan.toDelete };

      // Étape 3 : le miroir local récupère les `rowId` renvoyés par Appwrite —
      // une suppression directe plutôt qu'un relistage à chaque cœur retiré.
      const enriched = new Map((pushed.saved ?? []).map((entry) => [entry.path, entry]));
      setStored(plan.items.map((entry) => enriched.get(entry.path) ?? entry));
      setTombstones((current) =>
        withoutTombstones(current, plan.toDelete.filter((path) => !removed.failed.includes(path))),
      );
      setLastSyncAt(Date.now());

      const residual = pushed.failed.length + removed.failed.length;
      if (unreadable) {
        setSyncState(pushed.pushed ? 'partial' : 'forbidden');
        setSyncError(`${detail}${pushed.pushed ? ` · ${pushed.pushed} favori(s) tout de même enregistré(s).` : ''}`);
      } else if (residual) {
        setSyncState('partial');
        setSyncError(`${residual} favori(s) non enregistré(s) : ${pushed.failed[0]?.reason || 'écriture refusée par Appwrite.'}`);
      } else {
        setSyncState('synced');
      }
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
      .then((saved) => {
        setLastSyncAt(Date.now());
        if (saved?.rowId) {
          setStored((current) => (Array.isArray(current) ? current : []).map((item) => (
            item && normalizeFavoritePath(item.path) === path ? { ...item, rowId: saved.rowId } : item
          )));
        }
      })
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
