# Plan — base de données Appwrite pour les comptes, la connexion et les favoris

Projet Appwrite : **Django objects**
ID : `69cedb12002acdd498e0` — Endpoint : `https://fra.cloud.appwrite.io/v1`
Dépôt : `enise-docs` (React 19 + Vite + JS, Worker Cloudflare, npm, `appwrite@27.0.0`)

Statut (revue 2) : **phases 0, 2 et 3 codées** — SDK, client, `client.ping()`, service
d’authentification, `AuthProvider`, panneau de compte, favoris synchronisés et tests.
**La phase 1 (provisioning Appwrite) reste à exécuter** : le sandbox n’a aucun accès à
`fra.cloud.appwrite.io`, donc la base `enise_docs`, les tables et leurs permissions doivent
être créés depuis ta machine (`npm run appwrite:setup`) ou depuis la console.
Sans elle, `APPWRITE_DATABASE_ID` reste vide et tout le code « données » est court-circuité :
le site continue de fonctionner exactement comme avant.

---

## 0. Phase 0 — déjà en place (vérifiable maintenant)

| Fichier | Rôle |
| --- | --- |
| `package.json` | dépendance `appwrite@27.0.0` ajoutée |
| `src/config.js` | `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID` (valeurs *Django objects* codées en dur, surcharge `VITE_` possible), ID de base et des tables, `APPWRITE_ENABLED` |
| `src/services/appwrite.js` | `Client` unique `setEndpoint().setProject()`, instances `Account` et `TablesDB`, `ensureAppwritePing()` (un seul appel par chargement), boutique d’état pour React, `describeAppwriteError()` (messages FR) |
| `src/hooks/useAppwritePing.js` | lecture de l’état du ping via `useSyncExternalStore` |
| `src/components/AppwriteStatus.jsx` | pastille « Appwrite · connecté / injoignable » + bouton Réessayer, dans le pied de page |
| `src/main.jsx` | `client.ping()` exécuté **une fois au démarrage**, résultat en console et dans la pastille |
| `.env.example`, `.dev.vars.example` | variables `VITE_APPWRITE_*` documentées ; modèle `APPWRITE_API_KEY` côté serveur uniquement |

Comment vérifier : ouvrir l’aperçu du `npm run dev`, regarder la pastille du pied de page
(ou `?appwrite` dans l’URL pour la forcer) et la console. Attendu : `Appwrite · connecté`.

**Limite de l’environnement de travail** : le sandbox n’a aucune route vers
`fra.cloud.appwrite.io` (échec TLS sur `/v1/ping`), et `node_modules` n’était pas installé.
Le SDK est donc validé par le lint, les 88 tests et le build — **le ping lui-même ne peut être
confirmé que depuis un navigateur**. Si la pastille reste « injoignable » avec une erreur CORS,
c’est l’origine à déclarer dans *Domains & Platforms* (phase 1, point 7), pas le code.

---

## 1. Ce que « base de données pour les comptes » veut dire chez Appwrite

Deux services distincts, souvent confondus :

| Service | Rôle | Ce qu'il stocke | Ce qu'on écrit nous-mêmes |
| --- | --- | --- | --- |
| **Auth** (`Account`) | Création de compte, connexion, vérification d'email, récupération de mot de passe, sessions, OAuth2 | Utilisateur interne : email, **hash Argon2ID du mot de passe**, drapeaux `emailVerification`/`mfa`, préférences, sessions, labels | Aucun schéma à créer — c'est déjà une base de comptes prête à l'emploi |
| **TablesDB** | Données applicatives reliées au compte | Lignes typées avec permissions par ligne | Base + tables + colonnes + index (phase 1) |

Conséquence directe : **il ne faut jamais créer de table `users` avec un champ mot de passe**.
Le mot de passe reste dans Auth (hash + politique + anti-énumération gérés par Appwrite) ; la
base de données ne porte que le **profil** (promotions, filière, bio) et les **données
métier** (favoris synchronisés, aujourd'hui limités au `localStorage`).

Point d'attention version : Appwrite est en **2.x**. Le service `Databases`
(collections/documents) est **déprécié depuis la 1.8** au profit de **TablesDB** (données
typées) et **DocumentsDB** (JSON sans schéma). Ce plan utilise **TablesDB** : un profil et des
favoris ont une forme connue et contraignante. Le SDK web 27 expose `TablesDB` côté client
(`createRow`, `listRows`, `updateRow`, `deleteRow`) ; la création du schéma se fait dans la
console ou via l'API serveur.

---

## 2. Décisions d'architecture

### 2.1 Où passe le traffic d'authentification ?

| Option | Description | Avantages | Limites | Recommandé |
| --- | --- | --- | --- | --- |
| **A. Client → Appwrite (SDK web)** | Le navigateur parle directement à `fra.cloud.appwrite.io`, session dans le cookie Appwrite | Zéro backend à écrire, realtime, latence minimale | Cookie **tiers** (domaine `.cloud.appwrite.io`) : Safari/ITP et Chrome en mode restreint peuvent ne pas le conserver après rechargement ; origine à déclarer dans la console | ✅ **pour la phase 2 (démo + dev)** |
| **B. Proxy Worker (`/api/auth/*`)** | Le Worker Cloudflare relaie Appwrite avec une clé serveur et pose un cookie **first-party** sur `enise-docs.*` | Cookie non bloqué, CORS disparu, points d'entrée uniques pour limiter le débit et valider les données | Écriture du proxy, gestion des `Set-Cookie`, pas de `account.get()` gratuit | ✅ **pour la mise en production (phase 4)** |
| C. Sessions JWT + en-tête `x-appwrite-jwt` | `account.getJWT()`, vérifié dans le Worker avec la clé publique du projet | Sans cookie, compatible apps natives | Révocation plus complexe, rotation à gérer | ⚠️ seulement si B coince |

**Recommandation : A maintenant, B au moment du déploiement public.** Les deux parts de code
métier (phases 2–3) sont les mêmes : seule la fabrique du client change (endpoint et transport),
d'où l'indirection `src/services/appwrite.js`.

### 2.2 Qui crée le document de profil ?

Un client ne peut accorder des permissions **qu'à lui-même** (rôles `any`, `users`,
`user:<soi>`). Il peut donc, en théorie, pré-créer la ligne `profiles/<id_d_autrui>` avec des
permissions `any` — empoisonnement du flux d'inscription d'un camarade. Trois parades :

1. **`rowId = ID.unique()` + colonne `userId`** : la ligne n'est jamais indexée par l'identifiant
   de l'utilisateur, on interroge par `Query.equal('userId', …)`. Coût : une requête de plus.
2. **`rowId = ID.custom(userId)`** (1 ligne = 1 compte, lecture directe) : plus simple et plus
   rapide, mais expose le vecteur ci-dessus.
3. **Fonction Appwrite déclenchée sur l'événement `users.{id}.create`** qui écrit la ligne avec
   les bonnes permissions ; côté client on ne fait que **lire et mettre à jour sa propre ligne**.

**Choix retenu : 2 + 3** — la ligne est créée par la fonction (phase 4), et en attendant que la
fonction existe, par le client avec `rowId = ID.custom(user.$id)` ; le risque résiduel
(pré-création) est neutralisé dès la phase 4, et l'index unique `userId` rend visible toute
dérive.

### 2.3 Rôles d'administration

Pas de colonne `role` dans la table : une colonne écrite par le client est une escalade de
privilèges garantie. Utiliser les **labels d'utilisateur** Appwrite (`users/{id}/labels/admin`),
attribués depuis la console ou avec une clé serveur, et consultables par Appwrite dans les
permissions via `Role.label('admin')`.

---

## 3. Phase 1 — Provisionner la base et les tables

### 3.1 Schéma cible

Base **`enise_docs`** (type *TablesDB*, serveurless), deux tables.

**Table `profiles`** — une ligne par compte. Permissions de table : aucune en lecture,
`create = Role.users('verified')` ; sécurité par ligne activée.

| Colonne | Type | Contraintes | Sert à |
| --- | --- | --- | --- |
| `userId` | string | 36, requis, **unique** | clé d'association avec `Account.$id` |
| `displayName` | string | 128, requis | prénom/nom affiché dans l'en-tête |
| `promotion` | enum | `3A`,`4A`,`5A`,`Alumni`,`Staff` — défaut `3A` | filtre de bibliothèque |
| `filiere` | enum | `GM`,`TOEIC`,`Autre` — défaut `GM` | idem |
| `bio` | string | 280, défaut `''` | profil public optionnel |
| `emailVerified` | boolean | défaut `false` | cache du drapeau Auth pour les requêtes filtrées |
| `lastSeenAt` | datetime | optionnel | statistiques de fréquentation |

**Table `favorites`** — un favori par ligne, synchronisé entre appareils.

| Colonne | Type | Contraintes | Sert à |
| --- | --- | --- | --- |
| `userId` | string | 36, requis | propriétaire (aussi utilisé dans les permissions) |
| `filePath` | string | 1024, requis | chemin dans le bucket (`GM/3A GM/…/td3.pdf`) |
| `pathKey` | string | 64, requis, **unique avec `userId`** | empreinte courte de `filePath` (cf. §5, point 4) |
| `kind` | enum | `file`,`folder` — défaut `file` | type d'entrée |
| `title` | string | 240, défaut `''` | libellé figé au moment de l'épinglage |
| `note` | string | 280, défaut `''` | memo personnel |

Index : `unique(userId, pathKey)`, `key(userId, $createdAt)`, `fulltext(title, note)`.

**Permissions par ligne** (posées à la création) :

```js
[
  Permission.read(Role.user(userId)),
  Permission.update(Role.user(userId)),
  Permission.delete(Role.user(userId)),
]
```

Un administrateur (label `admin`) lit la table entière via la clé serveur, jamais via une
permission `any` posée par le client.

### 3.2 Deux méthodes, au choix

**Méthode console (5 min, aucune clé à manipuler)**

1. Console → projet *Django objects* → **Databases → Create database** → type **TablesDB**,
   ID `enise_docs`.
2. **Create table** → ID `profiles`, **activer la sécurité par ligne**
   (`Row-level permissions`) ; aucune permission de table en lecture.
3. Ajouter les colonnes du §3.1 (les enums doivent lister exactement les valeurs autorisées).
4. Permissions de table : `create` → rôle `users` (**pas** `users/verified`) ; `read` → `users`.
   Rien en lecture pour `any`. Un compte qui vient de s'inscrire n'est pas encore
   vérifié — avec `users/verified`, sa première écriture (sa propre ligne de profil)
   est refusée et l'inscription laisse un compte dans Auth sans ligne en base. Ce
   n'est pas une ouverture : les permissions de *ligne* limitent lecture et
   écriture au propriétaire, et `userId` vient de la session, jamais de la saisie.
5. Index : unique `(userId, pathKey)` sur `favorites`, unique `userId` sur `profiles`,
   key `(userId, $createdAt)`.
6. Répéter pour `favorites`.
7. **Settings → Domains & Platforms** : ajouter une plateforme *Web* avec le hostname du site
   déployé, et `localhost` (+ port) pour le développement. **Sans cette étape, le navigateur
   rejette les appels en CORS.**
8. **Settings → Auth** : activer *Email/Password*, vérification d'email obligatoire,
   récupération par email, longueur minimale 12 caractères, limite de sessions 5, durée de
   session 30 jours. Activer OAuth GitHub seulement si le flux est voulu (phase 6).

**Méthode script (réexécutable, versionnable)** — `scripts/appwrite-setup.mjs`, Node ≥ 20, sans
dépendance, idempotent (un `GET` précède chaque `POST`, les 409/« already exists » sont ignorés).
Appel REST direct avec une **clé serveur** (`databases:write`, `users:read`) :

```js
const ENDPOINT = process.env.APPWRITE_ENDPOINT ?? 'https://fra.cloud.appwrite.io/v1';
const PROJECT = process.env.APPWRITE_PROJECT_ID ?? '69cedb12002acdd498e0';

async function call(method, path, body) {
  const response = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-appwrite-project': PROJECT,
      'x-appwrite-key': process.env.APPWRITE_API_KEY, // jamais commitée, jamais en VITE_
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.message || response.statusText), { status: response.status, payload });
  return payload;
}
// createDatabase({databaseId:'enise_docs', name:'ENISE Docs'})
// createTable(...), createStringColumn(...), createEnumColumn(...), createUniqueIndex(...)
// Les chemins exacts (POST /v1/tablesdb, /tablesdb/{db}/tables, /columns/string,
// /indexes/unique) sont à reprendre tels quels de
// https://appwrite.io/docs/references/cloud/server-nodejs/tablesDB
```

Exécution : `APPWRITE_API_KEY=… node scripts/appwrite-setup.mjs` — à lancer **depuis ta
machine** : le sandbox de travail n'a pas de route réseau vers `fra.cloud.appwrite.io`
(vérifié : `curl` échoue en SSL), il ne peut donc ni créer les tables ni valider le `ping`.

Une fois la base créée, renseigner `VITE_APPWRITE_DATABASE_ID="enise_docs"` dans `.env.local`
(ou laisser la valeur par défaut dans `src/config.js` une fois l'ID figé).

---

## 4. Phase 2 — Couche d'authentification côté client

Fichiers à créer (aucune dépendance nouvelle) :

| Fichier | Contenu |
| --- | --- |
| `src/services/appwriteAuth.js` | Fonctions pures : `signUp`, `signIn`, `signOut`, `currentUser`, `requestVerification`, `completeVerification`, `requestPasswordRecovery`, `completePasswordRecovery`, `updateDisplayName`, `getPreferences`/`savePreferences`, `changePassword`, `deleteAccount` |
| `src/contexts/AuthContext.jsx` | `AuthProvider` : restaure la session au montage, expose `{ status, user, profile, actions, error }`, réécoute `visibilitychange` pour resynchroniser deux onglets |
| `src/hooks/useAuth.js` | Re-export `useContext(AuthContext)` + sélecteurs `useIsAuthenticated`, `useProfile` |
| `src/components/AuthPanel.jsx` | Panneau modal 3 onglets (Connexion / Inscription / Mot de passe oublié), labels en français, `autoComplete` corrects, messages d'erreur traduits par `describeAppwriteError()` |
| `src/components/UserChip.jsx` | Dans `.header-actions` : avatar + prénom, menu « Mon profil / Mes favoris / Se déconnecter » |
| `src/utils/paths.js` (extension) | `verifyUrl()` lit `?userId=&secret=` posés par les emails Appwrite et les consomme une fois |

Forme du service (extrait — le code utile, pas de framework) :

```js
import { ID } from 'appwrite';
import { account, describeAppwriteError } from './appwrite';

export async function signIn({ email, password }) {
  try {
    return await account.createEmailPasswordSession({ email, password });
  } catch (error) {
    throw new Error(describeAppwriteError(error));
  }
}

export async function signUp({ email, password, name, promotion, filiere }) {
  // 1. compte (Auth) — 2. session immédiate — 3. email de vérification —
  // 4. ligne de profil, permissions sur le propriétaire uniquement.
  const user = await account.create({ userId: ID.unique(), email, password, name });
  await account.createEmailPasswordSession({ email, password });
  await account.createVerification({ url: `${window.location.origin}/?verify=1` });
  await createProfileRow(user, { promotion, filiere });
  return user;
}

export async function currentUser() {
  try {
    return await account.get();
  } catch (error) {
    if (error?.code === 'user_missing') return null; // pas de session : cas normal
    throw new Error(describeAppwriteError(error));
  }
}
```

Contraintes d'ergonomie à respecter (le reste du site est en français et accessible) :

- `aria-live="polite"` sur la zone d'erreur du formulaire, focus renvoyé sur le champ fautif ;
- soumission désactivée pendant l'appel, `inert` sur le reste de la page quand le panneau est ouvert ;
- aucun mot de passe dans `console.*`, aucun `error.message` brut renvoyé à l'UI (mapping FR) ;
- délai visuel de 400 ms sur « Mot de passe oublié » pour ne pas révéler l'existence d'un compte.

Critères d'acceptation : inscription → email reçu → clic → `emailVerification === true` ;
rechargement de page → session conservée ; déconnexion → `account.deleteSessions()` et
`AuthContext.status === 'guest'`.

---

## 5. Phase 3 — Favoris synchronisés (migration du `localStorage`)

Le site stocke déjà les favoris sous la clé `enise-docs:favorites`
(`src/App.jsx`, `useLocalStorage`). On remplace progressivement ce stockage par la table
`favorites`, sans casser le mode hors connexion.

1. `src/services/favorites.js` : `listFavorites()`, `addFavorite(item)`, `removeFavorite(path)`,
   `setFavoriteNote(path, note)` — tous en **optimiste** (state local d'abord, écriture ensuite,
   retour arrière en cas d'échec + `toast` discret).
2. `src/hooks/useFavorites.js` : fusionne trois sources avec la règle
   `cloud ⊕ local − supprimés` ; hors ligne ⇒ local seul + badge « non synchronisé ».
   Abonnement `Realtime` sur `Channel.tablesdb(APPWRITE_DATABASE_ID).table('favorites')`
   (événements `create`/`update`/`delete`) : les permissions de ligne filtrent déjà ce que
   l'abonné reçoit — la synchro multi-onglets et multi-appareils est gratuite.
3. Migration à la première connexion : envoi des favoris locaux absents du cloud (`upsertRow`,
   idempotent grâce à l'index unique), conservation de la clé locale en miroir hors ligne.
4. Empreinte de chemin : `pathKey = sha256(normalize(path)).slice(0,32)` via `crypto.subtle`
   — évite de poser l'index unique sur une chaîne de 1024 caractères, dont l'encodage peut
   dépasser la taille maximale d'une clé d'index acceptée par le moteur.

**Ne pas** synchroniser : l'historique de consultation complet, les tokens, les chemins non
normalisés. Le `userId` stocké dans la ligne suffit à identifier l'auteur ; l'email ne doit pas
être dupliqué dans `profiles` (il vit déjà dans Auth, et une copie = donnée inutile à effacer en
cas de demande de suppression).

---

## 6. Phase 4 — Durcissement côté serveur (Worker + fonction)

Trois ajouts, indépendants et activables séparément :

1. **Création de ligne côté serveur** : fonction Appwrite (`node 22`, événements
   `users.*.create` / `users.*.delete`) qui écrit `profiles/<userId>` avec les permissions exactes,
   aligne `emailVerified`, et supprime la ligne + les favoris à la suppression du compte.
2. **`/api/auth/*` dans le Worker** : `POST session` (relais Appwrite + re-pose d'un cookie
   first-party `enise_session`, `HttpOnly`+`SameSite=Lax`+`Secure`), `DELETE session`,
   `GET me`. Bénéfices : contourne le blocage des cookies tiers, masque l'ID de projet réel au
   scan, et centralise la limitation de débit.
3. **Anti-abus** : le Worker applique la limite existante (pattern déjà utilisé pour les
   conversions Office/3D) sur `POST /api/auth/session` — 5 tentatives / 10 min / IP, code
   `429` + `Retry-After`. Le cache Edge (`CACHE_KEY_VERSION`, `X-Cache-Status`) ne doit
   **jamais** mettre en cache une réponse d'authentification : à forcer en `private, no-store`
   dans la branche `/api/auth/`.

À noter : `index.html` ne pose **aucune CSP** et le Worker n'ajoute de CSP (`sandbox;
default-src 'none'`) que sur les réponses de fichiers bruts — il n'y a donc pas de
`connect-src` à ouvrir pour Appwrite. C'est un point à ne pas oublier si une CSP globale est
ajoutée plus tard.

---

## 7. Phase 5 — Sécurité et conformité

- **Secrets** : la clé API Appwrite reste côté serveur (`wrangler secret put APPWRITE_API_KEY`,
  `.dev.vars` en local — modèle déjà documenté dans `.dev.vars.example`). Aucune variable préfixée
  `VITE_` ne doit la contenir : elle serait intégrée au bundle public.
- **Permissions minimales** : aucune permission `any` sur `profiles`/`favorites` ; les lectures
  d'administration passent par la clé serveur. `documentSecurity`/row-level security activé.
- **Validation serveur** : les enums Appwrite bornent déjà `promotion`, `filiere`, `kind` ; les
  tailles de colonnes bornent le reste. Aucune confiance aux données envoyées par le client.
- **Données personnelles** : emails d'étudiants = données personnelles. Prévoir
  `deleteAccount()` (`account.updatePassword` + suppression du compte Appwrite, qui déclenche la
  purge des lignes via la fonction de la phase 4), une mention dans le pied de page/`À propos`,
  et une durée de rétention des sessions courte (30 jours max).
- **Emails** : le plan Cloud envoie les emails depuis un domaine Appwrite ; pour éviter
  les spams, vérifier/déclarer le domaine d'expédition dans *Auth → SMTP* dès que possible.
- **Rotations** : la clé API est limitée aux scopes `databases:write` +
  `users:read` (fonction), avec une date d'expiration ; rotation semestrielle.
- **Poids du SDK** : ~39 kB gzip non tree-shaké, nettement moins après tree-shaking. Si le budget du
  chunk d'entrée devient sensible, charger `src/services/appwrite.js` en `import()` paresseux ou
  le isoler via `manualChunks`.

---

## 8. Phase 6 — Tests, QA, outillage

- Le `.gitignore` contient `*.test.js` (ligne 46) : **tout nouveau fichier de test est ignoré par
  Git**. Corriger par une négation `!tests/*.test.js` avant d'écrire la suite, sinon les tests
  seront « verts » localement et absents du dépôt.
- `tests/appwrite-config.test.js` : valeurs codées en dur correctes (endpoint `fra`,
  projet `69cedb12002acdd498e0`), absence de clé API dans les `VITE_`, `pathKey` stable.
- `tests/favorites-merge.test.js` : fusion cloud/local, idempotence de la migration, suppression
  qui ne revient pas au rechargement.
- `tests/appwrite-auth-errors.test.js` : `describeAppwriteError()` → messages FR pour
  `user_already_exists`, `invalid_credentials`, `user_inactive`, `rate_limit_exceeded`.
- Smoke de connexion : la pastille du pied de page (déjà en place) repasse par
  « vérification… → connecté ». En CI, un script `scripts/check-appwrite.mjs` peut faire le même
  `GET /v1/ping` avec une clé, à condition que le runner ait un accès réseau.
- `npm run check` (lint + tests + build) doit rester vert à chaque phase. **Attention : il est
  déjà rouge sur `HEAD`** — `eslint .` remonte 67 erreurs dans `client-examples/javascript-client.js`
  et `scripts/deploy-space.js` (aucun bloc de config ne leur donne les globals `node`/`browser` ;
  ces fichiers sont vierges de tout changement). Ajouter une entrée
  `{ files: ['client-examples/**/*.js', 'scripts/deploy-space.js'], languageOptions: { globals: globals.node } }`
  à `eslint.config.js`, sinon le lint ne servira pas de signal pendant les phases 2 à 6.
  Les fichiers de la phase 0 (`src/config.js`, `src/services/appwrite.js`,
  `src/hooks/useAppwritePing.js`, `src/components/AppwriteStatus.jsx`) passent eux le lint,
  les 88 tests et le build.
- Matrice de test manuel : inscription, double inscription, mauvais mot de passe, email de
  vérification expiré, rechargement avec/sans cookie tiers (Safari), 2 onglets, mode hors
  connexion, mobile (panneau plein écran), lecteur d'écran sur les erreurs.

---

## 9. Phase 7 — Déploiement progressif

1. `VITE_APPWRITE_DATABASE_ID` et `VITE_APPWRITE_PROJECT_ID` figés dans `src/config.js`
   (valeurs publiques) ; surcharge possible par `.env.local`.
2. `npm run build && wrangler deploy` : le Worker sert le build, Appwrite reste appelé depuis le
   navigateur (ou via `/api/auth/*` en phase 4).
3. **Activation par drapeau** : un drapeau `APPWRITE_AUTH_ENABLED` (variable de build) — la pastille, le
   `UserChip` et la synchro des favoris restent cachés tant que la base n'est pas provisionnée ;
   l'interface actuelle (`localStorage`) continue de fonctionner seule.
4. Rollout : (a) ping visible uniquement, (b) comptes + profils, (c) favoris synchronisés pour
   les comptes vérifiés, (d) proxy Worker activé. Chaque étape garde un chemin de retour : il
   suffit de couper le drapeau.

### Rétroplanning estimé

| Phase | Contenu | Durée | Dépend de |
| --- | --- | --- | --- |
| 0 | SDK, client, ping, pastille | ✅ fait | — |
| 1 | Base + tables + permissions (console ou script) | 0,5 j | accès console Appwrite |
| 2 | Service d'auth + `AuthContext` + panneau + `UserChip` | 1–1,5 j | phase 1 |
| 3 | Favoris synchronisés + migration | 1 j | phase 2 |
| 4 | Fonction serveur + proxy Worker + anti-abus | 1–2 j | phases 2–3 |
| 5 | Durcissement sécurité/conformité | 0,5 j | phase 4 |
| 6 | Tests + correctifs `.gitignore` | 0,5 j | phase 2 |
| 7 | Déploiement progressif | 0,5 j | phases 1–6 |

### Critères d'acceptation globaux

- Un visiteur non connecté garde l'usage complet du site (aucune régression).
- Créer un compte, le vérifier, se reconnecter depuis un autre appareil : les favoris suivent.
- `npm run check` vert ; `GET /v1/ping` confirmé « connecté » dans la pastille.
- Aucune clé serveur dans le bundle (`grep -r "APPWRITE_API_KEY" dist/` vide).

---

## 10. Risques connus

| Risque | Impact | Parade |
| --- | --- | --- |
| Cookie de session Appwrite Cloud traité comme tiers par le navigateur | Déconnexion à chaque rechargement (Safari surtout) | Phase 4 : cookie first-party posé par le Worker |
| Origine non déclarée dans *Domains & Platforms* | Erreurs CORS, `ping` en échec | Déclarer `localhost:3000`, le domaine preview et le domaine de prod |
| Sandbox sans réseau vers `fra.cloud.appwrite.io` | Impossible de valider ping/provisioning depuis l'agent | Vérification dans le navigateur de l'utilisateur + script exécuté en local |
| Pré-création de `profiles/<id>` par un tiers | Conflit à l'inscription | Fonction serveur (phase 4), sinon `rowId = ID.unique()` (option 2.2-1) |
| Colonne `role` éditable par le client | Escalade de privilèges | Labels Appwrite + `Role.label('admin')` |
| Index unique sur `filePath` (1024 car.) | Rejet de l'index par le moteur de base | `pathKey` court (§5, point 4) |
| Emails de vérification en spam | Comptes inutilisables | SMTP/domaine vérifié, renvoi manuel depuis la console |
| `*.test.js` ignoré par Git | Tests absents du dépôt | Négation dans `.gitignore` avant la phase 6 |

---

## 12. État d'avancement (code en l'état du dépôt)

| Élément | Fichier | Statut |
| --- | --- | --- |
| Client, endpoint, projet | `src/config.js`, `src/services/appwrite.js` | ✅ |
| `client.ping()` au démarrage + pastille | `src/main.jsx`, `src/components/AppwriteStatus.jsx`, `src/hooks/useAppwritePing.js` | ✅ |
| Provisioning idempotent (base, tables, colonnes, index, permissions) + auto‑détection du dialecte d’API | `scripts/appwrite-setup.mjs` (`npm run appwrite:setup`, `--diagnose`, `--dry-run`, `--ping`, `--status`, `--drop`, `--flavor=`) | ✅ code / ⏳ à exécuter avec une clé serveur |
| Service de compte (inscription, connexion, sessions, vérification, récupération, mot de passe, préférences, export RGPD) | `src/services/appwriteAuth.js` | ✅ |
| Contexte de session + restauration au chargement | `src/contexts/AuthContext.jsx`, `src/contexts/auth-context.js`, `src/hooks/useAuth.js` | ✅ |
| Panneau de compte (connexion / inscription / mot de passe oublié / profil) | `src/components/AuthPanel.jsx` | ✅ |
| Puce de compte dans l’en-tête + menu | `src/components/UserChip.jsx` | ✅ |
| Favoris synchronisés + miroir local + tombstones | `src/services/favorites.js`, `src/utils/favoritesMerge.js`, `src/hooks/useFavorites.js` | ✅ code / ⏳ table `favorites` requise |
| Tests | `tests/appwrite-config.test.js`, `tests/appwrite-auth.test.js`, `tests/favorites-merge.test.js` | ✅ 109 tests |
| Lint vert (globals ESLint de `client-examples/` et `scripts/*.js` ajoutés) | `eslint.config.js` | ✅ |
| `!tests/*.test.js` dans le `.gitignore` | `.gitignore` | ✅ |
| Façade `rows` (contrat unique TablesDB / API héritée `Databases`) | `src/services/appwrite.js`, `src/config.js` (`VITE_APPWRITE_FLAVOR`) | ✅ |
| Fonction serveur de création du profil, proxy `/api/auth/*`, labels d’admin | phases 4 et 5 | ⏳ planifié |
| Realtime sur la table `favorites` | — | ⏳ volontairement laissé hors de cette passe (vérification impossible sans réseau) |

Choix appliqués après arbitrage : périmètre **comptes + profils + favoris synchronisés**,
transport **client direct d’abord** puis proxy Worker au déploiement, base **TablesDB**.

---

## 11. Décisions actées

1. **Périmètre** : comptes + profils + favoris synchronisés.
2. **Transport** : client direct d'abord, proxy `/api/auth/*` dans le Worker au déploiement.
3. **Base** : TablesDB (schéma typé).
4. **Provisioning** : `scripts/appwrite-setup.mjs` lancé depuis la machine de l'utilisateur
   (le sandbox n'a pas de route vers Appwrite), avec la checklist console en secours.
5. **Reste ouvert** : activer ou non OAuth GitHub (`VITE_APPWRITE_OAUTH_PROVIDER`) ; le
   `UserChip` et le panneau sont déjà prêts à afficher le bouton si la variable est renseignée.

---

## 13. Diagnostic d'un provisioning qui échoue

Première règle : **une vraie erreur Appwrite est toujours du JSON avec un `type`**
(`general_route_not_found`, `missing_scope`, `user_unauthorized`…). Tout le reste est un
problème de route ou de réseau — et l'en-tête `server` suffit à les séparer.

| Sortie du script | Ce que ça veut dire | Que faire |
| --- | --- | --- |
| 404 **HTML** avec `server = Appwrite` | Appwrite a été joint (le réseau marche) mais ne connaît pas la route : base mal formée. Cas rencontré ici — le script ajoutait `/v1` devant un endpoint qui le contenait déjà (`…/v1/v1/databases`) | Corrigé par `normalizeAppwriteEndpoint` (`src/utils/appwriteEndpoint.js`). Vérifier la ligne `base : …` de `--diagnose` : un seul `/v1`, sinon `APPWRITE_ENDPOINT="https://…/v1"` |
| 404 **texte** sans `server: Appwrite` | Ce n'est pas Appwrite qui répond : egress filtré ou proxy qui invente un 404 | Lancer le script depuis une machine qui joint Internet (`git pull` de la branche), ou provisionner dans la console (§3.2) |
| `aucune route réseau vers … (ECONNRESET)` | TLS coupé vers l'hôte. Le shell de l'agent est dans ce cas, le terminal de l'utilisateur non | Avec un proxy : `HTTPS_PROXY="http://127.0.0.1:port" npm run appwrite:setup` |
| `401` | `APPWRITE_API_KEY` absente, expirée ou révoquée | Recréer la clé (Console → API Keys) |
| `403` | clé sans scope suffisant | Ajouter `databases:write` (et `tablesdb:write` sur les plans récents) |
| 404 **JSON** `general_route_not_found` | L'instance ne sert pas `/v1/tablesdb` (projet antérieur à l'API 2.x) | `--flavor=databases`, puis `VITE_APPWRITE_FLAVOR="databases"` : la façade `rows` du client s'adapte, aucun autre changement |
| `400` « Cannot set default value for required column » | Une colonne `required` porte un `default` : TablesDB l'interdit (quatre colonnes de `profiles` étaient dans ce cas) | Corrigé dans `scripts/appwrite-spec.js` ; `validateModel()` le refuse localement avant tout appel réseau |
| `404 HTML` sur `PATCH /tablesdb/{db}/tables/{id}` | `updateTable` n'existe **qu'en PUT**, et `name` y est obligatoire : le verbe faux répond la page du Console, pas une erreur JSON | Le script envoie `PUT` avec `{ name, permissions, rowSecurity, enabled }` (valeurs du modèle, donc idempotent et sans assouplissement) |
| `400 The requested column 'x' is not yet available` | Colonnes et index sont créés **hors ligne** : poser un index sur une colonne qui vient de naître est refusé dans la seconde | `withPendingRetry` attend et retente (10 × 1,2 s, réglable par `APPWRITE_RETRY_ATTEMPTS`/`APPWRITE_RETRY_DELAY_MS`) ; relancer le script suffit aussi, puisque la colonne est devenue disponible entre-temps |
| `400` mentionnant `specification` | Le plan Cloud exige une spécification de base | Le script la déduit de `/v1/tablesdb/specifications` ; sinon `--specification=<id>` (ou `--specification=none`) |
| `429` | limite de débit de la clé | Réessayer dans une minute |

Route de correction des enums : `PATCH /v1/tablesdb/{db}/tables/{t}/columns/enum/{key}`
avec `elements`, `required` **et** `default` (les trois requis) — TablesDB n'a pas de
sous-route `/elements`, contrairement à `attributes/enum/{key}/elements` de DocumentsDB.

Règles d'API retenues de ces échecs, écrites dans le modèle : une colonne
`required` n'a **jamais** de `default` (le défaut protège une ligne créée hors du
chemin normal, donc ces champs sont optionnels avec défaut — `userId`, `filePath`
et `pathKey` restent obligatoires) ; un index unique ne porte pas une colonne de
1024 caractères (d'où `pathKey`) ; `$createdAt` est une colonne système
référençable dans un index sans être déclarée.

Triage, sans clé :

```bash
npm run appwrite:ping                            # attendu : 200 + corps exact « Pong! »
node scripts/appwrite-setup.mjs --diagnose       # base utilisée + routes tablesdb / databases
node scripts/appwrite-setup.mjs --dry-run        # les appels qui seraient faits
node scripts/appwrite-setup.mjs --fix-enums      # réaligne une colonne enum périmée
```

⚠️ Le contrat du `ping` est **`HTTP 200` + corps exact `Pong!`** en `text/plain` — pas un
JSON, et pas le texte d'accueil du Console. Une version antérieure du script attendait
« Welcome to the Appwrite REST API » et déclarait donc suspect un endpoint parfaitement
valide.

### Retrouver la base dans la console

« `+ base enise_docs — créée` » puis rien de visible dans la console a deux causes
distinctes, à vérifier dans cet ordre :

1. **Le sélecteur de produit** : depuis Appwrite 2.x, Databases est découpé en
   *Tables*, *Documents*, *Vectors*. Une base TablesDB n'apparaît **que** dans l'onglet
   **Tables** (et une base de l'API héritée dans *Documents* aussi). Console →
   Project → **Databases → Tables** → `enise_docs`.
2. **La base est vide parce que le run a échoué juste après sa création** (le
   `[object Object]` sur `tableId`) : aucune table, donc rien à afficher. Relancer
   `npm run appwrite:setup` — le plan est idempotent, la base existante est détectée
   (`✓ base enise_docs — déjà en place`) et les tables sont créées dans la foulée.
3. Contrôle sans oeil : `npm run appwrite:status` affiche
   `profiles : 7/7 colonnes, 2/2 index, sécurité par ligne=true` quand tout est en place.

**Sécurité** : une clé collée dans un terminal, un historique shell ou une conversation est
à considérer comme compromise — la révoquer et la recréer dans Console → API Keys, puis la
transmettre par `.env.local` (ignoré par Git) ou `read -s`. Le dépôt ne contient aucune
clé : `git grep -lE 'standard_[0-9a-f]{20,}'` ne renvoie rien, et le contrôle est répété
par `tests/appwrite-config.test.js`.

Le client n'a pas besoin d'attendre le provisioning : `APPWRITE_DATABASE_ID` vide
court‑circuite `rows.*`, donc ni erreur ni requête — seul le `ping` et la connexion
de compte restent actifs.
