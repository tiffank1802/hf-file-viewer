# Plan du lecteur interactif IA — expérience inspirée d’alphaXiv

**Version : 28 septembre 2026**

**Statut : lots R0–R4 implémentés — provisioning Appwrite, validation Go et déploiement en cours (28 septembre 2026)**

**Portée prioritaire : documents PDF déjà préconvertis par Docling**

## 1. Objectif produit

Faire évoluer l’aperçu actuel en un espace de lecture plein écran où le document n’est plus un contenu passif :

- sélectionner un mot, une phrase, un paragraphe, une formule ou une zone ;
- demander à l’IA d’expliquer, simplifier, traduire ou replacer la sélection dans son contexte ;
- créer un surlignage ou une note privée attachée au passage ;
- naviguer par plan, page, tableau, figure et citation ;
- cliquer une citation IA pour revenir exactement au passage source ;
- conserver les annotations malgré le rechargement de la page ;
- continuer à lire le fichier original si l’artefact Docling n’est pas prêt.

L’inspiration alphaXiv concerne l’expérience de lecture — document central, navigation structurée, assistant latéral, sélection et commentaires ancrés — sans chercher à reproduire dès le départ son réseau social, ses profils publics ou ses fonctions de découverte scientifique.

## 2. Décisions d’architecture

### 2.1 Ne pas utiliser un `<iframe>` comme lecteur principal

L’iframe PDF actuelle convient à un aperçu, mais pas à une interaction fine : le PDF est rendu par le lecteur natif du navigateur, dont la couche texte, les événements de sélection et les coordonnées ne sont pas contrôlés de façon portable par React.

Le lecteur interactif utilisera donc :

- **PDF.js** pour les PDF : rendu fidèle, pages, zoom, couche texte sélectionnable et calques de surlignage ;
- un **rendu React des blocs Docling** pour les documents non PDF et, plus tard, comme mode « lecture structurée » des PDF ;
- l’iframe actuelle uniquement comme fallback temporaire si PDF.js échoue.

Le mot « frame » désigne ici une disposition applicative plein écran, pas un élément HTML `<iframe>`.

### 2.2 Vue hybride, pas remplacement du document original

Deux représentations restent synchronisées :

1. **Vue originale** : PDF.js préserve mise en page, formules, figures et numéros de page.
2. **Vue structurée** : Docling apporte titres, blocs, tableaux, légendes, assets, chunks et provenances.

Le PDF est la surface de lecture initiale. Docling sert à comprendre la structure, à ancrer les interactions et à alimenter l’IA. Un bouton pourra ensuite basculer vers une vue HTML accessible.

### 2.3 Les artefacts restent préconvertis

Le lecteur ne contacte jamais le Space pour convertir un document. Il consomme uniquement :

```text
reader/v1/catalog.json
manifest.json
document.json
chunks.jsonl côté serveur
assets/*
```

Si l’entrée n’est pas `ready`, le fichier original reste lisible et l’interface affiche un mode dégradé. Aucun visiteur ne déclenche de conversion.

### 2.4 L’IA reste côté serveur

Le navigateur transmet une question, un scope documentaire et une ancre bornée. Il n’envoie jamais le document complet, une clé fournisseur ou tous les chunks.

Le backend :

1. valide le document et l’`artifactId` ;
2. vérifie que la citation sélectionnée existe dans les blocs ;
3. récupère le bloc ciblé, ses voisins et les chunks utiles ;
4. appelle le fournisseur IA ;
5. diffuse une réponse SSE avec citations vérifiables.

## 3. Expérience utilisateur cible

### 3.1 Disposition bureau

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Retour · Titre · page/zoom · recherche · mode PDF/structuré · fermer│
├──────────────┬───────────────────────────────┬───────────────────────┤
│ Plan         │                               │ Assistant / Notes     │
│              │        Document              │                       │
│ Sections     │        PDF.js                │ Question courante     │
│ Figures      │        + text layer          │ Réponse citée         │
│ Tables       │        + highlights          │ Historique document   │
│ Annotations  │                               │ Annotations privées   │
├──────────────┴───────────────────────────────┴───────────────────────┤
│ progression · état Docling · artefact · page                         │
└──────────────────────────────────────────────────────────────────────┘
```

Largeurs indicatives :

- navigation : 220 à 260 px, repliable ;
- document : colonne flexible, jamais inférieure à 520 px sur bureau ;
- panneau droit : 340 à 420 px, redimensionnable ;
- barre supérieure : 48 à 56 px.

### 3.2 Tablette et mobile

- document plein écran ;
- plan et assistant dans des tiroirs latéraux ou une bottom sheet ;
- barre de sélection au-dessus du passage ou en bas de l’écran ;
- boutons tactiles d’au moins 44 px ;
- conservation de la page et de la sélection quand un panneau s’ouvre.

### 3.3 Menu de sélection

Après une sélection valide :

```text
[ Expliquer ] [ Simplifier ] [ Traduire ] [ Poser une question ]
[ Surligner ] [ Ajouter une note ] [ Copier le lien ]
```

Actions IA initiales :

- **Expliquer** : définition et rôle du passage dans la section ;
- **Simplifier** : reformulation pédagogique sans perdre les termes techniques ;
- **Traduire** : français ↔ langue détectée ;
- **Exemple** : illustration ou application, clairement distinguée du contenu source ;
- **Relier au cours** : rappeler les prérequis présents dans le même document ;
- **Poser une question** : joindre la sélection au composeur sans envoyer immédiatement.

### 3.4 Navigation depuis les réponses IA

Une citation `[S3]` doit :

1. activer le document et l’artefact correspondants ;
2. ouvrir la page ;
3. faire défiler jusqu’au bloc ou à la boîte ;
4. surligner temporairement le passage ;
5. afficher la section et la page dans une infobulle.

## 4. Parcours fonctionnels

### 4.1 Ouvrir le lecteur

```text
Bibliothèque
  → aperçu du fichier
  → « Ouvrir dans le lecteur » ou « Étudier »
  → /read?path=<sourcePath>&page=<n>
```

Le lecteur demande d’abord les métadonnées de résolution. Le PDF peut commencer à se charger en parallèle par requêtes Range. Le panneau IA n’attend pas que toutes les pages soient rendues.

### 4.2 Expliquer une sélection

```text
Sélection dans la text layer PDF.js
  → normalisation de la citation
  → calcul page + rectangles + préfixe/suffixe
  → rapprochement avec les blocs Docling de la page
  → affichage du menu
  → clic « Expliquer »
  → POST /api/chat avec scope.anchor
  → récupération bloc + voisins + chunks
  → SSE scope/citations/delta/done
  → réponse dans le panneau droit
```

### 4.3 Ajouter une note

```text
Sélection
  → « Ajouter une note »
  → choix couleur/type + texte
  → enregistrement Appwrite par l’API Go
  → calque de surlignage
  → repère dans la marge et dans l’onglet Notes
```

### 4.4 Ouvrir une annotation ancienne

```text
Chargement du document
  → récupération des annotations utilisateur
  → même artifactId : ancrage direct
  → nouvel artifactId : tentative de migration
  → confiance insuffisante : annotation « à vérifier »
```

## 5. Architecture frontend proposée

```text
src/reader/
├── DocumentWorkspace.jsx
├── ReaderHeader.jsx
├── ReaderSidebar.jsx
├── ReaderStatus.jsx
├── pdf/
│   ├── PdfReader.jsx
│   ├── PdfPage.jsx
│   ├── PdfTextLayer.jsx
│   └── PdfHighlightLayer.jsx
├── structured/
│   ├── StructuredReader.jsx
│   ├── BlockRenderer.jsx
│   ├── TableBlock.jsx
│   ├── FigureBlock.jsx
│   └── FormulaBlock.jsx
├── selection/
│   ├── SelectionToolbar.jsx
│   ├── selectionAnchor.js
│   └── anchorMatcher.js
├── assistant/
│   ├── DocumentAssistant.jsx
│   ├── SelectionContextCard.jsx
│   └── ReaderCitationLink.jsx
└── annotations/
    ├── AnnotationLayer.jsx
    ├── AnnotationEditor.jsx
    └── AnnotationList.jsx
```

### 5.1 `DocumentWorkspace`

Responsable de :

- la route et le document actif ;
- l’`artifactId` épinglé ;
- la page, le zoom et le mode de rendu ;
- la sélection courante ;
- l’ouverture des panneaux ;
- la synchronisation citations ↔ document ;
- le fallback vers `PreviewModal` en cas d’échec fatal.

### 5.2 `PdfReader`

Basé sur `pdfjs-dist` et configuré avec un worker servi par la même origine. Il doit :

- charger le PDF via la route fichier existante compatible Range ;
- rendre seulement les pages proches du viewport ;
- exposer une vraie couche texte ;
- conserver l’échelle et la rotation par page ;
- poser un calque séparé pour les annotations ;
- émettre `pagechange`, `selectionchange` et `visibleblockschange`.

### 5.3 `StructuredReader`

Rend les blocs sans `dangerouslySetInnerHTML` :

- titres avec niveaux accessibles ;
- paragraphes et listes ;
- tableaux HTML navigables au clavier ;
- figures provenant du préfixe d’artefact ;
- légendes et texte alternatif ;
- formules avec représentation texte au minimum, puis KaTeX si la source le permet ;
- attributs `data-block-id`, `data-page` et `data-artifact-id`.

### 5.4 Réutilisation de l’existant

- `CitationLink.jsx` devient la base de `ReaderCitationLink` ;
- le flux SSE de `src/services/chat.js` reste utilisé ;
- `LibraryChat` reste l’assistant global de bibliothèque ;
- le mode document est extrait progressivement dans `DocumentAssistant` ;
- `PreviewModal` conserve le mode léger et propose l’entrée dans le lecteur ;
- le package Go `internal/reader` reste la source de normalisation et récupération.

## 6. Contrat du document de lecture

Le navigateur ne doit pas recevoir `chunks.jsonl`. Les chunks restent côté serveur. Un DTO dédié et borné est nécessaire :

```json
{
  "schemaVersion": "reader-ui/v1",
  "sourcePath": "GM/3A/cours.pdf",
  "artifactId": "artifact-1",
  "pipelineVersion": "docling-…",
  "title": "Cours de mécanique",
  "kind": "pdf",
  "status": "ready",
  "capabilities": {
    "pdf": true,
    "structured": true,
    "selectionAI": true,
    "annotations": true
  },
  "outline": [
    {
      "blockId": "b-intro",
      "label": "Introduction",
      "level": 1,
      "page": 2
    }
  ],
  "pageCount": 24,
  "artifactVersion": "artifact-1"
}
```

Les blocs sont chargés par page ou fenêtre d’ordinal afin de ne pas envoyer un `document.json` de plusieurs dizaines de mégaoctets au navigateur.

## 7. API Go à ajouter

### 7.1 Résolution et lecture

```text
GET /api/reader/document?path=<sourcePath>
GET /api/reader/page?path=<sourcePath>&artifactId=<id>&page=<n>
GET /api/reader/blocks?path=<sourcePath>&artifactId=<id>&from=<n>&limit=<n>
GET /api/reader/asset?path=<sourcePath>&artifactId=<id>&asset=<assetId>
```

`GET /api/reader/document` renvoie métadonnées, plan, capacités et version. `page` et `blocks` permettent une lecture progressive. `asset` ne sert que les fichiers déclarés dans le manifest courant.

La route fichier existante continue de servir le PDF avec `Range`, `ETag` et contrôle du chemin.

### 7.2 IA ancrée

Le contrat existant de `/api/chat` est étendu :

```json
{
  "message": "Explique ce passage",
  "intent": "explain-selection",
  "scope": {
    "type": "document",
    "sourcePath": "GM/3A/cours.pdf",
    "artifactId": "artifact-1",
    "anchor": {
      "blockId": "b-energy",
      "page": 4,
      "quote": "L’énergie cinétique dépend…",
      "prefix": "Dans ce cas, ",
      "suffix": " lorsque la vitesse augmente.",
      "start": 12,
      "end": 48,
      "rects": [
        { "x": 0.14, "y": 0.32, "w": 0.48, "h": 0.025 }
      ]
    }
  }
}
```

Coordonnées normalisées entre 0 et 1 dans le repère visuel de la page. Le backend ne leur fait pas confiance pour le texte : il vérifie `quote`, `blockId`, page et artefact.

Ordre de récupération :

1. bloc sélectionné ;
2. parent logique et titres ;
3. bloc précédent et suivant ;
4. chunks couvrant ces blocs ;
5. chunks complémentaires répondant à la question ;
6. budget de contexte et citations comme dans le flux actuel.

### 7.3 Annotations

```text
GET    /api/annotations?path=<sourcePath>&artifactId=<id>
POST   /api/annotations
PATCH  /api/annotations/<id>
DELETE /api/annotations/<id>
```

Toutes ces routes nécessitent une session utilisateur. Les opérations passent par Go ; le navigateur n’obtient aucune clé Appwrite d’administration.

## 8. Ancre de sélection robuste

Une ancre ne doit pas dépendre d’un seul offset fragile. Elle combine quatre sélecteurs :

```json
{
  "documentKey": "sha256-du-sourcePath",
  "artifactId": "…",
  "blockId": "b-…",
  "textQuote": {
    "exact": "passage sélectionné",
    "prefix": "texte avant",
    "suffix": "texte après"
  },
  "textPosition": {
    "start": 12,
    "end": 31
  },
  "pdfPosition": {
    "page": 4,
    "rects": []
  }
}
```

### 8.1 Création de l’ancre

1. refuser une sélection hors de la surface documentaire ;
2. borner la sélection, par exemple 2 à 2 000 caractères ;
3. normaliser espaces et césures sans modifier la citation affichée ;
4. calculer les rectangles de `Range.getClientRects()` ;
5. déterminer la page PDF ;
6. chercher les blocs Docling de cette page ;
7. préférer une correspondance exacte ;
8. sinon utiliser préfixe/suffixe, recouvrement lexical et proximité géométrique ;
9. attribuer une confiance ;
10. ne pas inventer de `blockId` si la confiance est insuffisante.

### 8.2 Résolution et migration

Ordre de résolution :

1. `artifactId + blockId + offsets` ;
2. citation exacte dans le même bloc ;
3. citation exacte sur la même page ;
4. préfixe/suffixe et similarité dans les blocs voisins ;
5. position PDF si le texte est absent ;
6. état `needs-review` sous le seuil de confiance.

Une annotation n’est jamais déplacée silencieusement vers un passage approximatif.

## 9. Modèle Appwrite proposé

Nouvelle table `annotations` :

| Champ | Type | Rôle |
| --- | --- | --- |
| `userId` | string courte | propriétaire |
| `documentKey` | string 64 | hash stable du chemin |
| `sourcePath` | string longue | chemin lisible |
| `artifactId` | string | révision ancrée |
| `blockId` | string, nullable | bloc Docling |
| `page` | integer, nullable | page PDF |
| `anchorJson` | string longue | quote, offsets, rectangles, contexte |
| `kind` | enum | highlight, note, question, bookmark |
| `color` | enum | palette bornée |
| `body` | string longue | note utilisateur |
| `status` | enum | active, needs-review, archived |
| `createdAt` | datetime | création |
| `updatedAt` | datetime | modification |

Index recommandés :

- `documentKey + artifactId + updatedAt` ;
- `userId + updatedAt` si nécessaire pour le tableau de bord ;
- aucun index unique sur `sourcePath`, qui peut être long.

Permissions Appwrite : lecture, modification et suppression par le propriétaire uniquement pour le MVP.

## 10. Sécurité et confidentialité

### 10.1 Validation serveur

- normaliser `sourcePath` avec les règles existantes ;
- exiger que le document appartienne à l’index source ;
- refuser un `artifactId` obsolète avec `409` ;
- refuser les `assetId` absents du manifest ;
- borner question, citation, préfixe, suffixe et note ;
- vérifier que la citation existe dans le document épinglé ;
- ne jamais injecter la note utilisateur comme instruction système ;
- filtrer les citations IA inconnues comme aujourd’hui.

### 10.2 Rendu sûr

- ne pas rendre le Markdown Docling avec `dangerouslySetInnerHTML` ;
- échapper le texte, légendes et noms de fichiers ;
- contrôler les URL d’assets ;
- préserver la CSP ;
- servir le worker PDF.js depuis la même origine ;
- ne jamais exposer les clés IA ou Appwrite.

### 10.3 Données utilisateur

- ne pas journaliser le texte complet des notes ou sélections ;
- journaliser seulement taille, type d’action, statut d’ancrage et latence ;
- permettre la suppression d’une annotation et, plus tard, l’export utilisateur ;
- distinguer explicitement annotations privées et futurs commentaires partagés.

## 11. Performance

### 11.1 PDF

- téléchargement Range, pas chargement binaire complet obligatoire ;
- worker PDF.js hors thread principal ;
- rendu des pages visibles et d’une marge de deux pages ;
- annulation des rendus sortis loin du viewport ;
- cache des miniatures et conservation limitée des canvas ;
- résolution progressive du texte et des blocs.

### 11.2 Docling

- catalogue : cache court avec stale fallback ;
- manifest et artefact immuables : cache long par `artifactId` ;
- blocs envoyés par page/fenêtre ;
- assets chargés paresseusement ;
- chunks conservés côté serveur ;
- aucune campagne d’embeddings requise pour le MVP.

### 11.3 Objectifs indicatifs

Sur connexion normale et cache chaud :

- shell du lecteur visible en moins de 1 s ;
- première page exploitable en moins de 2,5 s pour un PDF courant ;
- menu de sélection en moins de 100 ms ;
- création locale du surlignage immédiate, sauvegarde asynchrone ;
- premier événement SSE IA en moins de 3 s hors latence du fournisseur.

## 12. États et erreurs visibles

| État | Interface |
| --- | --- |
| `ready` | PDF + structure + IA + annotations |
| `conversion-pending` | PDF original, sélection locale, IA limitée/fallback |
| `artifact-failed` | PDF original et message non bloquant |
| `artifact-oversized` | PDF original ; structure indisponible |
| `artifact-conflict` | proposer de recharger la nouvelle révision |
| PDF illisible | proposer téléchargement/ouverture externe |
| fournisseur IA indisponible | conserver sélection et proposer de relancer |
| utilisateur déconnecté | surlignage temporaire ou invitation à se connecter pour sauvegarder |

La lecture ne doit jamais être bloquée par l’IA ou les annotations.

## 13. Tests

### 13.1 Backend Go

- résolution catalogue/manifeste et cache ;
- pagination des blocs ;
- validation de chaque asset ;
- chemin traversant refusé ;
- conflit d’`artifactId` ;
- citation exacte acceptée ;
- citation inventée refusée ;
- récupération bloc → voisins → chunks ;
- permissions annotation par propriétaire ;
- migration marquée `needs-review` sous le seuil.

### 13.2 Frontend unitaire

- construction d’une ancre depuis une sélection ;
- normalisation des césures PDF ;
- rectangles normalisés quelle que soit l’échelle ;
- correspondance citation/bloc ;
- menu inaccessible hors document ;
- restauration des highlights ;
- citation IA → page/bloc ;
- réduction des panneaux sur mobile.

### 13.3 End-to-end navigateur

Ajouter Playwright avec un petit PDF fixture connu :

1. ouvrir le lecteur ;
2. aller à la page 2 ;
3. sélectionner une phrase ;
4. cliquer « Expliquer » ;
5. observer `scope`, `citations`, `delta`, `done` ;
6. cliquer `[S1]` ;
7. vérifier page et highlight ;
8. créer une note ;
9. recharger ;
10. vérifier sa restauration.

Tester Chromium, Firefox et WebKit, plus un viewport mobile.

### 13.4 Accessibilité

- ordre de tabulation stable ;
- commandes nommées ;
- sélection et note utilisables au clavier ;
- plan avec niveaux de titres ;
- tableaux navigables ;
- contraste des couleurs de surlignage ;
- annonce non intrusive des deltas IA ;
- préférence `prefers-reduced-motion`.

## 14. Découpage de livraison

### Lot R0 — socle et fixtures — 2 à 3 jours

- ajouter `pdfjs-dist` et une fixture PDF ;
- définir `reader-ui/v1` et `anchor/v1` ;
- créer la route `/read` derrière un feature flag ;
- mettre en place tests unitaires et premier scénario Playwright ;
- conserver `PreviewModal` inchangé comme fallback.

**Sortie :** workspace vide navigable et contrats validés.

### Lot R1 — lecteur PDF plein écran — 5 à 7 jours

- PDF.js, worker, Range et virtualisation ;
- page, zoom, ajustement largeur et rotation ;
- plan Docling ;
- synchronisation plan ↔ page ;
- chargement progressif des blocs de page ;
- responsive de base.

**Sortie :** lecture PDF contrôlée par React, sans IA.

### Lot R2 — sélection et ancres — 4 à 6 jours

- détection de sélection ;
- menu contextuel ;
- quote/prefix/suffix/offsets/rectangles ;
- rapprochement avec les blocs Docling ;
- calque de highlight temporaire ;
- deep links page/bloc.

**Sortie :** une sélection reste identifiable et navigable.

### Lot R3 — IA sur sélection — 3 à 5 jours

- étendre `chatAnchor` ;
- validation serveur de la citation ;
- récupération forcée du bloc et de ses voisins ;
- panneau `DocumentAssistant` ;
- actions Expliquer/Simplifier/Traduire/Question ;
- citations ramenant au passage.

**Sortie MVP :** « ouvrir → sélectionner → expliquer → citer → revenir au passage ».

### Lot R4 — annotations privées — 5 à 7 jours

- table Appwrite ;
- CRUD API Go ;
- surlignages et notes ;
- panneau de liste ;
- restauration ;
- gestion de révision et `needs-review`.

**Sortie :** annotations privées persistantes.

### Lot R5 — lecture structurée — 5 à 8 jours

- renderer titres/paragraphes/listes ;
- tableaux et figures ;
- légendes et formules ;
- bascule PDF/structuré ;
- sélection native par `blockId` ;
- formats non PDF déjà convertis.

**Sortie :** lecteur Docling accessible et multi-format.

### Lot R6 — durcissement et déploiement progressif — 4 à 6 jours

- performance longs PDF ;
- navigateurs et mobile ;
- accessibilité ;
- reprise réseau et erreurs ;
- métriques sans contenu utilisateur ;
- documentation et activation progressive.

**Estimation :** MVP R0–R3 en 3 à 4 semaines ; lecteur complet R0–R6 en 6 à 8 semaines pour une personne, hors correction d’artefacts Docling atypiques.

## 15. Déploiement progressif

1. feature flag réservé aux administrateurs ;
2. cinq à dix PDF `ready` représentatifs : texte, formule, tableau, figure, scan OCR ;
3. mesure des temps de première page et taux d’ancrage ;
4. activation pour tous les PDF `ready` avec bouton « Nouveau lecteur » ;
5. maintien de l’aperçu historique pendant au moins une version ;
6. lecteur interactif par défaut quand les critères sont atteints ;
7. extension aux formats non PDF via la vue structurée.

Aucun changement ne doit interrompre le lecteur actuel pendant cette montée en charge.

## 16. Observabilité

Mesures sans texte utilisateur :

- ouverture lecteur et type de document ;
- temps shell, première page et structure ;
- taux `ready`/fallback ;
- longueur de sélection ;
- taux d’ancrage exact/approximatif/échoué ;
- action choisie ;
- latence et échec IA ;
- clic sur citation ;
- sauvegarde et migration d’annotation ;
- erreurs PDF.js par navigateur.

## 17. Risques et parades

| Risque | Parade |
| --- | --- |
| texte PDF.js différent du texte Docling | quote + contexte + page + géométrie + score |
| formules mal sélectionnées | ancre géométrique et bloc Docling, puis support MathML/LaTeX |
| scans OCR sans text layer fiable | overlay Docling/OCR en phase structurée |
| très longs documents | pages et blocs virtualisés, chunks côté serveur |
| annotation déplacée après reconversion | `artifactId`, migration scorée, `needs-review` |
| injection de prompt dans le document | preuves traitées comme données, validation et prompt existant |
| panneau droit trop étroit | redimensionnement, mode focus, tiroir mobile |
| dépendance IA bloquante | lecture et notes toujours disponibles |
| régression de l’aperçu actuel | feature flag et fallback explicite |

## 18. Hors périmètre initial

- commentaires publics et fils communautaires ;
- mentions, abonnements et notifications ;
- édition collaborative temps réel ;
- génération massive de résumés ;
- embeddings de tout le corpus ;
- comparaison automatique de tous les documents ;
- conversion déclenchée par un visiteur ;
- remplacement immédiat de tous les viewers Office/3D.

Ces fonctions pourront être ajoutées après stabilisation du lecteur privé et des ancres.

## 19. Critères d’acceptation du MVP

- [ ] Un PDF `ready` s’ouvre dans une route plein écran sans iframe native.
- [ ] Le plan Docling navigue vers la bonne page.
- [ ] Le texte peut être sélectionné à la souris, au tactile et au clavier.
- [ ] Le menu propose au minimum Expliquer, Question et Surligner.
- [ ] La requête IA contient `sourcePath`, `artifactId` et une ancre bornée.
- [ ] Le backend vérifie que la citation appartient au document.
- [ ] La réponse IA cite uniquement des preuves connues.
- [ ] Un clic sur une citation revient à la page et au passage.
- [ ] Le PDF reste lisible si Docling ou l’IA est indisponible.
- [ ] Aucun secret et aucun document complet ne partent du navigateur vers un fournisseur.
- [ ] Le lecteur historique reste disponible comme fallback.
- [ ] Les tests end-to-end couvrent le flux sélection → IA → citation.

## 20. Première tranche recommandée

Commencer uniquement par deux PDF `ready` : un cours textuel et un document avec tableaux/figures.

La première tranche verticale doit être :

```text
PreviewModal
  → Ouvrir dans le lecteur
  → PDF.js + plan Docling
  → sélectionner une phrase sur une seule page
  → Expliquer
  → /api/chat scope.anchor
  → réponse SSE [S1]
  → clic [S1]
  → retour page + highlight temporaire
```

Cette tranche verticale a servi de base au lot R4 d’annotations privées. La vue structurée multi-format et les commentaires partagés restent différés jusqu’à la validation en production du rendu PDF, de l’ancrage Docling, des réponses IA vérifiables et de la restauration des annotations.
