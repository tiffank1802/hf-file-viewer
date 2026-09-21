import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MAX_FAVORITE_NOTE,
  normalizeFavorite,
  normalizeFavoriteList,
  normalizeFavoritePath,
  planImport,
} from '../utils/favoritesEntry.js';
import {
  addFavorite,
  favoritesBlockers,
  favoritesEnabled,
  listFavorites,
  pushFavorites,
  removeFavorite,
  setFavoriteNote,
} from '../services/favorites.js';
import { drainLegacyFavorites, readLegacyFavorites } from '../services/favoritesLegacy.js';

/**
 * Favoris du visiteur : lus et écrits **dans le compte** (table `favorites` de
 * TablesDB), sans copie sur l'appareil. La liste vient de `listFavorites()`,
 * chaque cœur ajouté ou retiré part tout de suite en base.
 *
 * Ce que ça change par rapport à l'ancien miroir `localStorage` : une écriture
 * qui échoue (pas de réseau, permission `create()` refusée) est **annulée à
 * l'écran** et annoncée, pas gardée en secret. Les états :
 *
 * - `'anonymous'`     : pas de session — rien à lire, rien à écrire ;
 * - `'disabled'`      : Appwrite incomplet dans ce build (database ID manquant) ;
 * - `'loading'`       : première lecture du compte en cours ;
 * - `'synced'`        : la liste affichée est celle du compte ;
 * - `'unprovisioned'` : la table `favorites` n'existe pas (`npm run appwrite:setup`) ;
 * - `'forbidden'`     : table là, accès refusé — la cause est dans `error` ;
 * - `'read-failed'`   : lecture impossible (réseau, 500) — la liste en mémoire est
 *   conservée, mais rien n'est inventé ni rechargé d'un cache ;
 * - `'write-failed'`  : ajout ou retrait refusé, interface revenue en arrière ;
 * - `'import'`        : favoris repris de l'ancien miroir pas encore tous envoyés.
 */
export function useFavorites(user) {
  const userId = user?.$id ?? null;
  const enabled = favoritesEnabled();
  const cloudAvailable = enabled && Boolean(userId);

  const [items, setItems] = useState([]);
  const [syncState, setSyncState] = useState('loading');
  const [syncError, setSyncError] = useState(null);
  // Erreur d'action : « ton geste a été refusé », à la différence de `syncError`
  // qui décrit l'état de fond. Un visiteur sans session n'a rien à lire : sans
  // ce canal, son clic sur un cœur ne produirait aucun retour visible.
  const [actionError, setActionError] = useState(null);
  const [lastSyncAt, setLastSyncAt] = useState(null);

  const itemsRef = useRef(items);
  const busyRef = useRef(false);

  useEffect(() => { itemsRef.current = items; }, [items]);

  // Changer de compte = repartir de la liste du compte : rien n'est conservé ici.
  useEffect(() => {
    setItems([]);
    setSyncError(null);
    setActionError(null);
    if (cloudAvailable) {
      setSyncState('loading');
      return;
    }
    const reasons = favoritesBlockers(userId);
    setSyncState(enabled ? 'anonymous' : 'disabled');
    setSyncError(reasons.length ? reasons.join(' · ') : null);
  }, [cloudAvailable, enabled, userId]);

  const sync = useCallback(async () => {
    if (!cloudAvailable || busyRef.current) return;
    busyRef.current = true;
    setSyncState('loading');
    setSyncError(null);
    // Une relance efface la trace du geste refusé : sinon le bandeau resterait
    // après que « Réessayer » a fonctionné.
    setActionError(null);
    try {
      let listed;
      try {
        listed = await listFavorites(userId);
      } catch (error) {
        // Pas de filet local : une lecture qui échoue se voit, et la liste déjà
        // affichée reste en mémoire telle quelle (aucun cache à ressasser).
        setSyncState(error?.forbidden ? 'forbidden' : 'read-failed');
        setSyncError(error?.message || 'Lecture des favoris impossible.');
        return;
      }
      if (listed === null) {
        setItems([]);
        setSyncState('unprovisioned');
        setSyncError('La table `favorites` est absente de ce projet : relance `npm run appwrite:setup`.');
        return;
      }

      let cloud = normalizeFavoriteList(listed);

      // Une fois : récupérer ce que l'ancien miroir `localStorage` a laissé de côté.
      const legacy = readLegacyFavorites();
      const plan = planImport({ cloud, legacy });
      let remaining = [];
      let importBlocked = null;
      let importReason = null;
      if (plan.pending.length) {
        const pushed = await pushFavorites(userId, plan.pending);
        if (pushed.blockers?.length) {
          // Rien n'a pu être tenté : on ne vide pas la file d'import pour autant,
          // ces favoris-là partiraient dans le vide.
          importBlocked = pushed.blockers.join(' ');
        } else {
          cloud = normalizeFavoriteList([...cloud, ...pushed.saved]);
          const failed = new Set(pushed.failed.map((item) => normalizeFavoritePath(item.path)));
          remaining = plan.pending.filter((entry) => failed.has(entry.path));
          importReason = pushed.failed[0]?.reason || 'écriture refusée.';
        }
      }
      if (legacy.length && !importBlocked) drainLegacyFavorites(remaining);

      setItems(cloud);
      setLastSyncAt(Date.now());
      if (importBlocked) {
        setSyncState('import');
        setSyncError(`Reprise de l’ancien cache suspendue : ${importBlocked}`);
      } else if (remaining.length) {
        setSyncState('import');
        setSyncError(
          `${remaining.length} favori(s) repris de ce navigateur n’ont pas rejoint le compte : ${importReason}`,
        );
      } else {
        setSyncState('synced');
      }
    } catch (error) {
      setSyncState('read-failed');
      setSyncError(error?.message || 'Synchronisation des favoris interrompue.');
    } finally {
      busyRef.current = false;
    }
  }, [cloudAvailable, userId]);

  useEffect(() => {
    if (!cloudAvailable) return undefined;
    void sync();
    const onOnline = () => void sync();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [cloudAvailable, sync]);

  const toggle = useCallback((entry) => {
    const path = normalizeFavoritePath(entry?.path);
    if (!path) return;
    const known = itemsRef.current.find((item) => item.path === path);

    if (!cloudAvailable) {
      setSyncState(enabled ? 'anonymous' : 'disabled');
      setActionError(
        known
          ? 'Connecte-toi pour retirer un favori : la liste vit dans le compte.'
          : 'Connecte-toi pour épingler : rien n’est gardé sur cet appareil.',
      );
      return;
    }
    setActionError(null);

    if (known) {
      setItems((current) => current.filter((item) => item.path !== path));
      removeFavorite(userId, { rowId: known.rowId, path })
        .then((done) => {
          if (!done) throw new Error('Ligne introuvable dans le compte : retire le favori puis re-épingle-le.');
          setLastSyncAt(Date.now());
        })
        .catch((error) => {
          // Aucun « à rejouer plus tard » : l'anneau revient, et on le dit.
          setItems((current) => (
            current.some((item) => item.path === path) ? current : [known, ...current]
          ));
          setSyncState('write-failed');
          setActionError(error?.message || 'Suppression refusée par Appwrite.');
        });
      return;
    }

    const draft = normalizeFavorite({ ...entry, path });
    setItems((current) => (current.some((item) => item.path === path) ? current : [...current, draft]));
    addFavorite(userId, draft)
      .then((saved) => {
        setItems((current) => current.map((item) => (item.path === path ? { ...item, ...(saved ?? {}) } : item)));
        setLastSyncAt(Date.now());
        setSyncState('synced');
        setActionError(null);
      })
      .catch((error) => {
        setItems((current) => current.filter((item) => item.path !== path));
        setSyncState('write-failed');
        setActionError(error?.message || 'Enregistrement du favori refusé par Appwrite.');
      });
  }, [cloudAvailable, enabled, userId]);

  /** Note d'un favori : modifiée en base, annulée à l'écran si le compte refuse. */
  const setNote = useCallback(async (path, note) => {
    const target = itemsRef.current.find((item) => item.path === normalizeFavoritePath(path));
    if (!target) return;
    if (!target.rowId) {
      setSyncState('write-failed');
      setActionError('Ce favori n’a pas de ligne dans le compte : retire-le et re-épingle-le.');
      return;
    }
    const next = String(note ?? '').slice(0, MAX_FAVORITE_NOTE);
    const previous = target.note ?? '';
    setItems((current) => current.map((item) => (item.path === target.path ? { ...item, note: next } : item)));
    try {
      await setFavoriteNote(userId, target.rowId, next);
      setLastSyncAt(Date.now());
    } catch (error) {
      setItems((current) => current.map((item) => (item.path === target.path ? { ...item, note: previous } : item)));
      setSyncState('write-failed');
      setActionError(error?.message || 'Note non enregistrée.');
    }
  }, [userId]);

  const isFavorite = useCallback((path) => items.some((item) => item.path === normalizeFavoritePath(path)), [items]);
  const paths = useMemo(() => items.map((item) => item.path), [items]);

  return {
    items,
    paths,
    toggle,
    setNote,
    isFavorite,
    sync: {
      state: syncState,
      lastSyncAt,
      error: syncError,
      actionError,
      clearActionError: () => setActionError(null),
      retry: sync,
      enabled: cloudAvailable,
    },
  };
}
