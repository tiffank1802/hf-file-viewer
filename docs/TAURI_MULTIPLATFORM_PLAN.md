# Plan d’intégration et de compilation Tauri v2 (macOS, iOS, Android, Windows)

Ce document décrit l’architecture retenue et mise en place pour transformer **ENISE Docs** en application native multi-plateforme (**macOS**, **iOS**, **Android** et **Windows**) avec **Tauri v2**, tout en conservant **100 % de compatibilité** avec le déploiement Web existant sur **Cloudflare Workers + Cloud Run Go**.

---

## 1. Choix de Tauri v2 et objectifs

- **Framework unique Desktop + Mobile** : **Tauri v2** (`tauri = "2"`, `@tauri-apps/cli@^2`) est la seule branche de Tauri prenant en charge simultanément les cibles bureau (**macOS**, **Windows**, Linux) et mobiles (**iOS**, **Android**) à partir d’une même base Rust (`src-tauri/src/lib.rs` compilée en `rlib`, `staticlib` pour iOS et `cdylib` JNI pour Android).
- **Empreinte légère** : utilisation des moteurs WebView système natifs (`WKWebView` sur macOS et iOS, `WebView2` Chromium Evergreen sur Windows, `Android System WebView` sur Android) au lieu d’embarquer Chromium (~10–25 Mo au lieu de >150 Mo avec Electron).
- **Zéro régression Web** : en dehors de Tauri (`isTauriRuntime() === false`), toutes les routes restent relatives (`/api/...`) et identiques au fonctionnement historique sur Cloudflare Workers.

---

## 2. Défis techniques propres à ENISE Docs et solutions implémentées

Sur le Web, le frontend React et le Worker Cloudflare partagent la **même origine** (`https://...`), ce qui évite tout problème CORS ou cookie tiers. Dans Tauri v2, l’interface tourne sur une origine locale propre à la WebView :

- **macOS & iOS** (`WKWebView`) : `tauri://localhost`
- **Windows & Android** (`WebView2` / `Android WebView`) : `http://tauri.localhost`

Cinq problèmes concrets apparaîtraient avec un simple encapsulage naïf ; chacun est résolu par l’architecture mise en place :

### 2.1 Passerelle Rust asynchrone `eniseapi` (zéro CORS, zéro socket TCP)
- `src-tauri/src/lib.rs` enregistre le protocole asynchrone `eniseapi` via `Builder::register_asynchronous_uri_scheme_protocol("eniseapi", ...)`.
- Côté frontend (`src/utils/runtime.js`), `apiUrl('/api/...')` cible automatiquement :
  - `eniseapi://localhost/api/...` sur **macOS** et **iOS** ;
  - `http://eniseapi.localhost/api/...` sur **Windows** et **Android** ;
  - `/api/...` sur le **Web**.
- Le client HTTP Rust (`reqwest 0.12` compilé avec **`rustls-tls`** pur Rust — aucune dépendance OpenSSL native, ce qui garantit une cross-compilation NDK Android fiable sur les 4 ABI) relaie uniquement `/api/*` vers l’origine distante configurée (`ENISE_API_ORIGIN`, par défaut `https://enise-docs-api-mb66o5jbpa-ew.a.run.app`).
- Les requêtes `Range` (`pdf.js` par blocs de 256 Kio) et les en-têtes `Content-Range`, `Accept-Ranges`, `X-Cache-Status` et `X-Model3D-Meta` sont intégralement transmis.

### 2.2 Authentification étudiante persistante malgré l’ITP de `WKWebView` (iOS / macOS)
- Sur iOS et macOS, `WKWebView` bloque strictement les cookies cross-site (`SameSite=Lax` / ITP), ce qui casserait la connexion étudiante (`enise_session`), les favoris synchronisés et les annotations privées.
- La passerelle Rust intercepte `Set-Cookie: enise_session=...` au retour de `/api/auth/*`, stocke le jeton dans `app_data_dir()/enise-runtime.json` (permissions `0600` sous Unix) et réinjecte `Cookie: enise_session=...` sur les requêtes suivantes, y compris après redémarrage de l’application sur iPhone, Android, Mac ou PC.

### 2.3 Streaming SSE temps réel de l’Assistant IA (`/api/chat`)
- Les gestionnaires de schéma URI WebView renvoyant une réponse complète en fin de lecture, le flux `text/event-stream` de `/api/chat` utilise une commande IPC dédiée `tauri_chat_stream` (`tauri::ipc::Channel`) couplée à `tauri_chat_cancel` (`AbortController`).
- Le découpage UTF-8 multi-octets est tamponné côté Rust afin qu’aucun caractère accentué français (`é`, `è`, `à`, `’`) scindé entre deux paquets TCP ne soit altéré.

### 2.4 Visionneuses externes, médias lourds et PDF sur Android
- **Microsoft Office Web Viewer** (`view.officeapps.live.com`) et **ShareCAD** (`iframe.sharecad.org`) téléchargent les documents depuis leurs propres serveurs : `publicApiUrl()` leur fournit toujours une URL HTTPS publique valide au lieu de `tauri://localhost`.
- **Audio & Vidéo** (`<video>`, `<audio>`) : `mediaFileUrl()` pointe vers l’URL HTTPS publique pour bénéficier du décodage matériel et du streaming `Range` natif sans tampon mémoire de 64 Mio.
- **Aperçu PDF sur Android** : `Android System WebView` ne possédant pas de lecteur PDF natif dans `<iframe>`, `PreviewModal.jsx` bascule automatiquement sur le lecteur `PdfReader` (`pdfjs-dist`) déjà intégré au projet.
- **Liens externes & téléchargements** : `src/main.jsx` intercepte `<a target="_blank">` et `<a download>` sous Tauri pour les ouvrir proprement via `@tauri-apps/plugin-opener`.
- **Safe areas mobiles & Analytics** : prise en charge de `env(safe-area-inset-top)` dans `src/index.css` (encoche / Dynamic Island iOS, barre d’état Android) et désactivation automatique du script Cloudflare Web Analytics sous Tauri (`CloudflareAnalytics.jsx`).
- **CORS côté serveur** : `worker/index.js` et `backend/internal/api/server.go` autorisent également explicitement les origines `tauri://localhost`, `http://tauri.localhost` et `https://tauri.localhost`.

---

## 3. Matrice des 4 plateformes compilées

| Plateforme | Environnement de compilation | Cibles / Architectures | Artefacts produits |
|---|---|---|---|
| **macOS** | macOS (`macos-latest` + Xcode) | Universal Binary (`universal-apple-darwin` : Apple Silicon `arm64` + Intel `x86_64`), macOS 11.0+ | `ENISE Docs_1.0.0_universal.dmg`, `ENISE-Docs-macos-universal.app.tar.gz` |
| **iOS** | macOS (`macos-latest` + Xcode + XcodeGen) | `aarch64-apple-ios` (iPhone / iPad, iOS 14.0+) + `iphonesimulator` (`arm64`) | `ENISE-Docs-ios-unsigned.ipa` (ou signé si secrets Apple présents), `ENISE-Docs-ios-simulator-arm64.app.zip` |
| **Android** | Linux (`ubuntu-latest` + JDK 17 + SDK 35 + NDK 27) | `aarch64` (`arm64-v8a`), `armv7` (`armeabi-v7a`), `x86_64`, `i686` (`minSdkVersion` 24 / Android 7.0+) | `ENISE-Docs-android-universal.apk` (aligné & signé, prêt à installer), `ENISE-Docs-android-universal.aab` (Google Play) |
| **Windows** | Windows (`windows-latest` + MSVC + WiX + NSIS) | `x86_64-pc-windows-msvc` (installateur en français + bootstrapper WebView2 auto) | `ENISE Docs_1.0.0_x64-setup.exe` (NSIS), `ENISE Docs_1.0.0_x64_fr-FR.msi` (WiX) |

> **Pourquoi un pipeline CI multi-OS est indispensable :** Apple impose contractuellement et techniquement **macOS + Xcode** pour compiler les cibles **macOS** (`.dmg`) et **iOS** (`.ipa` / `WKWebView` / SDK iPhoneOS). Le workflow [`.github/workflows/tauri-build.yml`](../.github/workflows/tauri-build.yml) orchestre en parallèle les 3 runners natifs (`macos-latest`, `ubuntu-latest`, `windows-latest`) et publie les installateurs prêts à télécharger.

---

## 4. Arborescence ajoutée / modifiée

```text
├── .github/workflows/tauri-build.yml   # Pipeline CI parallèle macOS + iOS + Android + Windows
├── docs/TAURI_MULTIPLATFORM_PLAN.md    # Ce document d’architecture et de compilation
├── src/utils/runtime.js                # Résolution hybride d’URL (Web vs eniseapi:// / HTTPS public)
├── src-tauri/
│   ├── Cargo.toml                      # Crate Rust (staticlib + cdylib + rlib, reqwest rustls-tls)
│   ├── build.rs                        # Hook tauri-build v2
│   ├── tauri.conf.json                 # Config Tauri v2, CSP, bundles macOS/iOS/Android/Windows
│   ├── capabilities/default.json       # Permissions Tauri v2 (core:default, opener:default)
│   ├── icons/                          # Icônes générées (.icns, .ico, AppIcon iOS, mipmap Android)
│   └── src/
│       ├── main.rs                     # Point d’entrée binaire Desktop (macOS / Windows / Linux)
│       └── lib.rs                      # Point d’entrée partagé Mobile+Desktop, passerelle eniseapi & SSE
└── tests/tauri-runtime.test.js         # Tests unitaires de routage Tauri et CORS Worker
```

---

## 5. Commandes de développement et de compilation locale

### Prérequis communs
- **Node.js** ≥ 20.19 et `npm install`
- **Rust stable** via [rustup.rs](https://rustup.rs/)

### Commandes npm disponibles

```bash
# Régénérer toutes les icônes (macOS .icns, Windows .ico, iOS AppIcon, Android mipmap)
npm run tauri:icons

# Lancer en mode développement Desktop (démarre Go/Vite + fenêtre Tauri)
npm run tauri:dev

# Compiler pour macOS (Universal Binary Apple Silicon + Intel, depuis un Mac)
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri:build:macos

# Compiler pour Windows (NSIS .exe + WiX .msi, depuis Windows avec Visual Studio C++ Build Tools)
npm run tauri:build:windows

# Initialiser et compiler pour Android (JDK 17 + ANDROID_HOME + NDK_HOME configurés)
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
npm run tauri:android:init
npm run tauri:android:build

# Initialiser et compiler pour iOS (depuis un Mac avec Xcode + brew install xcodegen)
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
npm run tauri:ios:init
npm run tauri:ios:build
```

### Surcharger l’origine de l’API (Worker Cloudflare ou domaine personnalisé)

Par défaut, l’application native contacte `https://enise-docs-api-mb66o5jbpa-ew.a.run.app`. Pour pointer vers votre domaine Cloudflare Worker (afin de profiter du Cache API Edge avant Cloud Run) :

```bash
ENISE_API_ORIGIN="https://enise-docs.<votre-sous-domaine>.workers.dev" \
VITE_API_ORIGIN="https://enise-docs.<votre-sous-domaine>.workers.dev" \
npm run tauri:build
```

Sous GitHub Actions, lancez **Actions → Tauri Multiplatform Build → Run workflow** en renseignant le champ `api_origin`.

---

## 6. Signature de code et distribution en production (optionnel)

Sans secret configuré, le workflow produit déjà des installateurs fonctionnels :
- **Windows** : `.exe` / `.msi` installables (écran SmartScreen « Informations complémentaires → Exécuter quand même » tant qu’aucun certificat EV/OV n’est attaché).
- **macOS** : `.dmg` signé ad-hoc (au premier lancement hors notarisation Apple : `xattr -cr "/Applications/ENISE Docs.app"`).
- **Android** : `.apk` aligné (`zipalign`) et signé v1/v2/v3, immédiatement installable sur tout appareil Android.
- **iOS** : `.ipa` non signé installable via **AltStore / SideStore / Sideloadly** avec un simple identifiant Apple gratuit, plus le `.app.zip` pour **Simulateur iOS**.

Pour activer automatiquement la signature officielle App Store / Notarisation macOS / Google Play dans GitHub Actions (**Settings → Secrets and variables → Actions**) :

- **Apple (macOS & iOS)** : `APPLE_CERTIFICATE` (`.p12` en base64), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (mot de passe d’application), `APPLE_TEAM_ID`, et pour iOS App Store : `APPLE_PROVISIONING_PROFILE_BASE64`.
- **Android (Google Play)** : `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
