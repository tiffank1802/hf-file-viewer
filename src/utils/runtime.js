/**
 * Couche d’exécution hybride Web (Cloudflare Workers / Vite) & Tauri v2
 * (macOS, iOS, Android, Windows).
 *
 * Sur le Web standard, toutes les routes restent relatives (`/api/...`) sur la
 * même origine. Dans Tauri, les appels `/api/...` passent par le protocole
 * asynchrone Rust `eniseapi` (qui gère le cache de session `enise_session` et
 * contourne les restrictions CORS / ITP de WKWebView), tandis que les flux
 * médias directs et visionneuses tierces utilisent l’origine HTTPS publique.
 */

export const DEFAULT_PUBLIC_API_ORIGIN = 'https://enise-docs-api-mb66o5jbpa-ew.a.run.app';
export const TAURI_API_SCHEME = 'eniseapi';

export function normalizeOrigin(raw) {
  const trimmed = String(raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function defaultWindow() {
  return typeof window !== 'undefined' ? window : globalThis;
}

export function isTauriRuntime(win = defaultWindow()) {
  return Boolean(win && (win.isTauri || win.__TAURI_INTERNALS__));
}

export function isAndroidRuntime(nav = defaultWindow()?.navigator) {
  return Boolean(nav && /android/i.test(String(nav.userAgent || '')));
}

export function configuredApiOrigin(environment = import.meta.env) {
  return normalizeOrigin(environment?.VITE_API_ORIGIN);
}

export function tauriSchemeOrigin(win = defaultWindow()) {
  const converter = win?.__TAURI_INTERNALS__?.convertFileSrc;
  if (typeof converter === 'function') {
    try {
      const converted = String(converter('', TAURI_API_SCHEME) || '').replace(/\/+$/, '');
      if (converted) return converted;
    } catch {
      // Repli déterministe selon le moteur WebView.
    }
  }
  const protocol = String(win?.location?.protocol || '');
  const ua = String(win?.navigator?.userAgent || '');
  if (protocol === 'http:' || protocol === 'https:' || /windows|android/i.test(ua)) {
    return `http://${TAURI_API_SCHEME}.localhost`;
  }
  return `${TAURI_API_SCHEME}://localhost`;
}

function ensureLeadingSlash(path) {
  const value = String(path || '');
  if (!value) return '/';
  return value.startsWith('/') ? value : `/${value}`;
}

/**
 * Construit l’URL d’un endpoint `/api/...` pour `fetch`, `<img>` ou `pdf.js`.
 */
export function apiUrl(path, options = {}) {
  const win = options.win ?? defaultWindow();
  const environment = options.env ?? import.meta.env;
  const normalizedPath = ensureLeadingSlash(path);
  const explicitOrigin = configuredApiOrigin(environment);
  const directHttp = String(environment?.VITE_TAURI_DIRECT_HTTP || '') === '1';

  if (isTauriRuntime(win)) {
    if (explicitOrigin && directHttp) {
      return `${explicitOrigin}${normalizedPath}`;
    }
    return `${tauriSchemeOrigin(win)}${normalizedPath}`;
  }

  if (explicitOrigin) {
    return `${explicitOrigin}${normalizedPath}`;
  }

  return normalizedPath;
}

/**
 * Origine HTTPS publique du service documentaire (nécessaire aux services
 * externes comme Microsoft Office Web Viewer / ShareCAD et aux médias directs).
 */
export function publicApiOrigin(options = {}) {
  const win = options.win ?? defaultWindow();
  const environment = options.env ?? import.meta.env;
  const explicitOrigin = configuredApiOrigin(environment);
  if (explicitOrigin) return explicitOrigin;

  if (isTauriRuntime(win)) {
    return DEFAULT_PUBLIC_API_ORIGIN;
  }

  const locOrigin = String(win?.location?.origin || '');
  if (/^https?:\/\//i.test(locOrigin)) {
    return locOrigin.replace(/\/+$/, '');
  }

  return DEFAULT_PUBLIC_API_ORIGIN;
}

/**
 * URL publique ou relative selon le contexte :
 * - `relativeOnWeb: true` garde `/api/...` sur le Web mais bascule vers
 *   l’origine HTTPS publique dans Tauri (ex: `<video>`, `<audio>`, téléchargement).
 * - `relativeOnWeb: false` (défaut) renvoie toujours une URL absolue HTTPS
 *   (ex: iframe Microsoft Office Web Viewer ou ShareCAD).
 */
export function publicApiUrl(path, options = {}) {
  const win = options.win ?? defaultWindow();
  const environment = options.env ?? import.meta.env;
  const normalizedPath = ensureLeadingSlash(path);
  const explicitOrigin = configuredApiOrigin(environment);

  if (options.relativeOnWeb && !isTauriRuntime(win) && !explicitOrigin) {
    return normalizedPath;
  }

  return `${publicApiOrigin({ win, env: environment })}${normalizedPath}`;
}

export function apiCredentials(options = {}) {
  const win = options.win ?? defaultWindow();
  const environment = options.env ?? import.meta.env;
  if (isTauriRuntime(win)) {
    // La session `enise_session` est injectée côté Rust par `eniseapi`.
    return 'omit';
  }
  if (configuredApiOrigin(environment)) {
    return 'include';
  }
  return 'same-origin';
}

/**
 * Ouvre une URL externe dans le navigateur système sous Tauri (macOS, iOS,
 * Android, Windows) ou dans un nouvel onglet sur le Web.
 */
export async function openExternalUrl(url) {
  const target = String(url || '').trim();
  if (!target) return false;

  if (isTauriRuntime()) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(target);
      return true;
    } catch {
      // Repli vers window.open si le plugin n’est pas disponible.
    }
  }

  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(target, '_blank', 'noopener,noreferrer');
    return true;
  }
  return false;
}
