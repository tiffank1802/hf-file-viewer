import { useEffect, useState } from 'react';
import { fetchCounts } from '../services/api';

export function useLiveCounts(prefix = '') {
  const [state, setState] = useState({
    counts: {},
    totalFiles: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({
      counts: {},
      totalFiles: null,
      loading: true,
      error: null,
    });

    fetchCounts(prefix, controller.signal)
      .then((payload) => {
        setState({
          counts: payload.counts || {},
          totalFiles: Number.isFinite(Number(payload.totalFiles)) ? Number(payload.totalFiles) : null,
          loading: false,
          error: null,
        });
      })
      .catch((error) => {
        if (error.name === 'AbortError') return;
        setState({
          counts: {},
          totalFiles: null,
          loading: false,
          error: error.message || 'Nombre indisponible',
        });
      });

    return () => controller.abort();
  }, [prefix]);

  return state;
}
