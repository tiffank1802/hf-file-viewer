---
title: ENISE Document Indexer
emoji: 📚
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: Préconversion incrémentale Docling du corpus ENISE
---

# ENISE Document Indexer

Ce Space est un **service d'administration batch**. Il préconvertit les documents connus de `ktongue/ENISE-SITE` avec Docling et publie les résultats structurés dans `ktongue/ENISE-SITE-DERIVED`. Il ne fournit aucun convertisseur à la demande aux visiteurs.

L'ancien rôle LibreOffice / FreeCAD / CAO / SolidWorks du Space `ktongue/Rupture` est supprimé. L'image ne contient aucun de ces outils.

## Fonctionnement

1. un scan complet du bucket source démarre au réveil du Space ;
2. le catalogue durable du bucket dérivé est chargé ;
3. seuls les documents nouveaux, modifiés, échoués encore retentables, ou produits avec une ancienne version du pipeline sont sélectionnés ;
4. chaque document est téléchargé isolément, converti, publié puis supprimé du disque temporaire ;
5. `manifest.json` est publié en dernier et sert de barrière de publication ;
6. `reader/v1/catalog.json` et `reader/v1/status.json` permettent la reprise et le diagnostic ;
7. une boucle relance le scan périodiquement **tant que le Space est réveillé**.

Le Space gratuit se met en veille. La boucle périodique n'est donc pas un cron garanti. Le scan au démarrage assure la reprise au prochain réveil ; l'API administrative permet aussi de déclencher un passage explicite.

## Configuration du Space

### Secret obligatoire

| Nom | Description |
| --- | --- |
| `HF_TOKEN` | jeton Hugging Face avec écriture sur `ktongue/ENISE-SITE-DERIVED` et lecture de la source |

Le script `scripts/deploy-space.js` peut copier son `HF_TOKEN` de déploiement dans le secret homonyme du Space avec `--configure-hf-token`. Ne placez jamais ce jeton dans le dépôt.

### Secret facultatif

| Nom | Description |
| --- | --- |
| `SYNC_TOKEN` | protège `POST /api/sync` et `POST /api/stop`; sans lui, ces routes sont désactivées |

### Variables

| Nom | Défaut | Rôle |
| --- | --- | --- |
| `SOURCE_BUCKET_ID` | `ktongue/ENISE-SITE` | bucket à scanner |
| `DERIVED_BUCKET_ID` | `ktongue/ENISE-SITE-DERIVED` | bucket des artefacts |
| `PIPELINE_VERSION` | `docling-2.130.0-enise-reader-v1` | invalide tous les artefacts lorsque la logique change |
| `AUTO_SYNC_ON_START` | `1` | scan au démarrage |
| `SYNC_INTERVAL_SECONDS` | `21600` | intervalle entre scans, minimum 300 s |
| `MAX_DOCUMENTS_PER_RUN` | `0` | limite par passage, 0 = totalité |
| `MAX_SOURCE_BYTES` | `262144000` | taille maximale d'une source |
| `MAX_ATTEMPTS` | `3` | tentatives automatiques pour un artefact inchangé |
| `CATALOG_FLUSH_EVERY` | `10` | fréquence des checkpoints durables |
| `DERIVED_BUCKET_PRIVATE` | `0` | visibilité lors de la création du bucket dérivé |
| `IMAGE_SCALE` | `2.0` | résolution des figures extraites |
| `SUPPORTED_EXTENSIONS` | voir `reader_pipeline.py` | allowlist de formats Docling |

Les formats Office historiques (`.doc`, `.xls`, `.ppt`, `.rtf`) ne sont pas dans l'allowlist : leur prise en charge Docling nécessiterait LibreOffice, volontairement absent. Ils sont à migrer une fois vers OOXML ou PDF avant ingestion.

## Artefacts

```text
reader/v1/
├── catalog.json
├── status.json
└── documents/
    └── <slug-source>/
        └── <artifact-id>/
            ├── manifest.json      # publié en dernier
            ├── document.json      # blocs normalisés + provenance + assets
            ├── docling.json       # document Docling complet
            ├── content.md         # export lisible
            ├── chunks.jsonl       # unités pour recherche / IA contextuelle
            └── assets/
                └── figure-*.webp
```

`artifact-id` dépend du chemin, de la signature de l'objet source et de `PIPELINE_VERSION`. Une nouvelle source ou une nouvelle version crée donc un préfixe immuable ; le catalogue ne référence l'artefact qu'après publication réussie.

## API d'administration

- `GET /` : tableau de bord de progression ;
- `GET /api/health` : santé et configuration, sans secret ;
- `GET /api/status` : progression non sensible, sans secret ;
- `POST /api/sync?retry_failed=1` : lance un scan, `Authorization: Bearer $SYNC_TOKEN` ;
- `POST /api/stop` : arrêt coopératif après le document courant ;
- `GET /api/docs` : schéma OpenAPI.

Exemple :

```bash
curl -X POST \
  -H "Authorization: Bearer $SYNC_TOKEN" \
  "https://ktongue-rupture.hf.space/api/sync?retry_failed=true"
```

## Sécurité et exploitation

- aucune route n'accepte un document ou un chemin fourni par un visiteur ;
- les secrets ne figurent jamais dans l'état public ni dans les artefacts ;
- une seule synchronisation peut tourner dans le processus ;
- le traitement est séquentiel afin de borner RAM et disque sur `cpu-basic` ;
- une erreur de document est enregistrée puis le corpus continue ;
- un arrêt brutal peut refaire au plus les éléments depuis le dernier checkpoint, sans publier d'artefact incomplet comme prêt ;
- les artefacts plus anciens ne sont pas supprimés automatiquement : ils peuvent être purgés séparément après vérification du catalogue.

Le premier démarrage peut télécharger les modèles Docling. Pour un corpus de grande taille, un Space gratuit devra rester réveillé longtemps ou être temporairement placé sur un matériel plus rapide. La reprise évite néanmoins de recommencer les documents déjà publiés.
