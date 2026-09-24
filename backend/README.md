# Backend Go

API documentaire en Go, **même contrat `/api` que le Worker Cloudflare**. Le frontend React ne change pas : il continue d’appeler `/api/tree`, `/api/index`, `/api/file`, les conversions Office / 3D et Autodesk.

Go n’est pas là pour remplacer le CDN. Il est là pour le chemin qui était lent : le premier parcours du bucket, le changement de dossier, et le proxy de fichiers.

## Pourquoi c’est plus fluide

| Avant (Worker seul, en local) | Avec le processus Go |
|---|---|
| Chaque isolate redémarre à froid | Le processus garde l’index en mémoire |
| Un dossier = un appel Hugging Face | Dossier servi depuis l’index déjà chargé (`X-Cache-Status: INDEX`) |
| Plusieurs onglets relancent le même parcours | Une seule requête en vol (`singleflight`) |
| JSON d’index non compressé par le processus | Réponses JSON gzip si le navigateur l’accepte |
| Fichier recopié par le runtime JS | Flux direct, avec `Range` servi depuis le cache |

Le Worker Cloudflare reste le bon déploiement **en bordure** : il est déjà proche des visiteurs et son Cache API est efficace. Mettre Go *derrière* le Worker ajouterait un saut réseau et ralentirait le site. On ne le fait donc pas.

Go devient l’origine quand on l’exécute soi-même : développement, ou machine dédiée (VPS, Docker) proche des étudiants.

## Prérequis

- Go **1.22+** ([go.dev/dl](https://go.dev/dl/))
- Node.js 20.19+, comme le frontend

Les secrets restent dans `.dev.vars` à la racine, le même fichier que Wrangler. Ils ne sont jamais préfixés par `VITE_`.

## Démarrage

Depuis la racine du dépôt :

```bash
npm install
npm run dev
```

Cela lance :

1. `backend/cmd/enise-api` sur `127.0.0.1:8788` ;
2. Vite sur `http://localhost:3000`, qui proxifie `/api` vers Go.

Le navigateur ne parle qu’à Vite. Pas de CORS, pas de jeton dans le JavaScript.

Commandes utiles :

```bash
npm run dev:api     # API seule
npm run dev:vite    # frontend seul (données d’aperçu si Go est arrêté)
npm run dev:worker  # ancien chemin Wrangler, inchangé
npm run start:go    # build Vite + un seul processus Go qui sert dist/ et /api
```

Santé du service :

```bash
curl -s http://127.0.0.1:8788/api/health
```

`index` vaut `cold`, `ready` ou `stale`. Le premier chargement de l’index part en arrière-plan : l’accueil peut répondre tout de suite, puis les dossiers suivants sortent de la mémoire.

## Ce qui est servi

Les routes sont celles du Worker (`GET /api/tree`, `/api/index`, `/api/counts`, `/api/file`, Office, GLB, SolidWorks, APS, aperçu de lien), plus l’assistant : `GET /api/chat/status` et `POST /api/chat`. Les erreurs restent en français. L’en-tête `X-Backend: go` distingue cette origine du Worker.

Le cache disque est dans `.cache/go-api/` (ignoré par Git). Un redémarrage réaffiche l’index tout de suite, puis le rafraîchit.

## Variables

Mêmes noms que `wrangler.jsonc` / `.dev.vars` :

| Variable | Rôle |
|---|---|
| `HF_BUCKET_ID` | bucket, défaut `ktongue/ENISE-SITE` |
| `HF_TOKEN` | lecture seule, seulement si le bucket devient privé |
| `ADDR` | écoute, défaut `0.0.0.0:8788` (`PORT` est aussi accepté) |
| `CACHE_DIR` | cache disque |
| `STATIC_DIR` | dossier `dist/` à servir avec l’API |
| `OFFICE_CONVERT_URL` | Space LibreOffice, vide = PDF désactivé |
| `MODEL3D_CONVERT_URL` | Space FreeCAD, défaut Rupture, vide = désactivé |
| `SOLIDWORKS_CONVERT_URL` | service HOOPS, vide = désactivé |
| `APS_CLIENT_ID` / `APS_CLIENT_SECRET` | Autodesk, jamais exposés |
| `NVIDIA_API_KEY` | rédaction de l’assistant, jamais envoyée au navigateur. Vide = recherche locale seulement |
| `NVIDIA_API_BASE` | défaut `https://integrate.api.nvidia.com/v1` |
| `NVIDIA_MODEL` | défaut `meta/llama-3.1-8b-instruct` |
| `CHAT_MAX_TOKENS` | jetons accordés à la rédaction, défaut `4096`. Un modèle qui raisonne partage ce budget entre sa réflexion et sa réponse : trop bas, il ne reste plus rien à afficher |
| `CHAT_DEEP_MAX_TOKENS` | idem pour les questions de synthèse (structure d’un examen, comparaison d’annales), défaut `8192` |
| `CHAT_ANSWER_TIMEOUT` | délai total de rédaction en secondes, défaut `150` |
| `CHAT_TRUST_PROXY` | `1` seulement si Go n’est joignable que par le Worker, pour limiter le débit par étudiant et faire confiance à `X-Forwarded-Host` sur les emails de compte |
| `APPWRITE_ENDPOINT` | défaut `https://fra.cloud.appwrite.io/v1` |
| `APPWRITE_PROJECT_ID` | défaut `69cedb12002acdd498e0` |
| `APPWRITE_DATABASE_ID` | défaut `enise_docs`, créé par `npm run appwrite:setup` |
| `APPWRITE_API_KEY` | seulement pour ce script, jamais envoyée au navigateur |
| `APPWRITE_PUBLIC_ORIGIN` | origine des liens d’email, par exemple `https://le-site`. Vide = hôte de la requête, seulement s’il n’est pas usurpé |
| `APPWRITE_ENABLED` | `0` masque le bouton de connexion |

`MODEL3D_CONVERT_URL` absent active Rupture. Une valeur explicitement vide désactive la conversion, comme le Worker.

## Héberger Go à la place du Worker

Utile si les visiteurs sont surtout au même endroit et que l’on veut un cache chaud permanent.

```bash
npm run build
STATIC_DIR=./dist ADDR=0.0.0.0:8788 go -C backend run ./cmd/enise-api
```

Ou l’image `backend/Dockerfile`. Le frontend construit et l’API partagent alors le même port : ShareCAD et le viewer Microsoft continuent de voir une URL publique, comme avec le Worker.

Ne pas publier `HF_TOKEN`, la clé NVIDIA ni les secrets APS dans l’image. Les passer au runtime (`--env-file .dev.vars`).

## Assistant

Le bouton **Assistant** interroge Go, pas le fournisseur directement. Go classe l’index déjà en mémoire, renvoie tout de suite les cartes, lit les extraits (texte, PDF, docx, pptx, xlsx) puis demande une rédaction si une clé est définie. Chaque chemin proposé est un chemin de l’index : un chemin inventé par le modèle n’ouvre pas un fichier.

Deux profils de question :

- **recherche** (« où sont les polys de mécanique ») : deux documents lus, résumé du meilleur ;
- **synthèse** (« comment se structure l’examen d’économie », « compare les annales ») : jusqu’à huit documents du meilleur dossier et cinq extraits lus, avec une consigne qui demande de croiser les sources au lieu d’en résumer une seule.

Les modèles du sélecteur **réfléchissent avant d’écrire**. Leur réflexion arrive dans `reasoning_content`, pas dans `content` : Go la lit, annonce « Le modèle réfléchit… » au navigateur et n’attend que le contenu utile. Le budget de jetons couvre la réflexion **et** la réponse, sinon le modèle s’arrête sur `finish_reason: length` sans rien écrire.

Si un moteur échoue (quota, clé refusée, délai, budget épuisé), Go réessaie une fois avec un budget plus large, puis passe au moteur suivant s’il en reste un. En dernier recours, il répond avec les cartes de documents et une note qui dit la vraie raison : plus jamais un simple « la rédaction automatique a échoué ».

En production Cloudflare, le Worker ne fait pas lui-même l’appel NVIDIA. Sans `GO_API_ORIGIN`, `/api/chat` répond 501. Avec cette variable, il relaie seulement vers le processus Go.

## Compte

Le bouton **Se connecter** parle à Go (`/api/auth/*`). Go ouvre la session Appwrite et pose un cookie `enise_session` HttpOnly. Le mot de passe n’est pas écrit dans une table, et il ne revient jamais dans le JSON.

Les favoris du compte passent par `/api/favorites`. Ils ne sont plus gardés dans le navigateur. La base `enise_docs` et les tables `profiles` et `favorites` se créent une fois :

```bash
# APPWRITE_API_KEY dans .dev.vars, ou devant la commande
npm run appwrite:setup
npm run appwrite:status
```

Le Worker relaie `/api/auth/*` et `/api/favorites` vers `GO_API_ORIGIN` en transmettant le cookie. Sans cette origine, ces routes répondent 501 et le bouton reste masqué.

## Tests

```bash
cd backend && go test ./...
```

Les tests du Worker (`npm test`) restent valables. Le Worker ne contient pas le client NVIDIA : il répond 501, ou relaie vers Go si `GO_API_ORIGIN` est défini.
