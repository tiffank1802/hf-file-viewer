import { getExtension, normalizeBucketItem } from '../utils/files.js';

const STRUCTURED_READER_EXTENSIONS = new Set([
  'pdf',
  'docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp',
  'html', 'htm', 'md', 'txt', 'csv', 'adoc', 'asciidoc', 'tex',
  'epub', 'eml', 'msg', 'vtt',
  'png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp', 'bmp',
]);

/**
 * Modes de déploiement : off, pilot (allowlist exacte), pdf, all.
 * `all` reste la valeur par défaut afin de ne pas casser les liens existants.
 */
export function readerRolloutConfig(environment = import.meta.env) {
  const mode = String(environment?.VITE_READER_ROLLOUT || 'all').trim().toLowerCase();
  const pilotPaths = String(environment?.VITE_READER_PILOT_PATHS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    mode: ['off', 'pilot', 'pdf', 'all'].includes(mode) ? mode : 'all',
    pilotPaths,
  };
}

export function canOpenStructuredReader(path = '', rollout = readerRolloutConfig()) {
  const extension = getExtension(path);
  if (!STRUCTURED_READER_EXTENSIONS.has(extension)) return false;
  if (rollout.mode === 'off') return false;
  if (rollout.mode === 'pdf') return extension === 'pdf';
  if (rollout.mode === 'pilot') return rollout.pilotPaths.includes(String(path).trim());
  return true;
}

export function readerFileFromRoute(pathname, search = '', rollout = readerRolloutConfig()) {
  if (pathname !== '/read') return null;
  const params = new URLSearchParams(search);
  const path = String(params.get('path') || '').trim();
  if (!path || path.includes('..') || !canOpenStructuredReader(path, rollout)) return null;
  return normalizeBucketItem({
    type: 'file',
    path,
    previewPage: positiveInteger(params.get('page')) || 1,
  });
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}
