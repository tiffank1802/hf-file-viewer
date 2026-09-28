# Déployer le préprocesseur Docling dans `ktongue/Rupture`

Le script [`deploy-space.js`](./deploy-space.js) réaffecte le Space existant à la préconversion documentaire. Il ne déploie plus LibreOffice, FreeCAD, SolidWorks ou un convertisseur CAO.

## Ce que fait le déploiement

1. vérifie `HF_TOKEN` et l'accès au Space ;
2. crée le Space Docker `cpu-basic` uniquement s'il n'existe pas ;
3. installe `HF_TOKEN` comme secret du runtime afin que le Space puisse écrire dans le bucket dérivé ;
4. configure les variables source, destination, version et planification ;
5. inventorie **tous** les fichiers distants de la branche `main` ;
6. envoie un commit NDJSON atomique qui :
   - écrit l'allowlist Docling ;
   - supprime chaque fichier distant hors allowlist ;
7. attend l'état `RUNNING` ;
8. le Space lance automatiquement son scan incrémental.

Allowlist :

```text
Dockerfile
requirements.txt
app.py
reader_pipeline.py
README.md
```

`.gitattributes` est conservé s'il existe. Tout autre chemin est supprimé, y compris `CAL_IA.py`, `ELEMENT.txt`, `NODE.txt`, `U.txt`, `config.yaml`, les anciens helpers FreeCAD et `__pycache__/`.

## Prérequis

- Node.js 20.19+ ;
- un token Hugging Face `write` autorisé à modifier `ktongue/Rupture`, lire `ktongue/ENISE-SITE`, créer ou écrire `ktongue/ENISE-SITE-DERIVED` ;
- le secret ne doit jamais être écrit dans un fichier du dépôt.

```bash
export HF_TOKEN="hf_..."
# facultatif : protège POST /api/sync et POST /api/stop
export SYNC_TOKEN="une-valeur-longue-et-aleatoire"
npm run deploy:space
```

La cible par défaut est volontairement fixe :

```text
ktongue/Rupture
```

Une cible de test reste possible :

```bash
HF_TOKEN="hf_..." npm run deploy:space -- --space-id utilisateur/indexer-test
```

## Options

| Option | Effet |
| --- | --- |
| `--space-id namespace/nom` | autre cible ; défaut `ktongue/Rupture` |
| `--private` | rend privé un Space nouvellement créé |
| `--skip-files` | configure le runtime sans commit |
| `--no-prune` | conserve les fichiers distants historiques ; à éviter en production |
| `--skip-hf-token-secret` | n'installe pas le token de déploiement dans le runtime |
| `--skip-variables` | ne modifie pas les variables du Space |

`--no-prune` existe comme garde de diagnostic, mais ne satisfait pas le remplacement demandé. Le déploiement normal doit garder le nettoyage actif.

## Commit atomique et suppression réelle

Le Hub reçoit une requête vers :

```text
POST /api/spaces/<namespace>/<space>/commit/main
Content-Type: application/x-ndjson
```

Elle contient un en-tête, cinq opérations `file` et une opération `deletedFile` pour chaque chemin obsolète. Le nouveau code et les suppressions appartiennent ainsi à une seule révision Git du Space. Un simple upload de dossier ne suffirait pas : il laisserait les anciens fichiers distants absents du checkout.

Les tests couvrent explicitement ce contrat :

```bash
node --test tests/deploy-space.test.js
```

## Secrets installés

### `HF_TOKEN`

Par défaut, le token utilisé pour déployer est envoyé à l'endpoint de secrets du Space. Sa valeur est write-only et n'est jamais affichée dans les logs. Si l'organisation utilise un token runtime plus restreint, l'installer manuellement dans Settings puis lancer avec `--skip-hf-token-secret`.

### `SYNC_TOKEN`

Il n'est créé que si la variable locale existe lors du déploiement. Sans ce secret, les commandes manuelles sont refusées ; le scan au démarrage et la boucle automatique restent actifs.

## Variables installées

```text
SOURCE_BUCKET_ID=ktongue/ENISE-SITE
DERIVED_BUCKET_ID=ktongue/ENISE-SITE-DERIVED
PIPELINE_VERSION=docling-2.130.0-enise-reader-v1
AUTO_SYNC_ON_START=1
SYNC_INTERVAL_SECONDS=21600
MAX_SOURCE_BYTES=15728640
HUB_OPERATION_RETRIES=5
HUB_RETRY_BASE_SECONDS=2
```

Les autres réglages utilisent les valeurs documentées dans [`../space-huggingface/README.md`](../space-huggingface/README.md).

## Vérifier après déploiement

```bash
curl https://ktongue-rupture.hf.space/api/health
curl https://ktongue-rupture.hf.space/api/status
```

L'arbre distant ne doit plus contenir les convertisseurs historiques :

```bash
curl -H "Authorization: Bearer $HF_TOKEN" \
  "https://huggingface.co/api/spaces/ktongue/Rupture/tree/main?recursive=true&expand=false"
```

Le bucket dérivé doit finir par contenir :

```text
reader/v1/catalog.json
reader/v1/status.json
reader/v1/documents/...
```

Pour déclencher une reprise protégée :

```bash
curl -X POST \
  -H "Authorization: Bearer $SYNC_TOKEN" \
  "https://ktongue-rupture.hf.space/api/sync?retry_failed=true"
```

## Limite de planification des Spaces gratuits

La boucle (`SYNC_INTERVAL_SECONDS`) ne tourne que pendant que le Space est réveillé. Elle n'est pas un cron externe et ne garantit pas un passage à heure fixe. En revanche :

- chaque démarrage lance un scan ;
- le catalogue du bucket dérivé permet la reprise ;
- seuls les objets nouveaux, modifiés ou invalidés par `PIPELINE_VERSION` sont repris ;
- le bouton/API d'administration peut réveiller un passage ;
- aucun visiteur du site ne demande une conversion.

Pour un traitement initial de plusieurs dizaines de gigaoctets, le pipeline trie d'abord les sources par taille et limite la première vague à **15 Mio par fichier**. Les documents plus lourds restent visibles comme `oversized` et pourront être repris par paliers (par exemple 30, puis 60 Mio) après stabilisation. Chaque document est publié immédiatement puis retiré de l'espace temporaire.
