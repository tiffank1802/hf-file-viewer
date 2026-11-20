import { useCallback, useEffect, useState } from 'react';
import { LOADING_FOLDER } from '../services/folderReader.js';

const REFRESH_INTERVAL = 5 * 60_000;

export function useFolder(reader, path, { autoRefresh = false } = {}) {
  const [result, setResult] = useState(null);
  const [refresh, setRefresh] = useState(null);
  const retry = useCallback(() => setRefresh({ path, background: false }), [path]);
  const currentRefresh = refresh?.path === path ? refresh : null;

  useEffect(() => {
    if (path === null) return undefined;
    let active = true;
    const { result: promise, release } = reader.acquire(path, { refresh: Boolean(currentRefresh) });
    promise.then((data) => {
      if (!active) return;
      setResult((current) => ({
        path, refresh: currentRefresh,
        data: currentRefresh?.background && data.error && current?.path === path ? current.data : data,
      }));
    }).catch(() => {}); // Released readers may be aborted.
    return () => {
      active = false;
      release();
    };
  }, [reader, path, currentRefresh]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') setRefresh({ path, background: true });
    }, REFRESH_INTERVAL);
    return () => window.clearInterval(interval);
  }, [autoRefresh, path]);

  const ready = result?.path === path && (result.refresh === currentRefresh || currentRefresh?.background);
  return { ...(ready ? result.data : LOADING_FOLDER), retry };
}
