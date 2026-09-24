import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addFavorite,
  importFavorites,
  listFavorites,
  removeFavorite,
  setFavoriteNote,
} from '../services/favoritesApi.js';
import { drainLegacyFavorites, readLegacyFavorites } from '../services/favoritesLegacy.js';
import {
  MAX_FAVORITE_NOTE,
  normalizeFavorite,
  normalizeFavoriteList,
  normalizeFavoritePath,
  planImport,
} from '../utils/favoritesEntry.js';

/**
 * Favoris du compte, lus et écrits via Go. Rien n'est gardé dans le navigateur,
 * sauf le reliquat d'un ancien miroir local le temps de l'importer une fois.
 */
export function useFavorites(user) {
  const userId = user?.id ?? null;
  const [items, setItems] = useState([]);
  const [syncState, setSyncState] = useState(userId ? 'loading' : 'anonymous');
  const [syncError, setSyncError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const itemsRef = useRef(items);
  const busyRef = useRef(false);

  useEffect(() => { itemsRef.current = items; }, [items]);

  useEffect(() => {
    setItems([]);
    setSyncError(null);
    setActionError(null);
    setSyncState(userId ? 'loading' : 'anonymous');
  }, [userId]);

  const sync = useCallback(async () => {
    if (!userId || busyRef.current) return;
    busyRef.current = true;
    setSyncState('loading');
    setSyncError(null);
    setActionError(null);
    try {
      const payload = await listFavorites();
      if (payload.unprovisioned) {
        setItems([]);
        setSyncState('unprovisioned');
        setSyncError(payload.error || 'La table favorites est absente. Lance npm run appwrite:setup.');
        return;
      }
      if (payload.enabled === false) {
        setItems([]);
        setSyncState('disabled');
        setSyncError(payload.error || 'Favoris du compte non configurés.');
        return;
      }
      let cloud = normalizeFavoriteList(payload.items);
      const legacy = readLegacyFavorites();
      const plan = planImport({ cloud, legacy });
      let remaining = [];
      if (plan.pending.length) {
        const pushed = await importFavorites(plan.pending);
        const saved = normalizeFavoriteList(pushed.saved);
        cloud = normalizeFavoriteList([...cloud, ...saved]);
        const failed = new Set((pushed.failed || []).map((item) => normalizeFavoritePath(item.path)));
        remaining = plan.pending.filter((entry) => failed.has(entry.path));
      }
      if (legacy.length) drainLegacyFavorites(remaining);
      setItems(cloud);
      if (remaining.length) {
        setSyncState('import');
        setSyncError(`${remaining.length} favori(s) de cet appareil n’ont pas rejoint le compte.`);
      } else {
        setSyncState('synced');
      }
    } catch (error) {
      setSyncState(error?.status === 401 ? 'anonymous' : 'read-failed');
      setSyncError(error?.message || 'Lecture des favoris impossible.');
    } finally {
      busyRef.current = false;
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return undefined;
    void sync();
    return undefined;
  }, [sync, userId]);

  const toggle = useCallback((entry) => {
    const path = normalizeFavoritePath(entry?.path);
    if (!path) return;
    const known = itemsRef.current.find((item) => item.path === path);
    if (!userId) {
      setSyncState('anonymous');
      setActionError(known
        ? 'Connecte-toi pour retirer un favori : la liste vit dans le compte.'
        : 'Connecte-toi pour épingler : rien n’est gardé sur cet appareil.');
      return;
    }
    setActionError(null);
    if (known) {
      setItems((current) => current.filter((item) => item.path !== path));
      removeFavorite({ rowId: known.rowId, path })
        .catch((error) => {
          setItems((current) => (current.some((item) => item.path === path) ? current : [known, ...current]));
          setSyncState('write-failed');
          setActionError(error?.message || 'Suppression refusée.');
        });
      return;
    }
    const draft = normalizeFavorite({ ...entry, path });
    setItems((current) => [...current, draft]);
    addFavorite(draft)
      .then((payload) => {
        const saved = payload.item ? { ...draft, ...payload.item } : draft;
        setItems((current) => current.map((item) => (item.path === path ? saved : item)));
        setSyncState('synced');
      })
      .catch((error) => {
        setItems((current) => current.filter((item) => item.path !== path));
        setSyncState('write-failed');
        setActionError(error?.message || 'Enregistrement du favori refusé.');
      });
  }, [userId]);

  const setNote = useCallback(async (path, note) => {
    const target = itemsRef.current.find((item) => item.path === normalizeFavoritePath(path));
    if (!target?.rowId) return;
    const next = String(note ?? '').slice(0, MAX_FAVORITE_NOTE);
    const previous = target.note ?? '';
    setItems((current) => current.map((item) => (item.path === target.path ? { ...item, note: next } : item)));
    try {
      await setFavoriteNote(target.rowId, next);
    } catch (error) {
      setItems((current) => current.map((item) => (item.path === target.path ? { ...item, note: previous } : item)));
      setSyncState('write-failed');
      setActionError(error?.message || 'Note non enregistrée.');
    }
  }, []);

  const paths = useMemo(() => items.map((item) => item.path), [items]);

  return {
    items,
    paths,
    toggle,
    setNote,
    sync: {
      state: syncState,
      error: syncError,
      actionError,
      clearActionError: () => setActionError(null),
      retry: sync,
    },
  };
}
