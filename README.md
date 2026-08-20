# ENISE Docs

Bibliothèque étudiante moderne pour les ressources de **Centrale Lyon ENISE**, avec un lien visuel vers l’**ENSPY** et le Cameroun. Les fichiers restent dans le bucket public Hugging Face [`ktongue/ENISE-SITE`](https://huggingface.co/buckets/ktongue/ENISE-SITE) ; Cloudflare sert le frontend et réduit les appels à Hugging Face grâce à son cache Edge.

## Ce qui est inclus

- frontend React responsive, accessible et en français ;
- identité blanche « liquid glass », verte, rouge et jaune ;
- icônes React (`react-icons`) et logos locaux optimisés ;
- navigation par dossier, fil d’Ariane, tri, grille/liste ;
- aperçu PDF, image, audio, vidéo et texte ;
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

Les fichiers ne sont ajoutés au Cache API que si une réponse complète possède une taille connue inférieure ou égale à **25 Mio**. Les requêtes `Range` et les fichiers plus grands sont transmis sans mise en cache par le Worker (`BYPASS-RANGE` ou `BYPASS-SIZE`) ; le CDN de Hugging Face peut néanmoins les optimiser.

> Le **Cache API est un cache temporaire propre au datacenter Cloudflare qui reçoit la requête**. Ce n’est ni une base globale durable, ni Workers KV. Un premier visiteur dans une autre région peut donc provoquer un nouveau MISS. Le site fonctionne ainsi sans aucune base. Une couche Workers KV facultative peut cependant partager les métadonnées entre régions (voir plus bas) ; les fichiers binaires restent dans le Cache API/Hugging Face.

## Démarrage local

Prérequis : Node.js 20.19 ou plus récent.

```bash
npm install
npm run dev
```

`npm run dev` lance Vite sur `http://localhost:3000`. Sans Worker local, l’interface utilise automatiquement les données d’aperçu si `/api` est indisponible.

Pour tester le frontend **et** le Worker :

```bash
npm run dev:worker
```

Le site complet est alors disponible sur `http://localhost:8787`.

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
