import { getFallbackTree } from '../data/fallbackData.js';
import { fetchTree } from './api.js';

export const LOADING_FOLDER = Object.freeze({
  items: Object.freeze([]), loading: true, error: null, source: 'network', cacheStatus: null, fetchedAt: null,
});

// Readers for the active folder, columns, inline disclosure and prefetch share
// one bounded cache. Cancel the transport only when its last reader leaves.
export function createFolderReader({ fetchFolder = fetchTree, fallback = getFallbackTree, ttl = 5 * 60_000, limit = 100 } = {}) {
  const cached = new Map();
  const pending = new Map();

  function acquire(path, { refresh = false } = {}) {
    const entry = cached.get(path);
    if (!refresh && entry && Date.now() - entry.time < ttl) {
      cached.delete(path);
      cached.set(path, entry);
      return { result: Promise.resolve(entry.value), release() {} };
    }

    let request = pending.get(path);
    if (!request) {
      const controller = new AbortController();
      request = { controller, readers: 0, result: null };
      const activeRequest = request;
      pending.set(path, request);
      request.result = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return fetchFolder(path, controller.signal);
        })
        .then((payload) => {
          controller.signal.throwIfAborted();
          const value = {
            items: payload.items, loading: false, error: null, source: 'huggingface',
            cacheStatus: payload.cacheStatus, fetchedAt: payload.fetchedAt,
          };
          cached.delete(path);
          cached.set(path, { value, time: Date.now() });
          if (cached.size > limit) cached.delete(cached.keys().next().value);
          return value;
        })
        .catch((error) => {
          if (controller.signal.aborted) throw error;
          return {
            items: fallback(path), loading: false, error: error.message || 'Dossier indisponible.',
            source: 'fallback', cacheStatus: 'OFFLINE', fetchedAt: null,
          };
        })
        .finally(() => {
          if (pending.get(path) === activeRequest) pending.delete(path);
        });
    }

    request.readers += 1;
    let released = false;
    return {
      result: request.result,
      release() {
        if (released) return;
        released = true;
        request.readers -= 1;
        queueMicrotask(() => {
          if (request.readers === 0 && pending.get(path) === request) {
            pending.delete(path);
            request.controller.abort();
          }
        });
      },
    };
  }

  return { acquire };
}
