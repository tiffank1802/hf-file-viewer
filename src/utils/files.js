const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'html', 'htm',
  'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp',
  'sh', 'toml', 'ini', 'log', 'tex', 'rst',
]);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi']);
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2']);

export function getName(path = '') {
  return path.split('/').filter(Boolean).pop() || 'Bibliothèque';
}

export function getExtension(path = '') {
  const name = getName(path);
  if (!name.includes('.')) return '';
  return name.split('.').pop().toLowerCase();
}

export function getFileKind(path = '', type = 'file') {
  if (type === 'directory') return 'folder';
  const extension = getExtension(path);
  if (extension === 'pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  if (OFFICE_EXTENSIONS.has(extension)) return 'office';
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
  return 'file';
}

export function normalizeBucketItem(item) {
  const path = String(item.path || '');
  const type = item.type === 'directory' ? 'directory' : 'file';
  const rawCount = item.numItems ?? item.totalFiles ?? item.count;
  return {
    ...item,
    path,
    type,
    name: item.name || getName(path),
    size: Number(item.size) || 0,
    mtime: item.mtime || item.uploadedAt || item.uploaded_at || null,
    count: Number.isFinite(Number(rawCount)) ? Number(rawCount) : null,
    kind: getFileKind(path, type),
  };
}

export function formatBytes(bytes, locale = 'fr-FR') {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** exponent;
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: amount >= 10 || exponent === 0 ? 0 : 1,
  }).format(amount)} ${units[exponent]}`;
}

export function formatDate(value) {
  if (!value) return 'Récemment ajouté';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Récemment ajouté';
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  }).format(date);
}

export function formatCount(value) {
  if (!Number.isFinite(Number(value))) return null;
  return new Intl.NumberFormat('fr-FR').format(Number(value));
}

export function parentPath(path = '') {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

export function getBreadcrumbs(path = '') {
  const parts = path.split('/').filter(Boolean);
  return [
    { label: 'Bibliothèque', path: '' },
    ...parts.map((part, index) => ({
      label: part,
      path: parts.slice(0, index + 1).join('/'),
    })),
  ];
}

export function sortItems(items, sortBy = 'name') {
  return [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    if (sortBy === 'size') return (b.size || 0) - (a.size || 0);
    if (sortBy === 'date') {
      return new Date(b.mtime || 0).getTime() - new Date(a.mtime || 0).getTime();
    }
    return a.name.localeCompare(b.name, 'fr', { numeric: true, sensitivity: 'base' });
  });
}

export function normalizeSearch(value = '') {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr')
    .trim();
}

export function searchItems(items, query, limit = 40) {
  const normalizedQuery = normalizeSearch(query);
  if (!normalizedQuery) return [];

  return items
    .map(normalizeBucketItem)
    .map((item) => {
      const name = normalizeSearch(item.name);
      const path = normalizeSearch(item.path);
      let score = 0;
      if (name === normalizedQuery) score = 100;
      else if (name.startsWith(normalizedQuery)) score = 80;
      else if (name.includes(normalizedQuery)) score = 60;
      else if (path.includes(normalizedQuery)) score = 30;
      return { item, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, 'fr'))
    .slice(0, limit)
    .map(({ item }) => item);
}

export function isPreviewable(item) {
  return ['pdf', 'image', 'audio', 'video', 'text'].includes(item.kind);
}
