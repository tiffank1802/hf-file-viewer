# Pipeline documentaire ENISE

> **Architecture active depuis le 28 septembre 2026** : le Space `ktongue/Rupture` est un préprocesseur batch Docling. Les anciennes instructions FreeCAD / LibreOffice de ce document ont été retirées : elles ne correspondent plus au Space déployé.

## Objectif

Tous les documents étant déjà connus dans `ktongue/ENISE-SITE`, ils sont préparés avant la visite. L'utilisateur final lit les résultats et ajoute ses annotations ; il ne déclenche jamais de conversion.

```text
Storage Bucket source
ktongue/ENISE-SITE (~55 Go)
        │
        │ inventaire récursif + comparaison au catalogue
        ▼
Docker Space ktongue/Rupture
Docling 2.130.0 · traitement séquentiel
        │
        │ artefacts immuables, manifest publié en dernier
        ▼
Storage Bucket dérivé
ktongue/ENISE-SITE-DERIVED
```

## Composants

```text
space-huggingface/
├── Dockerfile             # Python + Docling, sans LibreOffice/FreeCAD
├── requirements.txt       # versions du runtime
├── app.py                 # API, planificateur, verrou, tableau de bord
├── reader_pipeline.py     # scan, conversion, reprise et publication
└── README.md              # variables et exploitation

scripts/
├── deploy-space.js        # remplacement atomique du Space + pruning distant
└── README_DEPLOYMENT.md   # procédure opérateur

tests/
├── deploy-space.test.js   # commit NDJSON et suppressions
└── test_reader_pipeline.py# signatures, sélection incrémentale et réglages
```

## Cycle d'une synchronisation

1. vérifier le secret `HF_TOKEN` ;
2. ouvrir ou créer le bucket dérivé ;
3. charger `reader/v1/catalog.json` ;
4. lister récursivement le bucket source ;
5. ne garder que les extensions autorisées ;
6. calculer une identité à partir du chemin, de la taille, de la date, du hash Xet et de `PIPELINE_VERSION` ;
7. ignorer les artefacts prêts et identiques ;
8. télécharger une source dans `/tmp` ;
9. convertir avec Docling (OCR, structure, tableaux et figures) ;
10. écrire le document normalisé et les chunks ;
11. publier tous les payloads ;
12. publier `manifest.json` en dernier ;
13. pointer le catalogue vers l'artefact prêt ;
14. supprimer les fichiers temporaires ;
15. poursuivre même si un autre document échoue.

Le catalogue est checkpointé régulièrement. Après une interruption, le dernier petit groupe peut être refait, mais les artefacts publiés gardent la même identité et aucun visiteur ne voit un artefact partiel comme prêt.

## Formats

Allowlist par défaut :

```text
.pdf .docx .pptx .xlsx .odt .ods .odp
.html .htm .md .txt .csv .adoc .asciidoc .tex .epub
.eml .msg .vtt
.png .jpg .jpeg .tif .tiff .webp .bmp
```

Les formats Office historiques `.doc`, `.xls`, `.ppt` et `.rtf` sont exclus : les prendre en charge imposerait LibreOffice, volontairement supprimé du Space. Ils doivent être migrés une fois vers PDF ou OOXML.

Les fichiers CAO/3D ne sont pas traités par Docling. La visualisation 3D du site repose sur Autodesk APS, ShareCAD ou un éventuel service distinct configuré explicitement. `MODEL3D_CONVERT_URL` est vide par défaut.

## Contrat d'artefact

```text
reader/v1/documents/<slug>/<artifact-id>/
├── manifest.json
├── document.json
├── docling.json
├── content.md
├── chunks.jsonl
└── assets/figure-*.webp
```

- `docling.json` conserve la structure riche native ;
- `document.json` propose des blocs stables, provenance, tableaux et liens vers les figures ;
- `chunks.jsonl` prépare la recherche et l'IA contextuelle ;
- les figures WebP servent au futur lecteur interactif ;
- `manifest.json` contient les versions, empreintes, chemins et compteurs.

L'identité de l'artefact change lorsque la source ou le pipeline change. Les anciens préfixes restent immuables tant qu'une politique de rétention séparée ne les purge pas.

## Automatisation

- scan au démarrage : `AUTO_SYNC_ON_START=1` ;
- boucle pendant l'éveil : `SYNC_INTERVAL_SECONDS=21600` ;
- commande protégée : `POST /api/sync`, secret `SYNC_TOKEN` ;
- arrêt coopératif : `POST /api/stop` ;
- exclusion mutuelle : une seule synchronisation par processus ;
- serveur Uvicorn : un seul worker pour éviter plusieurs planificateurs.

Un Space gratuit endormi n'exécute rien. Le scan de démarrage et l'état durable offrent une reprise fiable, mais pas une horloge permanente.

## Déploiement

```bash
export HF_TOKEN="hf_..."
export SYNC_TOKEN="..." # facultatif
npm run deploy:space
```

Le script cible `ktongue/Rupture`, configure le runtime, inventorie l'arbre distant et pousse **un seul commit** contenant :

- les cinq fichiers utiles ;
- les suppressions de tous les autres chemins, sauf `.gitattributes`.

C'est ce mécanisme qui retire réellement les anciens `CAL_IA.py`, fichiers de calcul, helpers FreeCAD, configurations et caches Python distants.

## Tests

```bash
npm test
python3 -m unittest tests/test_reader_pipeline.py
python3 -m py_compile space-huggingface/app.py space-huggingface/reader_pipeline.py
```

Un test Docker complet est recommandé avant le premier déploiement :

```bash
docker build -t enise-docling-indexer space-huggingface

docker run --rm -p 7860:7860 \
  -e HF_TOKEN \
  -e AUTO_SYNC_ON_START=0 \
  enise-docling-indexer
```

Puis :

```bash
curl http://localhost:7860/api/health
curl http://localhost:7860/api/status
```

## Suite côté application

Le Space ne doit plus recevoir de fonctionnalités visiteurs. La suite se trouve dans le site et le backend :

1. lire `catalog.json`, `document.json` et les assets ;
2. afficher pages, blocs, figures et provenance ;
3. enregistrer des annotations ancrées sur les identifiants de blocs ;
4. fournir à l'IA les chunks proches du passage sélectionné ;
5. gérer la migration d'une annotation lorsque `artifact-id` change.

Le plan détaillé est dans [`docs/INTERACTIVE_DOCUMENT_READING_PLAN.md`](docs/INTERACTIVE_DOCUMENT_READING_PLAN.md).
