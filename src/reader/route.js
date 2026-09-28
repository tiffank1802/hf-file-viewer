import { getExtension, normalizeBucketItem } from '../utils/files.js';

const STRUCTURED_READER_EXTENSIONS = new Set([
  'pdf',
  'docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp',
  'html', 'htm', 'md', 'txt', 'csv', 'adoc', 'asciidoc', 'tex',
  'epub', 'eml', 'msg', 'vtt',
  'png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp', 'bmp',
]);

export function canOpenStructuredReader(path = '') {
  return STRUCTURED_READER_EXTENSIONS.has(getExtension(path));
}

export function readerFileFromRoute(pathname, search = '') {
  if (pathname !== '/read') return null;
  const params = new URLSearchParams(search);
  const path = String(params.get('path') || '').trim();
  if (!path || path.includes('..') || !canOpenStructuredReader(path)) return null;
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
