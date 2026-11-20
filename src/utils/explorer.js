import { getExtension } from './files.js';

export const VIEW_MODES = ['grid', 'list', 'columns', 'gallery'];
export const SORT_LABELS = { name: 'Nom', date: 'Modification', kind: 'Type', size: 'Taille' };
export const SORT_FIELDS = ['name', 'date', 'kind', 'size'];
export const ICON_SIZES = ['small', 'medium', 'large'];
export const GROUP_MODES = ['none', 'kind', 'date', 'tag'];
export const GRID_SPACING = ['compact', 'normal', 'wide'];
export const TEXT_SIZES = ['small', 'normal', 'large'];
export const BACKGROUNDS = ['white', 'blue', 'gray'];
export const LIST_COLUMNS = ['date', 'kind', 'size'];
export const FOLDER_PRESENTATION_KEYS = [
  'view', 'sort', 'direction', 'group', 'iconSize', 'gridSpacing', 'labelPosition', 'textSize',
  'background', 'showItemInfo', 'showIconPreview', 'listColumns', 'foldersFirst', 'showTags',
  'columnWidth', 'galleryThumbSize', 'showFilmstrip',
];
export const DEFAULT_PREFERENCES = {
  view: 'grid', sort: 'name', direction: 'asc', iconSize: 'medium', group: 'none',
  gridSpacing: 'normal', labelPosition: 'below', textSize: 'normal', background: 'white',
  showItemInfo: false, showIconPreview: false, listColumns: LIST_COLUMNS, foldersFirst: true, showTags: true,
  columnWidth: 'normal', galleryThumbSize: 'medium', showFilmstrip: true, showExtensions: true,
  showPath: true, showStatus: true, showSidebar: true, showTabs: true, showPreview: false, showPreviewDetails: true,
};
const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
const IMAGE_PREVIEW_LIMIT = 5 * 1024 * 1024;

export function explorerPreferences(value) {
  return {
    view: VIEW_MODES.includes(value?.view) ? value.view : DEFAULT_PREFERENCES.view,
    sort: SORT_FIELDS.includes(value?.sort) ? value.sort : DEFAULT_PREFERENCES.sort,
    direction: value?.direction === 'desc' ? 'desc' : 'asc',
    iconSize: ICON_SIZES.includes(value?.iconSize) ? value.iconSize : DEFAULT_PREFERENCES.iconSize,
    group: GROUP_MODES.includes(value?.group) ? value.group : 'none',
    gridSpacing: GRID_SPACING.includes(value?.gridSpacing) ? value.gridSpacing : 'normal',
    labelPosition: value?.labelPosition === 'right' ? 'right' : 'below',
    textSize: TEXT_SIZES.includes(value?.textSize) ? value.textSize : 'normal',
    background: BACKGROUNDS.includes(value?.background) ? value.background : 'white',
    showItemInfo: value?.showItemInfo === true,
    showIconPreview: value?.showIconPreview === true,
    listColumns: !Array.isArray(value?.listColumns) ? LIST_COLUMNS : LIST_COLUMNS.filter((key) => value.listColumns.includes(key)),
    foldersFirst: value?.foldersFirst !== false,
    showTags: value?.showTags !== false,
    columnWidth: GRID_SPACING.includes(value?.columnWidth) ? value.columnWidth : 'normal',
    galleryThumbSize: ICON_SIZES.includes(value?.galleryThumbSize) ? value.galleryThumbSize : 'medium',
    showFilmstrip: value?.showFilmstrip !== false,
    showExtensions: value?.showExtensions !== false,
    showPath: value?.showPath !== false,
    showStatus: value?.showStatus !== false,
    showSidebar: value?.showSidebar !== false,
    showTabs: value?.showTabs !== false,
    showPreview: value?.showPreview === true,
    showPreviewDetails: value?.showPreviewDetails !== false,
  };
}

export function folderPresentation(value) {
  const validated = explorerPreferences(value);
  return Object.fromEntries(FOLDER_PRESENTATION_KEYS.map((key) => [key, validated[key]]));
}

export function changeExplorerSort(preferences, sort) {
  return {
    ...preferences,
    sort,
    direction: preferences.sort === sort
      ? (preferences.direction === 'asc' ? 'desc' : 'asc')
      : (sort === 'date' || sort === 'size' ? 'desc' : 'asc'),
  };
}

function compareNumbers(a, b, direction) {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return (a - b) * direction;
}

export function sortExplorerItems(items, { sort, direction, foldersFirst = true }) {
  const order = direction === 'desc' ? -1 : 1;
  const numeric = (value) => Number.isFinite(value) && value > 0 ? value : null;
  const date = (value) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  return [...items].sort((a, b) => {
    if (foldersFirst && a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    const names = collator.compare(a.name, b.name);
    let diff = 0;
    if (sort === 'name') diff = names * order;
    if (sort === 'kind') diff = collator.compare(getExtension(a.path), getExtension(b.path)) * order;
    if (sort === 'date') diff = compareNumbers(date(a.mtime), date(b.mtime), order);
    if (sort === 'size') diff = compareNumbers(numeric(a.size), numeric(b.size), order);
    return diff || names || collator.compare(a.path, b.path) || (a.path < b.path ? -1 : Number(a.path !== b.path));
  });
}

export function selectExplorerItem(selection, paths, path, { extend = false, toggle = false } = {}) {
  if (extend) {
    const anchorIndex = paths.indexOf(selection.anchor);
    const index = paths.indexOf(path);
    if (anchorIndex >= 0 && index >= 0) {
      const range = paths.slice(Math.min(index, anchorIndex), Math.max(index, anchorIndex) + 1);
      return { paths: new Set(toggle ? [...selection.paths, ...range] : range), anchor: selection.anchor, current: path };
    }
  }
  const next = new Set(toggle ? selection.paths : []);
  if (toggle && next.has(path)) next.delete(path);
  else next.add(path);
  return { paths: next, anchor: path, current: path };
}

export function displayExplorerName(item, showExtensions = true) {
  const index = item.name.lastIndexOf('.');
  return showExtensions || item.type === 'directory' || index <= 0 || index === item.name.length - 1
    ? item.name : item.name.slice(0, index);
}

export function itemType(item) {
  return item.type === 'directory' ? 'Dossier' : getExtension(item.path).toUpperCase() || 'Fichier';
}

export function canPreviewInGallery(item) {
  return item?.kind === 'image' && item.size > 0 && item.size <= IMAGE_PREVIEW_LIMIT && getExtension(item.path) !== 'svg';
}

export function canPreviewIcon(item) {
  return canPreviewInGallery(item) && item.size <= 256 * 1024;
}

export function inExplorerScope(itemPath, folder) {
  return !folder || (itemPath !== folder && itemPath.startsWith(`${folder}/`));
}
