import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTree } from '../services/api';
import { getFallbackTree } from '../data/fallbackData';
import { hrefFromLibraryPath, pathFromHash, pathFromLocation } from '../utils/routes';

/** Un onglet resté ouvert relit le dossier affiché à ce rythme. */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function useLibrary() {
  const [path, setPath] = useState(() => pathFromLocation());
  const [state, setState] = useState({
    items: [],
    loading: true,
    error: null,
    source: 'network',
    cacheStatus: null,
    fetchedAt: null,
  });
  const [reloadKey, setReloadKey] = useState(0);
  const cacheRef = useRef(new Map());
  // Une relecture périodique ne doit ni vider la liste ni afficher de squelette.
  const backgroundRef = useRef(false);

  useEffect(() => {
    const syncPath = () => {
      setPath(pathFromLocation());
    };
    const onHashChange = () => {
      const nextPath = pathFromHash();
      if (nextPath !== null) setPath(nextPath);
    };
    window.addEventListener('popstate', syncPath);
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('popstate', syncPath);
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const background = backgroundRef.current;
    backgroundRef.current = false;
    // Une relecture en arrière-plan ignore le cache : c’est tout son intérêt.
    const cached = background ? null : cacheRef.current.get(path);

    if (cached) {
      setState({ ...cached, loading: false });
      return () => controller.abort();
    }

    if (!background) {
      setState((current) => ({ ...current, items: [], loading: true, error: null }));
    }

    fetchTree(path, controller.signal)
      .then((payload) => {
        const nextState = {
          items: payload.items,
          loading: false,
          error: null,
          source: 'huggingface',
          cacheStatus: payload.cacheStatus,
          fetchedAt: payload.fetchedAt,
        };
        cacheRef.current.set(path, nextState);
        setState(nextState);
      })
      .catch((error) => {
        if (error.name === 'AbortError') return;
        // Relecture silencieuse : un échec réseau passager ne remplace pas la
        // liste affichée par les données de secours.
        if (background) return;
        const fallbackItems = getFallbackTree(path);
        const nextState = {
          items: fallbackItems,
          loading: false,
          error: error.message,
          source: 'fallback',
          cacheStatus: 'OFFLINE',
          fetchedAt: null,
        };
        setState(nextState);
      });

    return () => controller.abort();
  }, [path, reloadKey]);

  // Le dossier affiché est relu en arrière-plan : un dossier ajouté dans le
  // bucket apparaît sans rechargement de page.
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      cacheRef.current.delete(path);
      backgroundRef.current = true;
      setReloadKey((key) => key + 1);
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [path]);

  const navigate = useCallback(
    (nextPath = '', options = {}) => {
      const normalized = nextPath.replace(/^\/+|\/+$/g, '');
      const nextHref = hrefFromLibraryPath(normalized);
      const current = `${window.location.pathname}${window.location.search}`;
      if (current !== nextHref || window.location.hash) {
        window.history.pushState({ libraryPath: normalized }, '', nextHref);
        setPath(normalized);
      } else {
        setPath(normalized);
      }
      if (options.scroll !== false) {
        window.requestAnimationFrame(() => {
          document.getElementById('library')?.scrollIntoView({
            behavior: options.instant ? 'auto' : 'smooth',
            block: 'start',
          });
        });
      }
    },
    [],
  );

  const retry = useCallback(() => {
    cacheRef.current.delete(path);
    setReloadKey((key) => key + 1);
  }, [path]);

  const prefetch = useCallback((nextPath) => {
    const normalized = nextPath.replace(/^\/+|\/+$/g, '');
    if (cacheRef.current.has(normalized)) return;
    fetchTree(normalized)
      .then((payload) => {
        cacheRef.current.set(normalized, {
          items: payload.items,
          loading: false,
          error: null,
          source: 'huggingface',
          cacheStatus: payload.cacheStatus,
          fetchedAt: payload.fetchedAt,
        });
      })
      .catch(() => {});
  }, []);

  return {
    path,
    ...state,
    navigate,
    retry,
    prefetch,
  };
}
