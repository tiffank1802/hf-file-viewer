import { normalizeBucketItem } from '../utils/files.js';

export function readerFileFromRoute(pathname, search = '') {
  if (pathname !== '/read') return null;
  const params = new URLSearchParams(search);
  const path = String(params.get('path') || '').trim();
  if (!path || path.includes('..')) return null;
  const file = normalizeBucketItem({
    type: 'file',
    path,
    previewPage: positiveInteger(params.get('page')) || 1,
  });
  return file.kind === 'pdf' ? file : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}
