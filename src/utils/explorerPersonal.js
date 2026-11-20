import { inExplorerScope } from './explorer.js';
import { normalizeBucketItem, searchItems } from './files.js';

export const TAGS = [
  { id: 'important', label: 'Important', color: '#dc3f50' },
  { id: 'review', label: 'À réviser', color: '#d77e14' },
  { id: 'project', label: 'Projet', color: '#17883e' },
  { id: 'reference', label: 'Référence', color: '#2472ca' },
  { id: 'personal', label: 'Personnel', color: '#8052bd' },
];
export const DEFAULT_FILTERS = { folder: '', kind: '', date: '', size: '', tag: '' };
export const EMPTY_PERSONAL = { recent: [], labels: [], searches: [], pinnedOrder: [] };

export function normalizeFilters(value) {
  return {
    folder: typeof value?.folder === 'string' ? value.folder : '',
    kind: ['folder', 'pdf', 'office', 'image', 'model', 'audio', 'video', 'text', 'archive', 'file'].includes(value?.kind) ? value.kind : '',
    date: ['7', '30', '365'].includes(value?.date) ? value.date : '',
    size: ['small', 'large'].includes(value?.size) ? value.size : '',
    tag: TAGS.some(({ id }) => id === value?.tag) ? value.tag : '',
  };
}

export function hasExplorerFilters(filters) {
  return Object.values(filters).some(Boolean);
}

export function normalizePersonal(value) {
  const recent = Array.isArray(value?.recent) ? value.recent.filter((item) => typeof item?.path === 'string' && item.path).slice(0, 30).map(normalizeBucketItem) : [];
  const labels = Array.isArray(value?.labels) ? value.labels.filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1])).slice(0, 500) : [];
  const searches = Array.isArray(value?.searches) ? value.searches.filter((entry) => typeof entry?.id === 'string' && typeof entry?.label === 'string' && typeof entry?.query === 'string').slice(0, 20)
    .map((entry) => ({ ...entry, filters: normalizeFilters(entry.filters) })) : [];
  const pinnedOrder = Array.isArray(value?.pinnedOrder) ? value.pinnedOrder.filter((entry) => typeof entry === 'string').slice(0, 500) : [];
  return { recent, labels, searches, pinnedOrder };
}

export function recordExplorerRecent(recent, item) {
  if (!item.path) return recent;
  return [normalizeBucketItem({ name: item.name, path: item.path, type: item.type, size: item.size, mtime: item.mtime }),
    ...recent.filter((entry) => entry.path !== item.path)].slice(0, 30);
}

export function toggleExplorerTag(labels, path, tag) {
  if (!TAGS.some(({ id }) => id === tag)) return labels;
  const next = new Map(labels);
  const current = new Set(next.get(path));
  if (current.has(tag)) current.delete(tag);
  else current.add(tag);
  next.delete(path);
  if (current.size) next.set(path, [...current]);
  return [...next].slice(-500);
}

export function searchExplorerCatalog(items, query, filters, labels, now = Date.now()) {
  const threshold = 1024 * 1024;
  const matches = items.filter((item) => {
    if (!inExplorerScope(item.path, filters.folder)) return false;
    if (filters.kind && item.kind !== filters.kind) return false;
    if (filters.tag && !labels.get(item.path)?.includes(filters.tag)) return false;
    if (filters.date && !(Date.parse(item.mtime) >= now - Number(filters.date) * 86_400_000)) return false;
    if (filters.size && (item.type === 'directory' || !(item.size > 0) || (filters.size === 'large' ? item.size < threshold : item.size >= threshold))) return false;
    return true;
  });
  return query.trim() ? searchItems(matches, query, 60) : matches.slice(0, 60);
}

export function orderPinnedFolders(folders, paths) {
  const pending = new Map(folders.map((folder) => [folder.path, folder]));
  const ordered = [];
  for (const path of paths) {
    if (pending.has(path)) {
      ordered.push(pending.get(path));
      pending.delete(path);
    }
  }
  return [...ordered, ...pending.values()];
}

export function movePinnedFolder(paths, from, to) {
  const start = paths.indexOf(from);
  const end = paths.indexOf(to);
  if (start < 0 || end < 0 || start === end) return paths;
  const next = [...paths];
  next.splice(start, 1);
  next.splice(end, 0, from);
  return next;
}
