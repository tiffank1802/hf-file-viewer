import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTree } from '../services/api';
import { getFallbackTree } from '../data/fallbackData';
import { hrefFromLibraryPath, pathFromHash, pathFromLocation } from '../utils/routes';

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
    const cached = cacheRef.current.get(path);

    if (cached) {
      setState({ ...cached, loading: false });
      return () => controller.abort();
    }

    setState((current) => ({ ...current, items: [], loading: true, error: null }));

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
