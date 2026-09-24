import {
  FEATURED_SPACES,
  LIBRARY_ROOT_CARD,
  NEW_SPACE_WINDOW_DAYS,
  SPACE_TONES,
} from '../config.js';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Noms « lisibles » des dossiers conteneurs du bucket. */
const FOLDER_LABELS = {
  GM: 'Génie mécanique',
  TOEIC: 'Préparation TOEIC',
};

/** Normalise un chemin de dossier comme le reste de l’application. */
export function normalizeSpacePath(path = '') {
  return String(path || '').replace(/^\/+|\/+$/g, '');
}

function segmentsOf(path = '') {
  return normalizeSpacePath(path).split('/').filter(Boolean);
}

/**
 * Tous les dossiers présents dans l’index.
 *
 * L’index récursif mélange dossiers et fichiers : un dossier est connu dès
 * qu’il est listé explicitement ou qu’il contient au moins un fichier.
 */
export function indexedDirectories(items = []) {
  const directories = new Set();
  for (const item of items) {
    const path = normalizeSpacePath(item?.path);
    if (!path) continue;
    const parts = path.split('/').filter(Boolean);
    const depth = item.type === 'directory' ? parts.length : parts.length - 1;
    for (let index = 1; index <= depth; index += 1) {
      directories.add(parts.slice(0, index).join('/'));
    }
  }
  return directories;
}

/** Vrai si le dossier existe encore dans l’index. */
export function hasDirectory(items = [], path = '') {
  const base = normalizeSpacePath(path);
  if (!base) return true;
  return items.some((item) => {
    const candidate = normalizeSpacePath(item?.path);
    if (!candidate) return false;
    if (item?.type === 'directory') return candidate === base;
    return candidate.startsWith(`${base}/`);
  });
}

/**
 * Horodatage du dernier fichier ajouté sous un dossier (`null` si l’index ne
 * fournit aucune date).
 */
export function latestActivity(items = [], path = '') {
  const base = normalizeSpacePath(path);
  let latest = null;
  for (const item of items) {
    if (!item || item.type === 'directory') continue;
    const candidate = normalizeSpacePath(item.path);
    if (!candidate) continue;
    if (base && !candidate.startsWith(`${base}/`)) continue;
    const time = Date.parse(item.mtime ?? item.uploadedAt ?? '');
    if (!Number.isFinite(time)) continue;
    if (latest === null || time > latest) latest = time;
  }
  return latest;
}

/** Vrai si le dossier a reçu du contenu récemment (badge « Nouveau »). */
export function isRecentActivity(time, now = Date.now(), windowDays = NEW_SPACE_WINDOW_DAYS) {
  if (!Number.isFinite(time)) return false;
  return Math.abs(now - time) < windowDays * DAY_MS;
}

/** Titre lisible pour un dossier découvert dans le bucket. */
export function titleFromPath(path = '') {
  const name = segmentsOf(path).pop() || '';
  const words = name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return 'Dossier';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Libellé du dossier parent, utilisé en description des cartes dynamiques. */
export function parentLabel(path = '') {
  const parts = segmentsOf(path);
  if (parts.length < 2) return 'la racine du bucket';
  const parent = parts.slice(0, -1).join('/');
  return FOLDER_LABELS[parent] || titleFromPath(parent);
}

function describeDynamicSpace(path, recent) {
  if (segmentsOf(path).length > 1) return `Dans ${parentLabel(path)}`;
  return recent ? 'Ajouté récemment' : 'Dossier de la bibliothèque';
}

/** Nombre fini ou `null` : l’index renvoie parfois des effectifs absents. */
function finiteCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function countFor(catalog, path) {
  return finiteCount(catalog?.counts?.[normalizeSpacePath(path)]);
}

function curatedSpace(space, catalog) {
  const path = normalizeSpacePath(space.path);
  return {
    ...space,
    path,
    count: countFor(catalog, path),
    dynamic: false,
    badge: null,
    updatedAt: null,
  };
}

/**
 * Dossiers à mettre en avant en plus des espaces connus.
 *
 * Règles, dans l’ordre :
 * 1. un dossier de la racine absent des espaces connus reçoit une carte ;
 * 2. un dossier conteneur (comme `GM`, qui regroupe 3A / 4A / 5A) n’en reçoit
 *    pas : ses sous-dossiers prennent la place, ce qui fait apparaître par
 *    exemple `GM/Stages` sans attendre une modification du code.
 */
export function dynamicSpacePaths(directories = new Set(), knownPaths = []) {
  const known = new Set(knownPaths.map(normalizeSpacePath));
  const all = [...directories];
  const paths = [];

  for (const root of all.filter((path) => segmentsOf(path).length === 1)) {
    if (known.has(root)) continue;
    const containsKnown = [...known].some((path) => path.startsWith(`${root}/`));
    if (!containsKnown) {
      paths.push(root);
      continue;
    }
    const children = all.filter(
      (path) => segmentsOf(path).length === 2 && path.startsWith(`${root}/`) && !known.has(path),
    );
    paths.push(...children);
  }

  return paths;
}

function dynamicSpace(path, items, catalog, now) {
  const updatedAt = latestActivity(items, path);
  const recent = isRecentActivity(updatedAt, now);
  return {
    path,
    title: titleFromPath(path),
    shortTitle: titleFromPath(path),
    description: describeDynamicSpace(path, recent),
    tone: SPACE_TONES[0],
    icon: 'folder',
    count: countFor(catalog, path),
    dynamic: true,
    badge: recent ? 'Nouveau' : null,
    updatedAt,
  };
}

function byActivity(a, b) {
  const left = Number.isFinite(a.updatedAt) ? a.updatedAt : -Infinity;
  const right = Number.isFinite(b.updatedAt) ? b.updatedAt : -Infinity;
  if (left !== right) return right - left;
  return a.title.localeCompare(b.title, 'fr');
}

/**
 * Construit les cartes d’espaces à partir de l’index du bucket.
 *
 * - les espaces connus ne s’affichent que s’ils existent toujours ;
 * - tout autre dossier (racine, ou sous-dossier d’un conteneur) est ajouté,
 *   trié du plus récemment modifié au plus ancien ;
 * - si l’index n’a pas répondu (chargement, panne), les espaces connus
 *   restent affichés comme avant.
 */
export function buildSpaces(catalog, options = {}) {
  const items = Array.isArray(catalog?.items) ? catalog.items : [];
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  if (items.length === 0) {
    return FEATURED_SPACES.map((space) => curatedSpace(space, catalog));
  }

  const knownPaths = FEATURED_SPACES.map((space) => normalizeSpacePath(space.path));
  const directories = indexedDirectories(items);

  const curated = FEATURED_SPACES.filter((space) =>
    directories.has(normalizeSpacePath(space.path)),
  ).map((space) => curatedSpace(space, catalog));

  const dynamic = dynamicSpacePaths(directories, knownPaths)
    .map((path) => dynamicSpace(path, items, catalog, now))
    .sort(byActivity)
    .map((space, index) => ({ ...space, tone: SPACE_TONES[index % SPACE_TONES.length] }));

  return [...curated, ...dynamic];
}

/** Carte qui ouvre la racine du bucket (toujours disponible). */
export function buildLibraryCard(catalog) {
  return {
    ...LIBRARY_ROOT_CARD,
    path: '',
    count: finiteCount(catalog?.totalFiles),
    dynamic: false,
    badge: null,
    updatedAt: null,
  };
}

/** Cartes de l’accueil : espaces réels + accès à toute la bibliothèque. */
export function buildHomeCards(catalog, options = {}) {
  const spaces = buildSpaces(catalog, options);
  return { spaces, cards: [...spaces, buildLibraryCard(catalog)] };
}
