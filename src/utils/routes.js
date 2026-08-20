export function pathFromHash(hash = typeof window === 'undefined' ? '' : window.location.hash) {
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

export function hrefFromLibraryPath(path = '') {
  const normalized = String(path || '').replace(/^\/+|\/+$/g, '');
  if (!normalized) return '/';
  return `/bibliotheque/${normalized.split('/').map(encodeURIComponent).join('/')}`;
}

export function pathFromPathname(pathname = '/') {
  if (!pathname || pathname === '/') return '';
  if (!pathname.startsWith('/bibliotheque')) return null;
  const rest = pathname.replace(/^\/bibliotheque\/?/, '');
  try {
    return decodeURIComponent(rest).replace(/^\/+|\/+$/g, '');
  } catch {
    return rest.replace(/^\/+|\/+$/g, '');
  }
}

export function pathFromLocation(location = window.location) {
  const fromPath = pathFromPathname(location.pathname || '/');
  if (fromPath !== null && (fromPath !== '' || (location.pathname || '').startsWith('/bibliotheque') || location.pathname === '/')) {
    if (fromPath) return fromPath;
  }
  if (location.pathname === '/' || location.pathname === '') {
    const fromHash = pathFromHash(location.hash);
    return fromHash ?? '';
  }
  if (fromPath !== null) return fromPath;
  const fromHash = pathFromHash(location.hash);
  return fromHash ?? '';
}
