const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'html', 'htm',
  'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp',
  'sh', 'toml', 'ini', 'log', 'tex', 'rst',
]);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi']);
const OFFICE_EXTENSIONS = new Set([
  'doc', 'docx', 'docm', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'pptm',
  'odt', 'ods', 'odp', 'odb', 'one', 'onenote', 'url',
]);
const OFFICE_WEB_EXTENSIONS = new Set([
  'doc', 'docx', 'docm', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'pptm',
  'potx', 'ppsx', 'odt', 'ods', 'odp',
]);
/** Extensions rendues localement dans le navigateur (sans service externe). */
const OFFICE_LOCAL_DOC_EXTENSIONS = new Set(['docx', 'docm']);
const OFFICE_LOCAL_SHEET_EXTENSIONS = new Set(['xls', 'xlsx', 'xlsm']);
const OFFICE_LOCAL_SLIDES_EXTENSIONS = new Set(['pptx', 'pptm']);
/** Extensions convertibles en PDF par le Space LibreOffice (`/api/office/pdf`). */
const OFFICE_CONVERTIBLE_EXTENSIONS = new Set([
  'doc', 'docx', 'docm', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'pptm',
  'odt', 'ods', 'odp',
]);
const ONENOTE_EXTENSIONS = new Set(['one', 'onenote', 'url']);
const MODEL_EXTENSIONS = new Set([
  'dwg', 'dxf', 'dwf', 'rvt', 'rfa', 'nwc', 'nwd', 'nwf', 'ifc',
  'ipt', 'iam', 'sldprt', 'sldasm', 'stp', 'step', 'igs', 'iges',
  'obj', 'stl', 'sat', 'x_t', 'x_b', '3ds', 'fbx', 'dae', 'skp', 'max', 'ma', 'mb',
]);
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
  if (MODEL_EXTENSIONS.has(extension)) return 'model';
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
  return 'file';
}

export function isModelExtension(extension = '') {
  return MODEL_EXTENSIONS.has(String(extension).toLowerCase());
}

export function isOfficeExtension(extension = '') {
  return OFFICE_EXTENSIONS.has(String(extension).toLowerCase());
}

/** Extensions affichables par le viewer Office Web Apps (Microsoft). */
export function isOfficeWebViewerExtension(extension = '') {
  return OFFICE_WEB_EXTENSIONS.has(String(extension).toLowerCase());
}

/** Fichiers Microsoft OneNote / raccourcis OneNote (`.one`, `.url`). */
export function isOneNoteExtension(extension = '') {
  return ONENOTE_EXTENSIONS.has(String(extension).toLowerCase());
}

/**
 * Type de rendu local disponible pour une extension Office.
 *
 * Retourne `'docx'` (document), `'xlsx'` (classeur), `'pptx'` (texte des
 * diapos) ou `null` quand aucun rendu 100 % navigateur n’existe.
 */
export function officeLocalKind(extension = '') {
  const value = String(extension).toLowerCase();
  if (OFFICE_LOCAL_DOC_EXTENSIONS.has(value)) return 'docx';
  if (OFFICE_LOCAL_SHEET_EXTENSIONS.has(value)) return 'xlsx';
  if (OFFICE_LOCAL_SLIDES_EXTENSIONS.has(value)) return 'pptx';
  return null;
}

/** Extensions convertibles en PDF par le backend LibreOffice. */
export function isOfficeConvertibleExtension(extension = '') {
  return OFFICE_CONVERTIBLE_EXTENSIONS.has(String(extension).toLowerCase());
}

/** Extensions 3D convertibles en GLB par le Space FreeCAD. */
const MODEL_GLB_EXTENSIONS = new Set(['step', 'stp', 'iges', 'igs', 'stl', 'obj']);

/**
 * Type de rendu Web disponible pour un modèle 3D.
 * Retourne `'glb'` (conversion FreeCAD) ou `null` (Autodesk/téléchargement).
 */
export function modelViewerKind(extension = '') {
  return MODEL_GLB_EXTENSIONS.has(String(extension).toLowerCase()) ? 'glb' : null;
}

/** Formats visualisables via le plugin iframe gratuit ShareCAD (sans conversion). */
const SHARECAD_EXTENSIONS = new Set([
  'dwg', 'dxf', 'dwf', 'stp', 'step', 'igs', 'iges',
  'stl', 'sldprt', 'sat', 'x_t', 'x_b',
]);

export function isShareCadExtension(extension = '') {
  return SHARECAD_EXTENSIONS.has(String(extension).toLowerCase());
}

/**
 * Extrait l’adresse cible d’un raccourci Windows `.url` (bloc `[InternetShortcut]`).
 */
export function extractUrlFromShortcut(content = '') {
  return parseInternetShortcut(content).url;
}

/**
 * Parse un raccourci Windows `.url` (format INI, bloc `[InternetShortcut]`).
 * Seule la première valeur de chaque clé est conservée.
 */
export function parseInternetShortcut(content = '') {
  const result = {
    url: '',
    baseUrl: '',
    iconFile: '',
    iconIndex: '',
    hotkey: '',
    modified: '',
  };
  if (typeof content !== 'string') return result;

  let section = '';
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      continue;
    }
    if (section !== 'internetshortcut') continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'url' && !result.url) result.url = value;
    else if (key === 'baseurl' && !result.baseUrl) result.baseUrl = value;
    else if (key === 'iconfile' && !result.iconFile) result.iconFile = value;
    else if (key === 'iconindex' && !result.iconIndex) result.iconIndex = value;
    else if (key === 'hotkey' && !result.hotkey) result.hotkey = value;
    else if (key === 'modified' && !result.modified) result.modified = value;
  }
  return result;
}

/**
 * Qualifie la cible d’un raccourci pour l’affichage.
 * Retourne `{ kind, label }` avec kind parmi :
 * `onenote-web`, `onenote-app`, `web`, `file`, `unknown`, `empty`.
 */
export function describeShortcutTarget(url = '') {
  const value = String(url || '').trim();
  if (!value) return { kind: 'empty', label: 'Lien vide' };
  if (/^onenote:/i.test(value)) return { kind: 'onenote-app', label: 'Lien OneNote' };
  if (/^file:/i.test(value)) return { kind: 'file', label: 'Fichier local' };

  let hostname = '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { kind: 'unknown', label: 'Lien externe' };
    }
    hostname = parsed.hostname.toLowerCase();
  } catch {
    return { kind: 'unknown', label: 'Lien externe' };
  }

  if (/(^|\.)(onenote\.com|onenote\.officeapps\.live\.com|onedrive\.live\.com|sharepoint\.com)$/.test(hostname)) {
    return { kind: 'onenote-web', label: 'OneNote en ligne' };
  }
  return { kind: 'web', label: 'Page web' };
}

export function normalizeBucketItem(item) {
  const path = String(item.path || '');
  const type = item.type === 'directory' ? 'directory' : 'file';
  const count = Number(item.count);
  return {
    ...item,
    path,
    type,
    name: item.name || getName(path),
    size: Number(item.size) || 0,
    mtime: item.mtime || item.uploadedAt || item.uploaded_at || null,
    count: type === 'directory' && Number.isFinite(count) ? count : null,
    kind: getFileKind(path, type),
  };
}

/**
 * Compte les fichiers de chaque dossier à partir d’une liste récursive.
 * Utilisé pour l’index (côté Worker) et pour l’aperçu local hors ligne.
 */
export function countFilesByDirectory(items = [], prefix = '') {
  const base = String(prefix || '').replace(/^\/+|\/+$/g, '');
  const counts = {};
  let totalFiles = 0;

  for (const item of items) {
    if (!item || item.type === 'directory') continue;
    const path = String(item.path || '').replace(/^\/+/, '');
    if (!path) continue;
    if (base && path !== base && !path.startsWith(`${base}/`)) continue;
    totalFiles += 1;
    const parts = path.split('/').filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) {
      const dirPath = parts.slice(0, index).join('/');
      if (base && (dirPath === base || !dirPath.startsWith(`${base}/`))) continue;
      counts[dirPath] = (counts[dirPath] || 0) + 1;
    }
  }

  return { counts, totalFiles };
}

/** Applique les effectifs du JSON d’index aux dossiers d’une liste. */
export function applyFolderCounts(items = [], counts = {}) {
  if (!counts || typeof counts !== 'object') return items;
  return items.map((item) => {
    if (!item || item.type !== 'directory') return item;
    const value = Number(counts[item.path]);
    if (!Number.isFinite(value)) return item;
    if (item.count === value) return item;
    return { ...item, count: value };
  });
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

/**
 * Libellé d’effectif d’un dossier dans les listes.
 *
 * `item.count` vaut `null` tant que le JSON d’index n’a pas fourni d’effectif.
 * Il ne faut surtout pas passer par `Number(item.count)` : `Number(null)`
 * vaut `0` et l’interface afficherait « 0 ressource » pour tous les dossiers.
 */
export function formatFolderCount(item, indexing = false) {
  if (item && item.count !== null && item.count !== undefined) {
    const value = Number(item.count);
    if (Number.isFinite(value)) return `${formatCount(value)} ressource${value <= 1 ? '' : 's'}`;
  }
  return indexing ? 'Indexation…' : 'Nombre indisponible';
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
  return ['pdf', 'image', 'audio', 'video', 'text', 'office', 'model'].includes(item.kind);
}
