# Plan de lecture documentaire interactive

**Version : 28 septembre 2026 — architecture Space Docling automatisée**

## 1. Décision d'architecture

Le corpus est déjà connu. Aucun visiteur ne doit attendre ni déclencher une conversion.

Le Space Hugging Face existant `ktongue/Rupture` est réaffecté entièrement à la préconversion Docling :

```text
ktongue/ENISE-SITE
        │
        │ scan au démarrage et passages périodiques
        │ comparaison signature source + version pipeline
        ▼
ktongue/Rupture
Docker · Docling · batch séquentiel et reprenable
        │
        │ publication sûre, manifest en dernier
        ▼
ktongue/ENISE-SITE-DERIVED
        │
        ├── catalogue/version/état
        └── artefacts structurés + figures + chunks
                 │
                 ▼
Cloudflare / API Go / React
lecture, annotations et IA contextuelle uniquement
```

Cette décision remplace le scénario d'exécution locale sur le PC de l'administrateur. Le poste local ne sert plus qu'au développement et au déploiement.

## 2. Principes non négociables

1. **Préconversion** : les documents sont transformés avant leur consultation.
2. **Aucun upload visiteur vers le Space** : le navigateur ne connaît aucune route de conversion.
3. **Idempotence** : une source inchangée avec la même version pipeline n'est jamais recalculée.
4. **Reprise durable** : l'état utile vit dans le bucket dérivé, pas seulement sur le disque éphémère du Space.
5. **Publication atomique au niveau document** : le manifest prêt est publié après tous les payloads.
6. **Publication résiliente** : les erreurs transitoires Hub/Xet sont retentées avec backoff exponentiel.
7. **Isolation des erreurs** : un document défectueux n'arrête pas le corpus.
8. **Mémoire bornée** : un document est téléchargé, converti, publié puis supprimé.
9. **Versionnement explicite** : changer `PIPELINE_VERSION` invalide les artefacts sans modifier la source.
10. **Séparation des responsabilités** : Docling produit ; le site lit et annote ; l'IA consomme des chunks.
11. **Aucun héritage CAO dans le Space** : LibreOffice, FreeCAD, SolidWorks et les anciennes routes sont supprimés.

## 3. Portée des formats

### 3.1 Formats préparés

Allowlist initiale :

```text
.pdf
.docx .pptx .xlsx .odt .ods .odp
.html .htm .md .txt .csv .adoc .asciidoc .tex .epub
.eml .msg .vtt
.png .jpg .jpeg .tif .tiff .webp .bmp
```

Docling extrait :

- texte et hiérarchie ;
- titres, listes et paragraphes ;
- tableaux ;
- provenance, page et boîte englobante lorsque disponibles ;
- figures en WebP ;
- export Docling natif ;
- Markdown ;
- chunks destinés à la recherche et à l'IA.

### 3.2 Formats explicitement exclus du Space

```text
.doc .xls .ppt .rtf
.step .stp .iges .igs .stl .obj
.sldprt .sldasm et autres formats CAO
```

Les anciens formats Office binaires exigeraient LibreOffice. Ils doivent être migrés une fois vers PDF ou OOXML. Les formats 3D relèvent d'Autodesk APS, ShareCAD ou d'un autre service distinct ; `ktongue/Rupture` ne leur est plus dédié.

## 4. Composants implémentés

### 4.1 Image Docker

`space-huggingface/Dockerfile` part de Python 3.11 et installe seulement les bibliothèques système requises par Docling/OCR. Il ne contient :

- ni LibreOffice ;
- ni FreeCAD ;
- ni helper SolidWorks ;
- ni convertisseur CAO.

Uvicorn utilise un seul worker. Plusieurs workers lanceraient plusieurs planificateurs concurrents.

### 4.2 API et planificateur

`space-huggingface/app.py` expose :

| Route | Authentification | Rôle |
| --- | --- | --- |
| `GET /` | publique | tableau de bord opérateur, sans secret |
| `GET /api/health` | publique | santé et présence de la configuration |
| `GET /api/status` | publique | progression non sensible |
| `POST /api/sync` | Bearer `SYNC_TOKEN` | déclenchement administratif |
| `POST /api/stop` | Bearer `SYNC_TOKEN` | arrêt coopératif |
| `GET /api/docs` | publique | OpenAPI |

Le planificateur lance :

- un passage au démarrage si `AUTO_SYNC_ON_START=1` ;
- un passage tous les `SYNC_INTERVAL_SECONDS` tant que le Space est réveillé ;
- aucune seconde synchronisation tant que le verrou est pris.

Si `SYNC_TOKEN` est absent, les routes mutatives sont fermées ; l'automatisation continue.

### 4.3 Moteur batch

`space-huggingface/reader_pipeline.py` réalise :

1. ouverture ou création du bucket dérivé ;
2. chargement du catalogue ;
3. inventaire récursif du bucket source ;
4. filtrage par extension ;
5. comparaison des signatures et versions ;
6. téléchargement d'un seul objet ;
7. conversion Docling ;
8. normalisation des blocs ;
9. extraction des figures ;
10. chunking hybride ou fallback déterministe ;
11. upload des payloads ;
12. upload du manifest ;
13. mise à jour périodique du catalogue et de l'état ;
14. nettoyage du répertoire temporaire.

## 5. Identité et invalidation

### 5.1 Signature source

La signature source combine de façon déterministe :

```json
{
  "path": "GM/cours/document.pdf",
  "size": 123456,
  "modified": "2026-09-28T10:00:00Z",
  "hash": "xet-hash-si-disponible"
}
```

Le JSON canonique est hashé en SHA-256.

### 5.2 Identité artefact

```text
artifact-id = sha256(path + NUL + source-signature + NUL + pipeline-version)[0:32]
```

Une modification de contenu, de métadonnées utiles ou de version pipeline produit un nouvel identifiant. Un même calcul redonne le même identifiant.

### 5.3 Slug documentaire

Le préfixe combine :

- un stem nettoyé et borné ;
- douze caractères SHA-256 du chemin complet.

Deux documents homonymes dans des dossiers différents ne se chevauchent pas.

## 6. Contrat du bucket dérivé

```text
reader/v1/
├── catalog.json
├── status.json
└── documents/
    └── <slug-document>/
        └── <artifact-id>/
            ├── manifest.json
            ├── document.json
            ├── docling.json
            ├── content.md
            ├── chunks.jsonl
            └── assets/
                ├── figure-00001.webp
                └── ...
```

### 6.1 `catalog.json`

Index courant par chemin source :

```json
{
  "schemaVersion": "enise-reader/v1",
  "pipelineVersion": "docling-2.130.0-enise-reader-v1",
  "sourceBucket": "ktongue/ENISE-SITE",
  "derivedBucket": "ktongue/ENISE-SITE-DERIVED",
  "updatedAt": "2026-09-28T12:00:00Z",
  "documents": {
    "GM/cours/document.pdf": {
      "sourcePath": "GM/cours/document.pdf",
      "sourcePresent": true,
      "sourceSignature": "…",
      "artifactId": "…",
      "artifactPrefix": "reader/v1/documents/…/…",
      "manifestPath": "reader/v1/documents/…/…/manifest.json",
      "pipelineVersion": "docling-2.130.0-enise-reader-v1",
      "status": "ready",
      "attempts": 1,
      "blockCount": 84,
      "assetCount": 3,
      "chunkCount": 12,
      "updatedAt": "2026-09-28T11:59:00Z"
    }
  }
}
```

États documentaires :

- `ready` : manifest publié ;
- `failed` : erreur et nombre de tentatives conservés ;
- `oversized` : source supérieure à la limite ;
- `sourcePresent=false` : source disparue du dernier inventaire.

### 6.2 `manifest.json`

Le manifest contient :

- identité et version ;
- chemin, taille, date et empreinte source ;
- liste des payloads ;
- compteurs de blocs, assets et chunks ;
- horodatage de publication ;
- état `ready`.

Il est envoyé **après** les autres fichiers. Le catalogue ne le référence qu'après cet envoi.

### 6.3 `document.json`

Contrat normalisé :

```json
{
  "schemaVersion": "enise-reader/v1",
  "artifactId": "…",
  "pipelineVersion": "…",
  "source": {
    "bucket": "ktongue/ENISE-SITE",
    "path": "GM/cours/document.pdf",
    "size": 123456,
    "modified": "…",
    "sha256": "…"
  },
  "title": "document",
  "blocks": [
    {
      "id": "b-…",
      "ordinal": 1,
      "level": 0,
      "type": "section_header",
      "text": "Introduction",
      "selfRef": "#/texts/0",
      "parentRef": null,
      "provenance": []
    }
  ],
  "assets": []
}
```

Les identifiants de blocs servent d'ancres aux annotations. La provenance sert au retour page/zone.

### 6.4 `chunks.jsonl`

Chaque ligne possède un identifiant, du texte et les métadonnées Docling lorsque disponibles. Le fallback groupe les blocs jusqu'à environ 2 400 caractères en conservant leurs identifiants.

## 7. Reprise, échecs et concurrence

### 7.1 Reprise

- le catalogue est stocké dans le bucket dérivé ;
- un checkpoint est envoyé tous les `CATALOG_FLUSH_EVERY` documents ;
- le catalogue final et l'état final sont toujours republiés ;
- le répertoire local est jetable ;
- le dernier petit groupe peut être recalculé après arrêt brutal.

### 7.2 Tentatives

Pour une identité artefact inchangée :

- jusqu'à `MAX_ATTEMPTS` tentatives automatiques ;
- ensuite l'entrée échouée est ignorée lors des scans ordinaires ;
- `POST /api/sync?retry_failed=true` force une nouvelle tentative opérateur ;
- une modification source ou pipeline repart avec une nouvelle identité.

### 7.3 Sources volumineuses

`MAX_SOURCE_BYTES` vaut **15 Mio** pour la première vague sur `cpu-basic`. Les sources sont triées par taille croissante : les documents légers sont donc convertis avant les plus coûteux. Une source au-dessus du seuil est cataloguée `oversized` sans être téléchargée. Après stabilisation, le seuil peut être relevé par paliers contrôlés (par exemple 30 puis 60 Mio).

### 7.4 Concurrence

- verrou process non bloquant ;
- un seul worker Uvicorn ;
- thread batch en arrière-plan ;
- arrêt demandé par événement et appliqué entre deux documents.

## 8. Sécurité

### 8.1 Secrets

- `HF_TOKEN` : obligatoire pour écrire le bucket dérivé ;
- `SYNC_TOKEN` : facultatif, protège les commandes administratives ;
- aucune valeur de secret n'apparaît dans `/api/status`, le HTML, les logs normaux ou les artefacts ;
- le script de déploiement utilise l'API de secrets write-only.

### 8.2 Surface publique

Le Space n'accepte :

- aucun multipart ;
- aucun fichier visiteur ;
- aucun chemin arbitraire à convertir ;
- aucun endpoint LibreOffice/FreeCAD/SolidWorks.

Les seules mutations concernent le lancement ou l'arrêt du scan connu et requièrent `SYNC_TOKEN`.

## 9. Déploiement atomique du Space

Le dépôt distant historique contenait notamment :

```text
CAL_IA.py
ELEMENT.txt
NODE.txt
U.txt
config.yaml
freecad_cad_convert.py
freecad_convert.py
__pycache__/CAL_IA.cpython-312.pyc
```

Un upload classique ne supprime pas les fichiers qui n'existent plus localement. `scripts/deploy-space.js` :

1. récupère l'arbre distant récursif ;
2. calcule `distant - allowlist - { .gitattributes }` ;
3. crée cinq opérations `file` ;
4. crée une opération `deletedFile` par chemin obsolète ;
5. envoie l'ensemble dans un commit NDJSON unique.

Allowlist distante :

```text
Dockerfile
requirements.txt
app.py
reader_pipeline.py
README.md
.gitattributes (préservé, non géré par l'application)
```

Le même script configure :

```text
SOURCE_BUCKET_ID=ktongue/ENISE-SITE
DERIVED_BUCKET_ID=ktongue/ENISE-SITE-DERIVED
PIPELINE_VERSION=docling-2.130.0-enise-reader-v1
AUTO_SYNC_ON_START=1
SYNC_INTERVAL_SECONDS=21600
```

Commande :

```bash
HF_TOKEN="hf_..." SYNC_TOKEN="..." npm run deploy:space
```

## 10. Limite de la boucle Space

`cpu-basic` se met en veille. Conséquences :

- la boucle ne remplace pas un cron externe ;
- un long premier passage exige de garder le Space réveillé ;
- le prochain réveil relance automatiquement l'inventaire ;
- le catalogue empêche de refaire les documents prêts ;
- un déclenchement administratif peut réveiller le service.

Pour accélérer l'initialisation du corpus :

1. mesurer le débit sur 20 à 50 documents représentatifs ;
2. relever RAM, durée et taux d'erreurs par format ;
3. augmenter temporairement le matériel si nécessaire ;
4. garder le traitement séquentiel au début ;
5. n'ajouter du parallélisme qu'après mesure, avec une borne stricte.

## 11. Désactivation des anciens appels à la demande

Le Space réaffecté ne peut plus être utilisé comme convertisseur 3D. Les valeurs par défaut sont donc :

```text
Worker DEFAULT_MODEL3D_CONVERT_URL=""
wrangler MODEL3D_CONVERT_URL=""
Go defaultModel3DURL=""
```

Les routes historiques restent compatibles avec **un autre service explicitement configuré**, mais elles ne pointent jamais vers `ktongue/Rupture` par défaut.

La même règle vaut pour Office : `OFFICE_CONVERT_URL` reste vide sauf service séparé. Le chemin normal est le prétraitement batch.

## 12. Intégration future du lecteur

Le déploiement Docling prépare le contrat de lecture. L'intégration site se fait ensuite sans code de conversion.

### 12.1 Résolution

Pour un chemin source :

1. charger ou mettre en cache `reader/v1/catalog.json` ;
2. trouver l'entrée `ready` ;
3. lire son `manifestPath` ;
4. récupérer `document.json` ;
5. charger les assets à partir du même préfixe.

### 12.2 API de lecture recommandée

```text
GET /api/reader/catalog
GET /api/reader/document?path=<source>
GET /api/reader/asset?path=<source>&asset=<id>
GET /api/reader/chunks?path=<source>
```

Le Worker ou Go doit :

- valider les chemins ;
- mettre en cache catalogue et manifests ;
- renvoyer `404 artifact-not-ready` sans lancer de conversion ;
- ne jamais attendre Docling ;
- exposer la version artefact au frontend.

### 12.3 Lecteur React

Composants proposés :

```text
DocumentReader
├── ReaderToolbar
├── DocumentOutline
├── BlockRenderer
│   ├── ParagraphBlock
│   ├── HeadingBlock
│   ├── TableBlock
│   └── FigureBlock
├── AnnotationLayer
└── ContextAssistant
```

Le viewer doit préserver :

- l'ordre des blocs ;
- les liens bloc → page/boîte ;
- l'identifiant artefact ;
- l'identifiant de bloc ;
- les légendes et figures ;
- un fallback vers le fichier original.

## 13. Annotations

### 13.1 Ancre

```json
{
  "sourcePath": "GM/cours/document.pdf",
  "artifactId": "…",
  "blockId": "b-…",
  "quote": "passage sélectionné",
  "start": 12,
  "end": 31,
  "page": 4,
  "bbox": null
}
```

### 13.2 Enregistrement

Appwrite reste adapté aux annotations utilisateur :

- `userId` ;
- `sourcePath` ;
- `artifactId` ;
- `blockId` ;
- offsets et citation ;
- note ;
- couleur/type ;
- dates de création et modification.

Permissions : lecture/écriture par propriétaire, sauf future fonction explicite de partage.

### 13.3 Migration

Quand l'artefact change :

1. même `blockId` s'il existe ;
2. sinon citation exacte dans les blocs voisins ;
3. sinon similarité de texte + page/provenance ;
4. sinon annotation marquée `needs-review` ;
5. ne jamais déplacer silencieusement une note sans score suffisant.

## 14. IA contextuelle

Le navigateur ne doit pas envoyer tout le document à chaque question.

Contexte recommandé :

1. bloc sélectionné ;
2. blocs précédent/suivant ;
3. chunks dont les métadonnées recouvrent ces blocs ;
4. titre, chemin, page et version ;
5. annotations choisies par l'utilisateur.

Réponse attendue :

- citations par bloc/page ;
- liens permettant de surligner le passage ;
- refus clair si aucun chunk pertinent ;
- conservation de `artifactId` pour rendre la réponse reproductible.

## 15. Observabilité

`status.json` et `/api/status` exposent :

- phase ;
- exécution active ;
- run ID ;
- source courante ;
- total source et total éligible ;
- traités, ignorés, échoués, trop volumineux ;
- dernière erreur bornée ;
- dernière synchronisation réussie ;
- prochain passage théorique ;
- version pipeline.

Alertes recommandées :

- phase `error` ;
- aucun passage réussi depuis 24 h après réveils attendus ;
- hausse du taux d'échec ;
- documents `oversized` ;
- catalogue illisible ;
- version pipeline divergente entre Space et catalogue.

## 16. Tests

### 16.1 Déjà couverts

Tests Node :

- cible par défaut `ktongue/Rupture` ;
- inventaire distant ;
- allowlist ;
- suppression de tous les historiques ;
- préservation de `.gitattributes` ;
- écritures et suppressions dans un commit ;
- endpoints secrets et variables ;
- conversion 3D désactivée par défaut.

Tests Python :

- stabilité des signatures ;
- invalidation par version ;
- collision des noms ;
- filtrage des extensions ;
- réglages sûrs ;
- skip des artefacts prêts ;
- plafond d'échecs et reprise forcée.

### 16.2 À ajouter avec l'intégration du lecteur

- fixtures PDF/DOCX/PPTX/XLSX ;
- validation JSON Schema des artefacts ;
- upload interrompu avant manifest ;
- source modifiée pendant un run ;
- cache catalogue Worker/Go ;
- document non prêt sans déclenchement ;
- ancrage et migration des annotations ;
- citations IA vers les bons blocs ;
- tests navigateur du lecteur et des figures.

## 17. Critères d'acceptation

### Space

- [x] Docker Docling remplace l'ancienne application.
- [x] Aucun paquet LibreOffice/FreeCAD n'est installé.
- [x] Les helpers historiques ne figurent plus dans l'allowlist.
- [x] Le déploiement calcule les suppressions distantes.
- [x] Écritures et suppressions partent dans un commit unique.
- [x] Scan au démarrage et boucle périodique.
- [x] Endpoint manuel authentifié.
- [x] Verrou anti-concurrence.

### Pipeline

- [x] Source et destination configurables.
- [x] Détection nouveau/modifié/version obsolète.
- [x] Reprise via catalogue durable.
- [x] Tentatives et erreurs par document.
- [x] Publication manifest en dernier.
- [x] Traitement séquentiel et nettoyage local.
- [x] Blocs, figures, Markdown, Docling JSON et chunks.

### Application

- [x] `ktongue/Rupture` n'est plus la valeur 3D par défaut.
- [x] Aucun déclenchement de préconversion ajouté au navigateur.
- [ ] Ajouter les routes de lecture du bucket dérivé.
- [ ] Ajouter le lecteur React interactif.
- [ ] Ajouter annotations Appwrite.
- [ ] Brancher l'IA sur les chunks et les ancres.

### Exploitation distante

- [ ] Fournir un `HF_TOKEN` au script de déploiement.
- [ ] Exécuter le commit sur `ktongue/Rupture`.
- [ ] Vérifier que l'arbre distant ne contient plus les 13 historiques.
- [ ] Vérifier/créer `ktongue/ENISE-SITE-DERIVED`.
- [ ] Observer le premier passage et ajuster matériel/limites.

Les cases d'exploitation restent ouvertes tant que le déploiement réel n'a pas été authentifié et vérifié.

## 18. Ordre de livraison

### Lot A — préprocesseur et déploiement

- application Docling ;
- scan incrémental ;
- état durable ;
- publication sûre ;
- remplacement atomique du Space ;
- désactivation de l'URL 3D par défaut.

### Lot B — déploiement et qualification du corpus

- secret runtime ;
- création du bucket dérivé ;
- premier run ;
- rapport par format ;
- correction des cas échoués ;
- estimation complète de durée/coût.

### Lot C — lecture

- API de résolution ;
- lecteur blocs/tables/figures ;
- fallback original ;
- cache des artefacts.

### Lot D — annotations

- schéma Appwrite ;
- sélection de texte ;
- notes et surlignages ;
- migration entre versions.

### Lot E — IA contextuelle

- récupération des chunks ;
- citations ;
- action « expliquer ce passage » ;
- comparaison de documents préconvertis.

## Conclusion

La conversion documentaire n'est plus une fonction interactive du site. C'est une chaîne de préparation de données, durable et versionnée, exécutée dans `ktongue/Rupture`. Le site devient un consommateur d'artefacts : il peut se concentrer sur la qualité de lecture, les annotations et l'IA contextuelle sans faire porter le coût ou le risque de conversion à l'utilisateur final.
