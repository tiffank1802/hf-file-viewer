# ENISE Docs

Bibliothèque étudiante moderne pour les ressources de **Centrale Lyon ENISE**, avec un lien visuel vers l’**ENSPY** et le Cameroun. Les fichiers restent dans le bucket public Hugging Face [`ktongue/ENISE-SITE`](https://huggingface.co/buckets/ktongue/ENISE-SITE) ; Cloudflare sert le frontend et réduit les appels à Hugging Face grâce à son cache Edge.

## Ce qui est inclus

- frontend React responsive, accessible et en français ;
- identité blanche « liquid glass », verte, rouge et jaune ;
- icônes React (`react-icons`) et logos locaux optimisés ;
- navigation par dossier, fil d’Ariane, tri, grille/liste ;
- aperçu PDF, image, audio, vidéo, texte et **visionneuse Office hybride** : rendu local (`.docx`, `.xlsx`/`.xls`, texte `.pptx`), conversion PDF serveur (LibreOffice) et **Viewer Office Web** (`.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`) ;
- raccourcis **Microsoft OneNote** (`.url`) affichés avec leur cible ouvrable, blocs-notes `.one` disponibles au téléchargement ;
- aperçu 3D hybride : conversion **GLB gratuite** (FreeCAD) pour `.step`, `.iges`, `.stl`, `.obj` avec rotation, zoom et déplacement, **Autodesk APS** (Model Derivative) pour les autres formats (`.dwg`, `.rvt`, `.sldprt`, `.ifc`, `.catpart`, … — FreeCAD ne lit pas les formats propriétaires), et plugin iframe **ShareCAD** en roue de secours gratuite sans conversion ;
- téléchargement, partage et favoris enregistrés dans le navigateur ;
- recherche globale à partir d’un index Hugging Face mis en cache ;
- effectifs par dossier calculés **une seule fois à l’indexation** et stockés dans le JSON d’index ;
- Worker Cloudflare servant à la fois les assets statiques et l’API proxy ;
- Cache API configuré pour les arbres, l’index et les fichiers raisonnablement petits ;
- mode aperçu local si l’API n’est pas joignable pendant le développement ;
- CSP, en-têtes de sécurité, validation des chemins et secret HF uniquement côté serveur.

## Architecture

```text
Navigateur
   │
   ├── assets HTML/CSS/JS ───── Cloudflare Workers Assets / CDN
   │
   └── /api/* ───────────────── Cloudflare Worker
                                  │
                                  ├── Cache API du datacenter (HIT)
                                  │      └── réponse immédiate
                                  │
                                  ├── Workers KV optionnel (KV-HIT)
                                  │      └── métadonnées partagées entre régions
                                  │
                                  └── Cache MISS
                                         └── API / bucket Hugging Face
```

Le frontend et le Worker sont sur **le même domaine**. Le navigateur n’appelle donc jamais Hugging Face avec une clé secrète et il n’y a pas de problème CORS à gérer.

### Où se trouve chaque cache ?

| Contenu | Cache navigateur | Cache Cloudflare | Origine |
|---|---:|---:|---|
| Assets versionnés | 1 an | CDN Cloudflare | bundle Vite |
| Dossier `/api/tree` | 5 min | Cache API, 6 h | API Hugging Face |
| Index `/api/index` | 30 min | Cache API, 12 h | API Hugging Face |
| Comptage `/api/counts` | 30 min | Cache API, 12 h | JSON d’index (aucun appel HF) |
| Fichier `/api/file` | 1 h | Cache API, 7 j | bucket Hugging Face |
| PDF Office `/api/office/pdf` | 1 h | Cache API, 7 j | Space LibreOffice |
| GLB 3D `/api/model3d/glb` | 1 h | Cache API, 7 j | Space FreeCAD |
| Aperçu lien `/api/link/preview` | 1 h | Cache API, 24 h | page cible |

Les fichiers ne sont ajoutés au Cache API que si une réponse complète possède une taille connue inférieure ou égale à **25 Mio**. Les requêtes `Range` et les fichiers plus grands sont transmis sans mise en cache par le Worker (`BYPASS-RANGE` ou `BYPASS-SIZE`) ; le CDN de Hugging Face peut néanmoins les optimiser.

> Le **Cache API est un cache temporaire propre au datacenter Cloudflare qui reçoit la requête**. Ce n’est ni une base globale durable, ni Workers KV. Un premier visiteur dans une autre région peut donc provoquer un nouveau MISS. Le site fonctionne ainsi sans aucune base. Une couche Workers KV facultative peut cependant partager les métadonnées entre régions (voir plus bas) ; les fichiers binaires restent dans le Cache API/Hugging Face.

## Démarrage local

Prérequis : Node.js 20.19 ou plus récent.

```bash
npm install
npm run dev
```

`npm run dev` lance Vite sur `http://localhost:3000`. Sans Worker local, l’interface utilise automatiquement les données d’aperçu si `/api` est indisponible.

Pour tester le frontend **et** le Worker **avec les fonctions 3D**, créer d’abord les secrets locaux (jamais versionnés) :

```bash
cp .dev.vars.example .dev.vars
# renseigner APS_CLIENT_ID et APS_CLIENT_SECRET avant de lancer
npm run dev:worker
```

`scripts/check-dev-vars.mjs` affiche un avertissement clair si `.dev.vars` est absent ou encore aux valeurs d’exemple. Le site complet est alors disponible sur `http://localhost:8787`. Attention : pour la conversion 3D et le viewer Office, Autodesk / Microsoft doivent pouvoir joindre l’URL publique du site ; une adresse `localhost` ne convient pas depuis un autre service.

## Déploiement sur Cloudflare

Cette configuration utilise **Cloudflare Workers + Static Assets**, ce qui permet un seul déploiement et un seul domaine pour le site et l’API.

1. Se connecter une première fois :

   ```bash
   npx wrangler login
   ```

2. Vérifier le projet :

   ```bash
   npm run check
   npx wrangler deploy --dry-run
   ```

3. Déployer :

   ```bash
   npm run deploy
   ```

Wrangler construit `dist/`, crée ou met à jour le Worker `enise-docs`, téléverse les assets et affiche l’URL `*.workers.dev`. Un domaine personnalisé peut ensuite être ajouté dans **Workers & Pages → enise-docs → Settings → Domains & Routes**.

Les réglages de production sont dans [`wrangler.jsonc`](./wrangler.jsonc) :

```jsonc
"vars": {
  "HF_BUCKET_ID": "ktongue/ENISE-SITE",
  "TREE_CACHE_TTL": "21600",
  "INDEX_CACHE_TTL": "43200",
  "FILE_CACHE_TTL": "604800",
  "KV_CACHE_TTL": "86400",
  "MAX_CACHEABLE_FILE_BYTES": "26214400"
}
```

Un changement de TTL s’applique aux nouvelles entrées de cache. Les anciennes expirent naturellement ou peuvent être purgées depuis le tableau de bord Cloudflare.

### Couche Workers KV facultative

Le déploiement par défaut n’exige aucune ressource KV. Pour éviter qu’un nouveau datacenter Cloudflare rappelle Hugging Face lors de son premier MISS, il est possible d’activer un cache global de **métadonnées uniquement** :

```bash
npx wrangler kv namespace create METADATA_KV
```

Reporter l’identifiant renvoyé dans `wrangler.jsonc` :

```jsonc
"kv_namespaces": [
  { "binding": "METADATA_KV", "id": "IDENTIFIANT_RENVOYE_PAR_WRANGLER" }
]
```

Puis redéployer avec `npm run deploy`. Le Worker détecte automatiquement `env.METADATA_KV` et utilise la hiérarchie **Cache API → Workers KV → Hugging Face**. Les entrées KV expirent après 24 h (`KV_CACHE_TTL`) afin de rester cohérentes avec le bucket. Cette option consomme les quotas de lectures/écritures KV ; elle n’est utile que si le trafic provient de nombreuses régions.

## Aperçu des documents Office (visionneuse hybride)

La modale d’aperçu propose jusqu’à **3 modes** (sélecteur en haut, préférence mémorisée dans le navigateur), tous gratuits et open source côté rendu :

| Mode | Formats | Technologie | Fidélité | Contrainte |
|---|---|---|---|---|
| **Aperçu local** | `.docx`/`.docm`, `.xlsx`/`.xls`/`.xlsm` | `docx-preview`, `xlsx` (SheetJS CE) + grille maison | bonne | ≤ 15 Mo, ≤ 50 000 cellules |
| **Texte local** | `.pptx`/`.pptm` | `jszip` (extraction du texte par diapo) | texte seul | ≤ 15 Mo |
| **PDF** | `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`, `.odt`, `.ods`, `.odp` | conversion LibreOffice côté serveur | très bonne | Space configuré (voir ci-dessous) |
| **Microsoft** | `doc`, `docx`, `xls`, `xlsx`, `ppt`, `pptx`, … | Viewer Office Web (`view.officeapps.live.com`) | maximale | site accessible publiquement |

- Les librairies locales sont chargées en `import()` dynamique : le bundle initial n’augmente pas, aucun CDN externe n’est utilisé (aucune modification CSP requise).
- Le classeur local offre onglets de feuilles, pagination et **export CSV** de la feuille active.
- Le mode Microsoft nécessite toujours une URL publique : en développement `localhost`, utiliser l’**Aperçu local** ou l’URL publique exposée par l’environnement (`npm run dev:worker`).

### Conversion PDF via LibreOffice (mode « PDF »)

Le Worker ne peut pas convertir lui-même (binaire natif, CPU limité) : il délègue au Space Docker [`space-huggingface/`](./space-huggingface/) (LibreOffice headless), puis met le PDF en cache (Cache API, 7 j) :

```text
Navigateur
   ├── GET /api/office/status   -> conversion configurée ou non
   └── GET /api/office/pdf      -> Worker : HF (source) → Space → PDF caché
```

1. Déployer le Space Docker (`space-huggingface/`, SDK `docker`, port `7860`).
2. Renseigner son URL publique :
   ```bash
   # production (variable publique, affichée dans wrangler.jsonc)
   # OFFICE_CONVERT_URL="https://<votre-space>.hf.space"
   # développement local dans .dev.vars :
   # OFFICE_CONVERT_URL="https://<votre-space>.hf.space"
   ```
3. Redéployer (`npm run deploy`). Sans cette variable, le mode « PDF » est masqué et les autres modes restent disponibles.

Premier appel à froid : compter jusqu’à une minute si le Space gratuit dormait ; les appels suivants sont cachés côté Cloudflare.

### Raccourcis `.url` (dont liens OneNote)

Les raccourcis Windows `.url` s’ouvrent dans une **carte de lien enrichie** : le fichier est parsé localement (URL, icône, section `[InternetShortcut]`), la cible est qualifiée par un badge (**OneNote en ligne**, **Lien OneNote**, **Page web**, **Fichier local**…), puis les cibles http(s) sont enrichies via `GET /api/link/preview?url=...` (titre, description, image Open Graph, mise en cache 24 h). Boutons **Ouvrir la ressource**, **Copier** et téléchargement du `.url`. Tout échec d’enrichissement dégrade vers une carte simple : l’accès au lien n’est jamais bloqué. Les hôtes internes (localhost, IP privées…) sont refusés côté Worker ; la CSP autorise les images `https:` distantes pour les visuels Open Graph.

> **Liens OneNote privés** : un lien exigeant une connexion Microsoft ne peut être visualisé que par son propriétaire — aucun aperçu n’est possible pour les autres visiteurs. Quand l’aperçu détecte une redirection vers le login Microsoft, la carte affiche un encadré « Contenu privé » avec la marche à suivre : partage « Toute personne disposant du lien peut afficher » depuis OneDrive/OneNote, ou export des pages en PDF/Word (OneNote → Fichier → Exporter) déposé dans le bucket — formats déjà visualisables comme les autres documents MS. Le partage « Anyone » peut être automatisé en masse via Microsoft Graph : voir `scripts/share-onenote-links.py` et `scripts/README_SHARE_ONENOTE.md`.

### Blocs-notes Microsoft OneNote

- Les blocs-notes `.one` / `.onenote` ne disposent pas de visionneuse embarquée dans le navigateur : la modale propose leur téléchargement pour les ouvrir dans Microsoft OneNote.

Ce viewer remplace l’ancienne intégration ONLYOFFICE : aucun document server externe n’est plus nécessaire et aucun secret n’est exposé.

## Visualisation 3D (Aperçu Web + Autodesk APS + ShareCAD)

Les fichiers modèles (`.dwg`, `.dxf`, `.dwf`, `.rvt`, `.rfa`, `.ifc`, `.ipt`, `.iam`, `.sldprt`, `.sldasm`, `.stp`, `.step`, `.igs`, `.iges`, `.obj`, `.stl`, `.sat`, `.x_t`, `.x_b`, `.3ds`, `.fbx`, `.dae`, `.skp`, …) sont ouverts dans la modale d’aperçu avec rotation, zoom et panoramique à la souris. Trois moteurs au choix (onglets, préférence mémorisée) :

- **Aperçu Web** (défaut, gratuit) : les formats `.step`, `.stp`, `.iges`, `.igs`, `.stl` et `.obj` sont convertis en GLB par le Space FreeCAD puis affichés en WebGL (three.js), avec choix de la qualité du maillage (brouillon/standard/fin), rotation automatique et statistiques (triangles, dimensions, volume). FreeCAD ne lit pas les formats propriétaires : `.sldprt`, `.dwg`, assemblages… restent sur Autodesk ou ShareCAD.
- **Autodesk** (fidélité maximale, configuration requise) : tous les formats via APS / Model Derivative.
- **ShareCAD** (tiers gratuit, sans conversion) : `.dwg`, `.dxf`, `.dwf`, `.step`, `.iges`, `.stl`, `.sldprt`, `.sat`, `.x_t`, `.x_b` affichés via le plugin iframe `iframe.sharecad.org`, sans compte ni conversion. Le fichier est téléchargé et stocké sur les serveurs ShareCAD (limite 50 Mo) : chargement sur clic explicite uniquement, à réserver aux documents non confidentiels.

Les formats sans conversion GLB ni support ShareCAD (`.rvt`, `.ifc`, `.catpart`, assemblages, …) n’affichent que l’onglet Autodesk ; si Autodesk APS n’est pas configuré, la modale conserve l’écran de téléchargement actuel.

### Aperçu Web via FreeCAD (mode « Web »)

Le Worker exécute le pipeline **FreeCAD → GLB** (style 3Dfindit) :

```text
Navigateur
   ├── GET /api/model3d/status        -> conversion configurée ou non
   ├── GET /api/model3d/glb?path=...  -> Worker : HF (source) → Space → GLB caché
   └── three.js -> modèle 3D interactif (+ X-Model3D-Meta : triangles, bbox…)
```

Le Space par défaut est `ktongue/Rupture` (public, aucun token côté Worker). Pour utiliser un autre Space, définir `MODEL3D_CONVERT_URL` (vide = mode Web désactivé) :

```bash
# wrangler.jsonc (vars) ou .dev.vars en local :
MODEL3D_CONVERT_URL="https://<votre-space>.hf.space"
```

Déployer le Space depuis ce dépôt (sauvegarder l’éventuelle application existante du Space, l’upload écrase son contenu) :

```bash
HF_TOKEN="hf_..." npm run deploy:space -- --space-id <utilisateur>/<space>
```

Par défaut, les fichiers de plus de 25 Mo sont refusés (`MAX_MODEL3D_BYTES`) et les GLB sont mis en cache 7 jours (`MODEL3D_CACHE_TTL`). Le premier appel après une mise en veille du Space peut prendre jusqu’à une minute (réveil + conversion).

### Visualisation 3D avec Autodesk APS (Forge)

Le Worker exécute le pipeline **APS / Model Derivative** :

```text
Navigateur
   ├── GET /api/aps/token          -> jeton public pour le Viewer
   ├── POST /api/aps/view          -> upload OSS + conversion SVF2 (si besoin)
   ├── GET /api/aps/status         -> suivi de la conversion
   └── Viewer Autodesk -> modèle 3D interactif
```

1. **Créer une application Autodesk Platform Services** avec les scopes :
   ```text
   bucket:create bucket:read data:read data:write viewables:read
   ```
2. **Configurer les secrets côté Worker** (jamais dans le frontend) :
   ```bash
   npx wrangler secret put APS_CLIENT_ID
   npx wrangler secret put APS_CLIENT_SECRET
   ```

   Pour le développement local, ajouter dans `.dev.vars` :

   ```bash
   APS_CLIENT_ID="..."
   APS_CLIENT_SECRET="..."
   APS_BUCKET_KEY=""            # optionnel : panier OSS préexistant
   ```

3. **Autoriser le domaine Autodesk dans la CSP statique** de `public/_headers` : le domaine `https://developer.api.autodesk.com` est déjà inclus dans `script-src`, `style-src`, `img-src`, `media-src`, `frame-src`, `connect-src`, `font-src` et `worker-src`. Si `public/_headers` est modifié, conserver ces domaines (ainsi que `https://iframe.sharecad.org` en `frame-src` pour l’onglet ShareCAD).

Le Worker crée automatiquement un panier OSS temporaire (`*.transient`) s’il n’en existe pas, téléverse le fichier depuis Hugging Face, puis lance une conversion vers **SVF2**. Les conversions sont mises en cache (Cache API + Workers KV éventuel) par fichier : un fichier déjà converti est réutilisé sans nouvel appel. Les paniers `transient` d’Autodesk peuvent expirer ; les conversions sont alors relancées automatiquement. Par défaut, les fichiers de plus de 100 Mo sont refusés (`MAX_APS_UPLOAD_BYTES`).

### Limites du convertisseur Autodesk et formats fiables

Autodesk **Model Derivative** ne prend pas en charge toutes les versions des formats natifs. Par exemple, un `.SLDPRT` créé avec une version de SolidWorks plus récente que celle supportée par le service produit l’erreur `The Version of the file ... is not supported`. Le site affiche alors un message explicite proposant le téléchargement.

Pour un aperçu 3D fiable, privilégier les formats d’échange largement supportés :

| Format | Recommandation |
|---|---|
| `.step` / `.stp` | ✅ très fiable |
| `.iges` / `.igs` | ✅ très fiable |
| `.obj` | ✅ très fiable |
| `.stl` | ✅ très fiable (sans couleurs) |
| `.dwg` / `.dxf` | ✅ généralement fiable |
| `.rvt` / `.ifc` | ✅ pour le BIM |
| `.ipt` / `.sldprt` / `.sldasm` | ⚠️ version du logiciel à compatibilité limitée |

S’il s’agit d’un fichier SolidWorks récent non supporté, l’exporter en **STEP** (ou OBJ/STL) puis le ré-ajouter au bucket permet de le visualiser.

> Le Viewer Autodesk télécharge ses assets depuis `https://developer.api.autodesk.com` ; le token complet n’est jamais partagé avec le navigateur, seul un jeton public limité au scope `viewables:read` (renvoyé par `/api/aps/token`) lui est transmis. Les succès en cache sont revérifiés via le manifeste avant réutilisation : si l’objet a expiré du panier `transient` (24 h), la traduction est relancée automatiquement.

## Clés et secrets

Le bucket actuel est public : **aucune clé Hugging Face n’est requise**.

Si le bucket devient privé, créer un token Hugging Face en lecture seule puis l’enregistrer comme secret Worker :

```bash
npx wrangler secret put HF_TOKEN
```

Pour le développement local uniquement :

```bash
cp .dev.vars.example .dev.vars
# modifier .dev.vars, qui est ignoré par Git
npm run dev:worker
```

Règles importantes :

- ne jamais mettre le token dans `src/`, `public/`, Git ou une variable préfixée par `VITE_` ;
- le JavaScript du frontend est téléchargé et donc visible par tous ;
- le code du Worker est exécuté chez Cloudflare et n’est pas envoyé au navigateur ;
- les valeurs créées avec `wrangler secret put` sont chiffrées et accessibles uniquement via `env.HF_TOKEN` côté Worker ;
- un token HF ne constitue pas à lui seul un contrôle d’accès utilisateur : si le bucket privé doit rester réservé à certains étudiants, ajouter une authentification (par exemple Cloudflare Access) devant `/api/*`.

Pour un déploiement CI GitHub, stocker `CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ACCOUNT_ID` dans les **GitHub Actions Secrets**, jamais dans le dépôt.

## API du Worker

| Route | Rôle |
|---|---|
| `GET /api/health` | état et configuration publique du service |
| `GET /api/tree?prefix=GM/3A%20GM` | contenu immédiat d’un dossier |
| `GET /api/index` | index compact récursif : documents, `counts` par dossier et `totalFiles` |
| `GET /api/counts?prefix=GM` | effectifs extraits du JSON d’index (`X-Data-Source: index-json`) |
| `GET /api/file?path=...` | aperçu/stream d’un document |
| `GET /api/file?path=...&download=1` | téléchargement avec `Content-Disposition: attachment` |
| `GET /api/file/<chemin>` | même document via une URL « propre » sans query string (iframe ShareCAD) |
| `GET /api/aps/token` | jeton public Autodesk pour la visionneuse 3D |
| `POST /api/aps/view?path=...` | prépare le fichier 3D : OSS + conversion SVF2 |
| `GET /api/aps/status?path=...` | état et progression de la conversion 3D |
| `GET /api/model3d/status` | conversion GLB FreeCAD configurée ou non |
| `GET /api/model3d/glb?path=...&quality=...` | GLB converti via FreeCAD (mis en cache, métadonnées `X-Model3D-Meta`) |
| `GET /api/office/status` | conversion PDF Office configurée ou non |
| `GET /api/office/pdf?path=...` | PDF converti via LibreOffice (mis en cache) |
| `GET /api/link/preview?url=...` | aperçu enrichi d’un lien `.url` (Open Graph, mis en cache) |

L’en-tête `X-Cache-Status` permet de diagnostiquer le comportement : `HIT`, `KV-HIT`, `MISS`, `BYPASS-RANGE` ou `BYPASS-SIZE`. L’en-tête `X-Data-Source: index-json` confirme qu’une réponse d’effectifs provient bien du JSON d’index et non d’un nouveau parcours Hugging Face.

### Comptage des documents

Le bucket n’est parcouru récursivement qu’au **premier** `GET /api/index` d’un datacenter :

1. le Worker liste tous les objets du bucket ;
2. `countFilesByDirectory` calcule le nombre de fichiers de chaque dossier ;
3. `counts` (chemin → nombre) et `totalFiles` sont écrits **dans le document d’index** ;
4. ce document part au Cache API, et dans Workers KV si le binding existe.

Le frontend charge ce JSON une fois au démarrage (`useIndexCatalog`). L’accueil, les cartes d’espaces, l’explorateur et la recherche lisent ensuite les mêmes valeurs : **changer de dossier ne déclenche aucun recomptage**, seule la liste du dossier est demandée à `/api/tree` (elle-même cachée). Pendant le tout premier index, l’interface affiche « Indexation… ».

### Script de comptage de référence

`scripts/count-bucket-files.mjs` parcourt réellement le bucket Hugging Face, recalcule l’effectif de chaque dossier ainsi que la taille cumulée, et affiche le total officiel déclaré par l’API. C’est l’outil de diagnostic quand l’interface affiche « 0 ressource » ou « Nombre indisponible » partout :

```bash
npm run count:files                                    # structure complète du bucket
npm run count:files -- --prefix "GM/3A GM"             # un sous-arbre seulement
npm run count:files -- --json index-reel.json          # document d’index recalculé
npm run count:files -- --compare https://enise-docs.example.workers.dev
```

`--compare` télécharge le `/api/index` du site (ou lit un fichier JSON local) et liste les dossiers dont l’effectif servi diffère du contenu réel ; le code de sortie vaut **2** en cas d’écart, ce qui permet de l’utiliser en CI.

Si le script trouve des fichiers alors que le site en affiche 0, le document d’index servi a été calculé pendant la création du bucket (bucket alors vide) puis mis en cache. Trois façons de l’invalider :

1. **Redéployer avec une nouvelle version de clés** (recommandé, fonctionne aussi sur `*.workers.dev`) : incrémenter `CACHE_KEY_VERSION` dans `worker/index.js` puis `npm run deploy`. Le Worker utilise des clés de cache personnalisées que la « purge par URL » du tableau de bord ne peut pas atteindre ; changer la version rend les anciennes entrées orphelines (elles expirent seules).
2. **Purge Everything** au niveau de la zone Cloudflare (Caching → Purge Cache → Purge Everything), uniquement si le site est rattaché à un domaine personnalisé. C’est la seule purge du tableau de bord qui vide aussi le Cache API des Workers. Inutile si le site est servi depuis `*.workers.dev` (pas de zone).
3. **Attendre l’expiration naturelle** : 12 h pour l’index (`INDEX_CACHE_TTL`). Aucun namespace KV n’est configuré par défaut, donc rien à purger côté KV.

Après purge, vérifier que `/api/index` repart en `X-Cache-Status: MISS` et que `totalFiles` correspond au bucket (voir aussi `npm run count:files -- --compare <url-du-site>`).

## Commandes utiles

```bash
npm run lint         # ESLint
npm test             # tests Node du Worker et des utilitaires
npm run build        # build Vite
npm run check        # lint + tests + build
npm run count:files  # comptage de référence des fichiers du bucket HF
npm audit            # audit des dépendances
```

## Structure

```text
src/                 interface React
worker/index.js      proxy, sécurité et stratégie Cache API
scripts/             comptage de référence des fichiers du bucket (diagnostic)
public/              logos, drapeau, favicon et en-têtes Cloudflare
wrangler.jsonc       configuration de déploiement
.dev.vars.example    exemple de secrets locaux, sans valeur réelle
tests/               tests unitaires
```

## Identité et mentions

Le logo Centrale Lyon ENISE provient de la [charte des marques Centrale Lyon](https://www.ec-lyon.fr/centrale-lyon/le-fil-dinformation/charte-graphique-et-marques-centrale-lyon). Le logo ENSPY provient de l’écosystème officiel de l’Université de Yaoundé I. Le drapeau est un SVG local respectant les couleurs nationales.

Ce frontend est présenté comme un **projet étudiant indépendant et non officiel**. Les marques et documents restent la propriété de leurs ayants droit.
