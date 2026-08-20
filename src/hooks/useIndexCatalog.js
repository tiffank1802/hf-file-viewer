import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchIndex } from '../services/api';
import { getFallbackCatalog } from '../data/fallbackData';

const INITIAL_STATE = {
  items: [],
  counts: {},
  totalFiles: null,
  loading: true,
  error: null,
  source: 'index-json',
  cacheStatus: null,
  fetchedAt: null,
};

/**
 * Charge une seule fois le JSON d’index du Worker (`GET /api/index`).
 *
 * Ce document contient déjà les effectifs par dossier calculés à
 * l’indexation : l’accueil, les cartes d’espaces, l’explorateur et la
 * recherche s’y réfèrent, sans jamais relancer de comptage en changeant de
 * dossier.
 */
export function useIndexCatalog() {
  const [state, setState] = useState(INITIAL_STATE);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setState((current) => ({ ...current, loading: true, error: null }));

    fetchIndex(controller.signal)
      .then((payload) => {
        if (cancelled) return;
        setState({
          items: payload.items,
          counts: payload.counts,
          totalFiles: payload.totalFiles,
          loading: false,
          error: null,
          source: 'index-json',
          cacheStatus: payload.cacheStatus,
          fetchedAt: payload.fetchedAt ?? null,
        });
      })
      .catch((error) => {
        if (cancelled || error.name === 'AbortError') return;
        const fallback = getFallbackCatalog();
        setState({
          items: fallback.items,
          counts: fallback.counts,
          totalFiles: fallback.totalFiles,
          loading: false,
          error: error.message || 'Index indisponible',
          source: 'fallback',
          cacheStatus: 'OFFLINE',
          fetchedAt: null,
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [reloadKey]);

  const getCount = useCallback(
    (path) => {
      const value = Number(state.counts?.[path]);
      return Number.isFinite(value) ? value : null;
    },
    [state.counts],
  );

  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);

  return useMemo(() => ({ ...state, getCount, refresh }), [state, getCount, refresh]);
}
