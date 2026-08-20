export function pathFromHash(hash = window.location.hash) {
  if (!hash || hash === '#' || hash === '#/') return '';
  // Les ancres d’accessibilité (#main-content, #about) ne sont pas des routes.
  if (!hash.startsWith('#/')) return null;
  const raw = hash.slice(2);
  try {
    return decodeURIComponent(raw).replace(/^\/+|\/+$/g, '');
  } catch {
    return raw.replace(/^\/+|\/+$/g, '');
  }
}

export function hashFromPath(path = '') {
  if (!path) return '#/';
  return `#/${path.split('/').map(encodeURIComponent).join('/')}`;
}
