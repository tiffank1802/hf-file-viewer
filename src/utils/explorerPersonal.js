import { inExplorerScope } from './explorer.js';
import { normalizeBucketItem, searchItems } from './files.js';

export const TAGS = [
  { id: 'important', label: 'Important', color: '#dc3f50' },
  { id: 'review', label: 'À réviser', color: '#d77e14' },
  { id: 'project', label: 'Projet', color: '#17883e' },
  { id: 'reference', label: 'Référence', color: '#2472ca' },
  { id: 'personal', label: 'Personnel', color: '#8052bd' },
];
export const TAG_COLORS = [
  ...TAGS.map(({ color }, index) => ({ color, label: ['Rouge', 'Orange', 'Vert', 'Bleu', 'Violet'][index] })),
  { color: '#596876', label: 'Gris' },
];
export const MAX_CUSTOM_TAGS = 32;
export const MAX_TAG_NAME = 28;
const CUSTOM_TAG_ID = /^custom-[a-z0-9-]{1,64}$/;
const canonicalTagName = (name) => name.toLocaleLowerCase('fr');

export function normalizeTagName(value) {
  return typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/gu, ' ').slice(0, MAX_TAG_NAME) : '';
}

export function normalizeCustomTags(value) {
  const ids = new Set(TAGS.map(({ id }) => id));
  const names = new Set(TAGS.map(({ label }) => canonicalTagName(label)));
  const custom = [];
  for (const input of Array.isArray(value) ? value : []) {
    if (custom.length >= MAX_CUSTOM_TAGS) break;
    const label = normalizeTagName(input?.label);
    const id = input?.id;
    const color = input?.color;
    const canonical = canonicalTagName(label);
    if (!label || typeof id !== 'string' || !CUSTOM_TAG_ID.test(id) || ids.has(id) || names.has(canonical) || !TAG_COLORS.some((entry) => entry.color === color)) continue;
    custom.push({ id, label, color });
    ids.add(id);
    names.add(canonical);
  }
  return custom;
}

export function attachExplorerTag(personal, path, { id, label, color }) {
  const name = normalizeTagName(label);
  if (!path || !name) return personal;
  const known = [...TAGS, ...personal.customTags];
  const existing = known.find((entry) => canonicalTagName(entry.label) === canonicalTagName(name));
  if (!existing && known.some((entry) => entry.id === id)) return personal;
  const customTags = existing ? personal.customTags : normalizeCustomTags([...personal.customTags, { id, label: name, color }]);
  const tag = existing ?? customTags.find((entry) => entry.id === id);
  if (!tag) return personal;
  const labels = new Map(personal.labels);
  labels.set(path, [...new Set([...(labels.get(path) ?? []), tag.id])]);
  return { ...personal, labels: [...labels].slice(-500), customTags };
}

export const DEFAULT_FILTERS = { folder: '', kind: '', date: '', size: '', tag: '' };
export const EMPTY_PERSONAL = { recent: [], labels: [], searches: [], pinnedOrder: [], customTags: [] };

export function normalizeFilters(value, tags = TAGS) {
  return {
    folder: typeof value?.folder === 'string' ? value.folder : '',
    kind: ['folder', 'pdf', 'office', 'image', 'model', 'audio', 'video', 'text', 'archive', 'file'].includes(value?.kind) ? value.kind : '',
    date: ['7', '30', '365'].includes(value?.date) ? value.date : '',
    size: ['small', 'large'].includes(value?.size) ? value.size : '',
    tag: tags.some(({ id }) => id === value?.tag) ? value.tag : '',
  };
}

export function hasExplorerFilters(filters) {
  return Object.values(filters).some(Boolean);
}

export function normalizePersonal(value) {
  const customTags = normalizeCustomTags(value?.customTags);
  const tags = [...TAGS, ...customTags];
  const known = new Set(tags.map(({ id }) => id));
  const recent = Array.isArray(value?.recent) ? value.recent.filter((item) => typeof item?.path === 'string' && item.path).slice(0, 30).map(normalizeBucketItem) : [];
  const labels = Array.isArray(value?.labels) ? value.labels.filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1])).slice(0, 500)
    .map(([path, ids]) => [path, [...new Set(ids.filter((id) => known.has(id)))]])
    .filter(([, ids]) => ids.length > 0) : [];
  const searches = Array.isArray(value?.searches) ? value.searches.filter((entry) => typeof entry?.id === 'string' && typeof entry?.label === 'string' && typeof entry?.query === 'string').slice(0, 20)
    .map((entry) => ({ ...entry, filters: normalizeFilters(entry.filters, tags) })) : [];
  const pinnedOrder = Array.isArray(value?.pinnedOrder) ? value.pinnedOrder.filter((entry) => typeof entry === 'string').slice(0, 500) : [];
  return { recent, labels, searches, pinnedOrder, customTags };
}

export function recordExplorerRecent(recent, item) {
  if (!item.path) return recent;
  return [normalizeBucketItem({ name: item.name, path: item.path, type: item.type, size: item.size, mtime: item.mtime }),
    ...recent.filter((entry) => entry.path !== item.path)].slice(0, 30);
}

export function toggleExplorerTag(labels, path, tag, tags = TAGS) {
  if (!tags.some(({ id }) => id === tag)) return labels;
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
