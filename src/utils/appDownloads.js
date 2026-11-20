/** Noms stables des fichiers publiés par le workflow Tauri dans GitHub Releases. */
export const DEFAULT_RELEASE_BASE_URL = 'https://github.com/tiffank1802/hf-file-viewer/releases/latest/download';
export const DEFAULT_RELEASE_PAGE_URL = 'https://github.com/tiffank1802/hf-file-viewer/releases';

export const APP_PLATFORMS = [
  {
    id: 'windows',
    label: 'Windows',
    shortLabel: 'Windows',
    subtitle: 'Windows 10 / 11 · 64 bits (x64)',
    primary: {
      fileName: 'ENISE-Docs-windows-x64-setup.exe',
      label: 'Télécharger pour Windows (.exe)',
      shortLabel: 'Installateur .exe',
    },
    secondary: {
      fileName: 'ENISE-Docs-windows-x64.msi',
      label: 'Autre format : .msi',
    },
    note: 'L’installateur n’est pas signé par un éditeur vérifié : Windows SmartScreen peut afficher un avertissement.',
  },
  {
    id: 'macos',
    label: 'macOS',
    shortLabel: 'macOS',
    subtitle: 'macOS 11+ · Apple Silicon et Intel',
    primary: {
      fileName: 'ENISE-Docs-macos-universal.dmg',
      label: 'Télécharger pour macOS (.dmg)',
      shortLabel: 'Image disque .dmg',
    },
    secondary: {
      fileName: 'ENISE-Docs-macos-universal.app.tar.gz',
      label: 'Autre format : archive .app',
    },
    note: 'Cette version n’est pas notariée par Apple : Gatekeeper peut bloquer son ouverture. Vérifiez la provenance et les empreintes avant installation.',
  },
  {
    id: 'android',
    label: 'Android',
    shortLabel: 'Android',
    subtitle: 'Android 7.0+ · APK universel',
    primary: {
      fileName: 'ENISE-Docs-android-universal.apk',
      label: 'Télécharger pour Android (.apk)',
      shortLabel: 'Fichier .apk',
    },
    secondary: null,
    note: 'L’APK est une version de test installée hors Play Store. Si la clé de signature change, une mise à jour pourra nécessiter une désinstallation préalable.',
  },
  {
    id: 'ios',
    label: 'iPhone et iPad',
    shortLabel: 'iOS',
    subtitle: 'iOS / iPadOS 14+ · version de test',
    primary: {
      fileName: 'ENISE-Docs-ios-unsigned.ipa',
      label: 'Télécharger pour iOS (.ipa non signé)',
      shortLabel: 'Fichier .ipa non signé',
    },
    secondary: {
      fileName: 'ENISE-Docs-ios-simulator-arm64.app.zip',
      label: 'Simulateur Xcode (Mac Apple Silicon)',
    },
    note: 'L’IPA ne s’installe pas directement sur un iPhone : il doit d’abord être signé avec un compte et un profil Apple compatibles. Il n’est pas distribué sur l’App Store.',
  },
];

function resolveHttpsUrl(value, fallback) {
  const candidate = String(value || '').trim().replace(/\/+$/, '');
  if (!candidate) return fallback;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return fallback;
    return parsed.href.replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

export function resolveReleaseBaseUrl(environment = import.meta.env) {
  return resolveHttpsUrl(environment?.VITE_APP_RELEASE_BASE_URL, DEFAULT_RELEASE_BASE_URL);
}

export function resolveReleasePageUrl(environment = import.meta.env) {
  return resolveHttpsUrl(environment?.VITE_APP_RELEASE_PAGE_URL, DEFAULT_RELEASE_PAGE_URL);
}

export function buildAppAssetUrl(fileName, environment = import.meta.env) {
  const cleanName = String(fileName || '').replace(/^\/+/, '');
  const base = resolveReleaseBaseUrl(environment);
  return cleanName ? `${base}/${encodeURIComponent(cleanName)}` : base;
}

/** La détection est une suggestion : les autres plateformes restent accessibles. */
export function detectClientPlatform(nav = typeof navigator !== 'undefined' ? navigator : null) {
  const ua = String(nav?.userAgent || '');
  const platform = String(nav?.platform || '');
  const touchPoints = Number(nav?.maxTouchPoints || 0);

  if (/android/i.test(ua)) return { id: 'android', detected: true };
  // Safari sur iPad peut annoncer « Macintosh » plutôt que « iPad ».
  if (/iphone|ipad|ipod/i.test(ua) || (/macintel/i.test(platform) && touchPoints > 1)) {
    return { id: 'ios', detected: true };
  }
  if (/macintosh|mac os x|macppc|macintel/i.test(ua) || /^mac/i.test(platform)) {
    return { id: 'macos', detected: true };
  }
  if (/win32|win64|windows|wow64/i.test(ua) || /^win/i.test(platform)) {
    return { id: 'windows', detected: true };
  }
  return { id: null, detected: false };
}

export function getPlatformById(id) {
  return APP_PLATFORMS.find((item) => item.id === id) || APP_PLATFORMS[0];
}
