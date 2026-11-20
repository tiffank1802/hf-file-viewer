import { useCallback, useEffect, useMemo, useState } from 'react';
import { EMPTY_PERSONAL, movePinnedFolder, normalizeFilters, normalizePersonal, recordExplorerRecent, TAGS, toggleExplorerTag } from '../utils/explorerPersonal.js';

function readPersonal(key) {
  try {
    return normalizePersonal(JSON.parse(window.localStorage.getItem(key)));
  } catch {
    return EMPTY_PERSONAL;
  }
}

export function useExplorerPersonal(userId) {
  const key = `enise-explorer-personal-v1:${userId ? `account:${userId}` : 'guest'}`;
  const [stored, setStored] = useState(() => ({ key, data: readPersonal(key) }));
  const data = stored.key === key ? stored.data : EMPTY_PERSONAL;

  useEffect(() => {
    setStored((current) => current.key === key ? current : { key, data: readPersonal(key) });
  }, [key]);
  useEffect(() => {
    if (stored.key !== key) return;
    try { window.localStorage.setItem(key, JSON.stringify(stored.data)); } catch { /* Session-only fallback. */ }
  }, [key, stored]);

  const update = useCallback((makePatch) => {
    setStored((current) => {
      const base = current.key === key ? current.data : readPersonal(key);
      return { key, data: { ...base, ...makePatch(base) } };
    });
  }, [key]);
  const record = useCallback((item) => update((base) => ({ recent: recordExplorerRecent(base.recent, item) })), [update]);
  const toggleTag = useCallback((path, tag) => update((base) => ({ labels: toggleExplorerTag(base.labels, path, tag) })), [update]);
  const saveSearch = useCallback((label, query, filters) => {
    const id = `${Date.now()}-${Math.random()}`;
    update((base) => ({ searches: [{ id, label: label.trim().slice(0, 60), query, filters: normalizeFilters(filters) }, ...base.searches].slice(0, 20) }));
  }, [update]);
  const removeSearch = useCallback((id) => update((base) => ({ searches: base.searches.filter((entry) => entry.id !== id) })), [update]);
  const movePinned = useCallback((paths, from, to) => update(() => ({ pinnedOrder: movePinnedFolder(paths, from, to) })), [update]);
  const labels = useMemo(() => new Map(data.labels), [data.labels]);
  const tagsFor = useCallback((path) => TAGS.map((tag) => ({ ...tag, active: labels.get(path)?.includes(tag.id) ?? false })), [labels]);
  return { key, recent: data.recent, searches: data.searches, labels, tagsFor, toggleTag, record, saveSearch, removeSearch, pinnedOrder: data.pinnedOrder, movePinned };
}
