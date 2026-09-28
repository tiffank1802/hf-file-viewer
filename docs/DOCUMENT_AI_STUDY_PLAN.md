# Plan d’évolution de l’IA vers un assistant d’étude documentaire

**Date : 28 septembre 2026**  
**Statut : plan d’architecture — compatible avec la conversion Docling en cours**

## 1. Décision proposée

Il ne faut pas choisir entre « le PDF actuel » et « la version convertie ».

La cible est une représentation double :

- le **fichier original** reste la référence visuelle et téléchargeable ;
- l’**artefact Docling** devient la référence sémantique de l’IA : structure, titres, paragraphes, tableaux, figures, pages, provenance et chunks.

```text
                         ┌──────────────────────────────┐
                         │ PDF/Office original          │
                         │ fidélité visuelle, download  │
                         └──────────────┬───────────────┘
                                        │ même sourcePath
                                        │
Navigateur ── question ciblée ──► API Go│
                                        │
                         ┌──────────────▼───────────────┐
                         │ Artefact Docling dérivé      │
                         │ structure + chunks + pages   │
                         └──────────────────────────────┘
```

Pendant la conversion du corpus, l’API adopte une stratégie progressive :

1. **artefact Docling prêt** : étude structurée complète ;
2. **artefact encore absent** : extraction actuelle en mode de secours, clairement signalée comme partielle ;
3. **artefact disponible plus tard** : la prochaine session peut utiliser automatiquement la version structurée, sans modifier le fichier original.

L’objectif fonctionnel est un **chat attaché explicitement à un document**, et non plus seulement un assistant qui cherche des noms de cours.

## 2. Diagnostic de l’assistant actuel

Le code existant constitue une bonne base de transport et de tolérance aux pannes :

- conversations en SSE ;
- choix et repli entre Cloudflare, OpenRouter, NVIDIA et OpenCode ;
- historique Appwrite ;
- classement initial de documents ;
- lecture de plusieurs annales pour certaines questions ;
- réponses locales lorsque les moteurs IA ne répondent pas.

Mais sa compréhension documentaire reste limitée :

1. `backend/internal/chat/retrieve.go` classe principalement les **chemins et noms** du catalogue source ;
2. `backend/internal/chat/extract.go` extrait un texte brut depuis le fichier original ;
3. le backend ne lit qu’un préfixe borné du fichier et au plus quelques milliers de caractères ;
4. la hiérarchie des titres, les pages, les tableaux, les figures et la provenance sont perdus ;
5. certains PDF encodés par glyphes produisent peu ou pas de texte exploitable ;
6. une question ne peut pas fixer formellement « ce document précis » comme espace de recherche ;
7. un résumé long repose sur un extrait, pas sur une couverture mesurée de toutes les sections.

Le résultat est adapté à « où se trouve le cours ? », mais insuffisant pour :

- expliquer un chapitre ;
- faire un résumé fidèle de tout le document ;
- générer une fiche de révision ;
- identifier les définitions, formules et tableaux importants ;
- poser une question sur une page ou un passage sélectionné ;
- justifier chaque réponse avec des citations ouvrables.

## 3. Expérience utilisateur cible

### 3.1 Deux espaces IA complémentaires

#### Assistant bibliothèque

Le panneau actuel reste disponible pour :

- trouver un cours ;
- comparer plusieurs documents ;
- chercher une matière ou une année ;
- suggérer les documents à ouvrir.

#### Assistant du document

Un nouveau panneau **Étudier avec l’IA** apparaît depuis :

- la modale d’aperçu actuelle ;
- une carte de résultat de l’assistant ;
- le futur lecteur Docling interactif ;
- une sélection de texte ou un bloc annoté.

Ce panneau reste attaché à un `sourcePath` validé et, si disponible, à un `artifactId`.

### 3.2 Actions rapides

```text
Résumer le document
Faire une fiche de révision
Afficher le plan détaillé
Expliquer ce passage
Extraire les définitions
Lister les formules et méthodes
Interpréter les tableaux et figures
Créer un quiz
Créer des questions d’examen
Comparer avec un autre document
Poser une question libre
```

Les actions ne doivent être que des intentions structurées. Elles utilisent le même moteur de récupération, les mêmes citations et les mêmes règles de sécurité que le chat libre.

### 3.3 États visibles

| État | Affichage | Capacité IA |
| --- | --- | --- |
| `structured-ready` | « Analyse structurée Docling » | plan, sections, tableaux, figures, citations par bloc/page |
| `source-fallback` | « Lecture partielle du fichier original » | extrait actuel, sans prétendre couvrir tout le document |
| `conversion-pending` | « Version structurée en préparation » | secours actuel et bouton pour revenir plus tard |
| `artifact-failed` | « Analyse structurée indisponible » | fichier original et raison non sensible |
| `unsupported` | « Format non analysable » | métadonnées et téléchargement seulement |

L’IA ne doit jamais présenter un résumé d’extrait comme un résumé exhaustif.

## 4. Architecture cible

```text
React
├── Assistant bibliothèque
└── DocumentStudyPanel
        │
        │ POST /api/chat avec scope explicite
        ▼
Cloudflare Worker
        │ relais vers l’API Go, aucun traitement Docling
        ▼
API Go
├── ArtifactResolver
│   ├── catalogue source
│   ├── reader/v1/catalog.json
│   └── manifest de l’artefact
├── DocumentKnowledgeSource
│   ├── DoclingKnowledgeSource (préféré)
│   └── LegacySourceExtractor (secours actuel)
├── StructuredRetriever
│   ├── plan et sections
│   ├── chunks
│   ├── tableaux/figures
│   └── voisinage des blocs
├── StudyComposer
│   ├── résumé hiérarchique
│   ├── fiche/quiz/glossaire
│   └── questions-réponses citées
└── fournisseurs IA existants
        │
        ├── réponses SSE
        └── cache partagé d’artefacts d’étude
```

Le Space `ktongue/Rupture` reste consacré à la conversion Docling. Il ne doit pas être ralenti par les conversations des visiteurs ou par des appels LLM interactifs.

### 4.1 Répartition explicite des responsabilités

| Couche | Travail | Moment | Stockage |
| --- | --- | --- | --- |
| **Prétraitement déterministe Docling** | téléchargement, OCR, ordre de lecture, titres, paragraphes, tableaux, figures, légendes, pages, boîtes, Markdown, chunks et provenance | en avance pour tous les documents connus | `reader/v1` dans le bucket dérivé |
| **Normalisation déterministe** | joindre `selfRef`, `blockId`, chunks, chemin de titres et pages ; produire éventuellement un petit index lexical | lors de la publication ou sans LLM à partir des artefacts existants | artefact Docling ou sidecar versionné |
| **Enrichissement IA différé** | résumés de sections, résumé global, glossaire, fiche générique, banque de quiz, éventuelle description visuelle des figures | après Docling, à la demande puis en batch | `study/v1` dans le bucket dérivé |
| **Recherche** | résoudre le document ciblé, classer les sections/chunks, ajouter les voisins, respecter le budget de contexte | à chaque question, sans génération de faits | mémoire/cache du backend ; index versionné si utile |
| **Génération à la demande** | répondre, expliquer une sélection, comparer, personnaliser un quiz | interaction utilisateur | flux SSE puis historique privé Appwrite |
| **Données utilisateur** | annotations, progression, résultats de quiz, conversations | interaction utilisateur | Appwrite, jamais le bucket public |

Règles structurantes :

- Docling produit les **faits extractifs et les ancres**, pas des conclusions pédagogiques ;
- une sortie IA ne devient jamais une nouvelle source de vérité sans lien vers les blocs Docling ;
- une image extraite et sa légende sont déterministes, mais une **interprétation visuelle** par modèle multimodal est un enrichissement IA versionné ;
- tous les documents connus doivent passer par Docling, mais il n’est pas nécessaire de pré-générer immédiatement toutes les fiches IA ;
- aucune de ces couches ne demande au visiteur de convertir le document.

## 5. Contrat commun de connaissance

L’API Go doit masquer la différence entre une source Docling et le fallback actuel derrière un contrat commun.

```go
type DocumentKnowledgeSource interface {
    Resolve(ctx, sourcePath string) (DocumentRevision, error)
    Outline(ctx, revision DocumentRevision) ([]Section, error)
    Retrieve(ctx, revision DocumentRevision, query RetrievalQuery) ([]Evidence, error)
    Coverage(ctx, revision DocumentRevision) CoverageReport
}
```

### 5.1 Révision documentaire

```json
{
  "sourcePath": "GM/3A/cours.pdf",
  "sourceSignature": "…",
  "artifactId": "…",
  "pipelineVersion": "docling-2.130.0-enise-reader-v1",
  "knowledgeSource": "docling",
  "manifestPath": "reader/v1/documents/.../manifest.json"
}
```

En mode de secours :

```json
{
  "sourcePath": "GM/3A/cours.pdf",
  "sourceSignature": "size|mtime",
  "artifactId": null,
  "knowledgeSource": "source-fallback"
}
```

### 5.2 Preuve citée

Chaque passage fourni au modèle doit conserver une ancre exploitable par l’interface :

```json
{
  "citationId": "S1",
  "sourcePath": "GM/3A/cours.pdf",
  "artifactId": "…",
  "blockId": "b-…",
  "chunkId": "c-000042",
  "headingPath": ["Chapitre 2", "2.3 Dimensionnement"],
  "page": 17,
  "bbox": { "l": 72, "t": 110, "r": 510, "b": 260 },
  "kind": "paragraph",
  "text": "…"
}
```

Une citation de fallback peut avoir `blockId`, `page` et `bbox` à `null`. L’interface indique alors qu’elle vient d’une lecture partielle.

### 5.3 Écart à normaliser dans les artefacts actuels

Les artefacts déjà produits sont suffisants pour démarrer, mais leur jointure doit être rendue explicite :

- `document.json` donne un `blockId`, un `selfRef` et la provenance brute pour chaque bloc ;
- le chunker de secours écrit directement `blockIds` dans `chunks.jsonl` ;
- le `HybridChunker` écrit actuellement un objet `meta`, dont les références doivent être reliées à `document.blocks[].selfRef` ;
- les numéros de page et boîtes présents dans la provenance Docling doivent être normalisés vers un format stable commun.

Le premier lecteur backend doit donc construire une table :

```text
chunkId -> selfRefs -> blockIds -> headingPath -> pages/bboxes
```

Si les métadonnées d’un chunk hybride ne permettent pas cette jointure, il faut reconstruire ce chunk déterministement depuis `document.json` ou produire un sidecar de citations. Cela ne nécessite ni nouvel appel LLM ni reconversion Docling des documents déjà publiés. Une version ultérieure du pipeline pourra écrire ces champs normalisés directement dans `chunks.jsonl`.

## 6. Résolution progressive des documents

### 6.1 Ordre de résolution

Pour chaque question ciblée :

1. valider `sourcePath` dans le catalogue source ;
2. lire l’entrée correspondante de `reader/v1/catalog.json` ;
3. accepter uniquement `status=ready` ;
4. vérifier `manifest.json` ;
5. charger `document.json` et `chunks.jsonl` ;
6. sinon utiliser l’extracteur actuel, sans lancer Docling ;
7. renvoyer le mode et la couverture au frontend.

### 6.2 Aucun changement silencieux de révision

Une conversation ciblée conserve :

```text
sourcePath + artifactId ou sourceSignature de fallback
```

Si Docling termine pendant une conversation démarrée en fallback, l’interface affiche :

> Une version structurée de ce document est maintenant disponible.

L’utilisateur peut ouvrir une nouvelle session structurée. Le contexte d’une conversation existante ne doit pas changer silencieusement, afin de conserver des citations reproductibles.

### 6.3 PDF original et lecteur structuré

Le futur écran document garde deux vues :

```text
[ Lecture structurée ] [ Original PDF/Office ] [ Étudier avec l’IA ]
```

- **Original** : fidélité graphique et vérification humaine ;
- **Lecture structurée** : accessibilité, navigation et annotations par bloc ;
- **IA** : récupération dans l’artefact structuré et retour vers les deux vues.

La version Docling complète le PDF ; elle ne le remplace pas.

## 7. Récupération structurée dans un document

### 7.1 Première version sans base vectorielle

Il n’est pas nécessaire d’ajouter immédiatement une base d’embeddings. Pour un document explicitement ciblé, un moteur lexical et structurel est plus simple, traçable et peu coûteux.

Pipeline proposé :

1. charger le plan des titres ;
2. tokeniser la question ;
3. scorer les chunks sur le texte, les légendes et le Markdown des tableaux ;
4. renforcer les chunks dont le titre parent correspond à la question ;
5. renforcer les définitions pour une demande « qu’est-ce que » ;
6. renforcer tableaux/formules pour une demande de calcul ou de comparaison ;
7. prendre les chunks voisins afin de ne pas couper une explication ;
8. dédupliquer les preuves ;
9. respecter un budget de contexte ;
10. transmettre les preuves avec leurs ancres.

Un score de type BM25 simplifié peut être implémenté en Go. Les titres, le chemin de section et le type de bloc servent de boosts explicables.

### 7.2 Hiérarchie des sections

`document.json` doit être transformé en arbre :

```text
Document
├── Introduction
├── Chapitre 1
│   ├── 1.1 Définitions
│   └── 1.2 Méthode
└── Chapitre 2
    ├── Tableau de résultats
    └── Conclusion
```

Chaque chunk reçoit :

- le chemin complet de titres ;
- les `blockIds` couverts ;
- la plage de pages ;
- ses tableaux et figures liés ;
- sa position dans la section.

### 7.3 Recherche globale

Pour une question sur toute la bibliothèque :

1. le classement existant choisit des documents candidats par métadonnées ;
2. seuls les artefacts structurés de ces candidats sont interrogés ;
3. les meilleurs passages de chaque document sont comparés ;
4. la réponse cite le document et le passage, pas seulement le chemin.

Cette stratégie à deux niveaux améliore l’assistant sans charger tous les chunks du corpus en mémoire.

### 7.4 Embeddings ultérieurs

Une recherche hybride embeddings + lexical ne doit arriver qu’après mesure de la première version. Options possibles :

- Cloudflare Vectorize si l’infrastructure reste principalement Cloudflare ;
- index autonome préconstruit et versionné dans le bucket ;
- base vectorielle dédiée si le volume et la qualité le justifient.

Les embeddings restent une optimisation de rappel. Les citations continuent de pointer vers les blocs Docling d’origine.

## 8. Résumer réellement tout le document

### 8.1 Limite de l’approche en une requête

Envoyer les premiers milliers de caractères au modèle ne couvre pas :

- les chapitres de fin ;
- les annexes importantes ;
- les tableaux répartis dans le document ;
- les conclusions ;
- les répétitions et progressions pédagogiques.

Un résumé annoncé comme complet doit donc être hiérarchique.

### 8.2 Algorithme map-reduce par sections

#### Étape A — segmentation

- découper selon les titres Docling ;
- regrouper les blocs sans titre par page ou fenêtre de tokens ;
- préserver tableaux, légendes et références aux figures ;
- mesurer le pourcentage de blocs couverts.

#### Étape B — résumé de section

Le modèle produit un JSON contraint :

```json
{
  "sectionId": "sec-…",
  "title": "Dimensionnement",
  "summary": "…",
  "learningObjectives": ["…"],
  "keyConcepts": [
    { "label": "…", "explanation": "…", "citations": ["S12", "S13"] }
  ],
  "definitions": [],
  "formulas": [],
  "methods": [],
  "warnings": [],
  "citations": ["S12", "S13"]
}
```

#### Étape C — synthèse globale

La réduction reçoit les résumés de sections, pas le document brut. Elle génère :

- résumé en 30 secondes ;
- résumé détaillé ;
- plan commenté ;
- objectifs pédagogiques ;
- notions indispensables ;
- méthodes et formules ;
- tableaux/figures à consulter ;
- points ambigus ou mal extraits ;
- citations couvrant plusieurs sections.

#### Étape D — rapport de couverture

```json
{
  "blockCoverage": 0.97,
  "sectionCoverage": 1.0,
  "pagesCovered": 42,
  "pagesTotal": 43,
  "tablesIncluded": 8,
  "figuresIncluded": 5,
  "unreadableBlocks": 3
}
```

Si la couverture est faible, le produit affiche « résumé partiel » au lieu de masquer le problème.

## 9. Artefacts d’étude partagés

Les résultats communs à tous les étudiants peuvent être conservés dans le bucket dérivé, séparément des artefacts Docling :

```text
study/v1/
├── catalog.json
└── documents/
    └── <document-slug>/
        └── <artifact-id>/
            └── <ai-profile-version>/
                ├── manifest.json
                ├── overview.json
                ├── sections.jsonl
                ├── glossary.json
                ├── study-guide.json
                └── quiz-bank.json
```

### 9.1 Version d’analyse indépendante

```text
ai-profile-version = hash(
  schéma + prompts + stratégie de découpage + modèle + paramètres
)
```

Le pipeline Docling et le pipeline IA évoluent indépendamment :

- nouvelle source ou nouveau Docling → nouvel `artifactId` ;
- nouveau prompt ou modèle de synthèse → nouvelle `ai-profile-version` ;
- aucun résultat IA ancien n’écrase silencieusement un nouveau résultat.

### 9.2 Publication sûre

Comme pour Docling :

1. publier les payloads ;
2. valider leur schéma ;
3. publier le manifest IA en dernier ;
4. mettre à jour `study/v1/catalog.json` ;
5. ne servir que les entrées `ready`.

### 9.3 Quand générer ces artefacts

Pendant la conversion du corpus :

- priorité aux questions ciblées utilisant directement `chunks.jsonl` ;
- résumé long généré à la première demande puis mis en cache durable ;
- verrou par `artifactId + intent + ai-profile-version` pour éviter les doublons.

Après stabilisation de Docling :

- pré-générer les fiches des documents les plus consultés ;
- étendre progressivement au corpus ;
- ne pas ajouter ce travail à la boucle Docling tant que sa file n’est pas terminée.

## 10. Évolution de l’API

### 10.1 Conserver `/api/chat`

Le transport SSE, les fournisseurs et l’historique existent déjà. Le plus sûr est d’étendre la requête avec un scope optionnel plutôt que de créer un deuxième système de chat.

```json
{
  "message": "Explique la méthode de la section 3",
  "intent": "explain",
  "scope": {
    "type": "document",
    "sourcePath": "GM/3A/cours.pdf",
    "artifactId": "…",
    "anchor": {
      "blockId": "b-…",
      "start": 12,
      "end": 95,
      "quote": "…"
    }
  },
  "history": [],
  "provider": "cloudflare",
  "model": "…"
}
```

Compatibilité : sans `scope`, la requête garde le comportement bibliothèque actuel.

### 10.2 Événements SSE proposés

```text
event: scope       # révision et mode docling/fallback
event: retrieval   # sections/chunks sélectionnés, sans secret
event: sources     # documents actuels, conservé pour compatibilité
event: citation    # ancres prêtes à ouvrir
event: thinking
event: delta
event: done
```

`done` inclut :

```json
{
  "answer": "…",
  "knowledgeSource": "docling",
  "artifactId": "…",
  "coverage": { "kind": "targeted", "ratio": 0.18 },
  "citations": [],
  "engine": "cloudflare",
  "model": "…"
}
```

`coverage.kind=targeted` signifie que seules les sections pertinentes ont été lues ; `whole-document` est réservé aux résumés hiérarchiques terminés.

### 10.3 Routes de lecture partagées avec le futur lecteur

```text
GET /api/reader/resolve?path=<sourcePath>
GET /api/reader/document?path=<sourcePath>
GET /api/reader/chunks?path=<sourcePath>
GET /api/reader/asset?path=<sourcePath>&asset=<assetId>
GET /api/study/status?path=<sourcePath>
```

Elles ne déclenchent jamais une conversion.

### 10.4 Actions d’étude

```text
POST /api/study/action
```

Corps :

```json
{
  "sourcePath": "GM/3A/cours.pdf",
  "artifactId": "…",
  "action": "study-guide",
  "options": { "level": "detailed", "language": "fr" }
}
```

Cette route peut réutiliser le moteur interne du chat et répondre en SSE. Une génération déjà prête est servie immédiatement depuis le bucket/cache.

## 11. Contexte envoyé au modèle

Le contexte est composé explicitement :

```text
SYSTEM
- rôle pédagogique
- règles de citation
- contenu documentaire non fiable comme instruction
- interdiction d’inventer

DOCUMENT
- sourcePath, artifactId, titre
- mode Docling ou fallback
- plan utile

EVIDENCE
[S1] titre/page/bloc + texte
[S2] tableau + contexte
[S3] légende de figure + paragraphes voisins

USER
- question et intention
- éventuelle sélection de texte
```

Les consignes trouvées dans un document sont des données, jamais des instructions système. Cette séparation limite les attaques par prompt injection dans les fichiers du corpus.

## 12. Citations et navigation

### 12.1 Format de réponse

Le modèle cite `[S1]`, `[S2]`, etc. Le backend remplace ces références par des objets contrôlés ; il ne laisse pas le modèle inventer un chemin ou un `blockId`.

### 12.2 Avant le lecteur interactif

- ouvrir le PDF original ;
- si la page est connue, utiliser `#page=<n>` ;
- afficher le titre de section et un court extrait ;
- pour Office, ouvrir la modale actuelle et indiquer la section.

### 12.3 Après le lecteur interactif

- ouvrir `sourcePath` avec `artifactId` ;
- scroller vers `blockId` ;
- surligner le bloc ou la plage sélectionnée ;
- afficher la page/boîte dans la vue originale ;
- permettre « annoter cette réponse ».

Ainsi, le travail sur les citations effectué maintenant n’est pas jeté lorsque le lecteur sera développé.

## 13. Interface React

### 13.1 Composants proposés

```text
DocumentStudyPanel
├── StudyScopeHeader
├── ArtifactStatusBadge
├── QuickStudyActions
├── DocumentOutlineMini
├── StudyConversation
├── CitationList
└── StudyProgress
```

### 13.2 Intégration immédiate

Dans `PreviewModal` :

```text
[ Télécharger ] [ Partager ] [ Étudier avec l’IA ]
```

Le clic transmet l’objet catalogue déjà validé :

```json
{
  "path": "…",
  "name": "…",
  "size": 123,
  "mtime": "…"
}
```

Le frontend ne construit jamais un chemin d’artefact Hugging Face ; l’API le résout.

### 13.3 Intégration au futur lecteur

Le même panneau reçoit en plus :

```json
{
  "artifactId": "…",
  "selectedBlockId": "b-…",
  "selection": { "start": 12, "end": 85, "quote": "…" }
}
```

Actions contextuelles :

- expliquer ;
- reformuler simplement ;
- donner un exemple ;
- relier au chapitre précédent ;
- créer une question de révision ;
- ajouter la réponse comme annotation.

## 14. Persistance

### 14.1 Bucket dérivé

Contenu partagé et reproductible :

- artefacts Docling ;
- résumés communs ;
- fiches génériques ;
- glossaires ;
- banques de questions non personnalisées ;
- manifests et versions.

### 14.2 Appwrite

Contenu privé lié à l’étudiant :

- conversations ;
- progression de lecture ;
- annotations ;
- réponses aux quiz ;
- fiches personnelles ;
- préférences de niveau et de langue.

Évolutions suggérées :

```text
conversations
+ scopeType: library|document|selection|comparison
+ sourcePath
+ artifactId
+ studyIntent

messages
+ citations (JSON compact validé)
+ knowledgeSource
+ artifactId

study_progress
- userId
- sourcePath
- artifactId
- sectionId
- state
- score
- lastStudiedAt
```

Aucune annotation ou progression privée ne doit être écrite dans le bucket public.

## 15. Coût et stratégie de génération

### 15.1 Routage des modèles

| Travail | Modèle recommandé |
| --- | --- |
| classement lexical et récupération | aucun LLM |
| résumé court d’une section | modèle rapide/économe |
| réduction du document complet | modèle de meilleure qualité |
| question ciblée avec bonnes preuves | modèle rapide par défaut |
| comparaison de plusieurs documents | modèle à contexte long |
| quiz simple | modèle rapide, sortie JSON validée |

### 15.2 Cache

Clé partagée :

```text
artifactId + aiProfileVersion + action + options normalisées
```

Clé d’une réponse utilisateur :

```text
userId + conversationId + artifactId + questionHash
```

Les réponses libres restent dans l’historique Appwrite. Les artefacts génériques validés peuvent être partagés dans le bucket.

### 15.3 Anti-doublon

- verrou serveur par clé de génération ;
- un seul résumé global en cours par artefact/version ;
- attente courte ou réponse `202 generation-in-progress` ;
- limite de débit existante conservée ;
- quotas spécifiques aux actions coûteuses.

## 16. Sécurité et fiabilité

1. valider `sourcePath` contre le catalogue, jamais contre la seule saisie client ;
2. ne servir qu’un manifest `ready` ;
3. borner le nombre de chunks et de caractères ;
4. considérer le document comme contenu non fiable ;
5. ne jamais exécuter une instruction trouvée dans un document ;
6. filtrer secrets, emails et données sensibles avant journalisation ;
7. ne pas stocker la réflexion interne du modèle ;
8. valider les JSON de résumé/quiz avec un schéma ;
9. vérifier que chaque citation renvoyée appartient aux preuves fournies ;
10. indiquer les lacunes d’extraction au lieu de les faire compléter par le modèle ;
11. conserver les permissions Appwrite par propriétaire ;
12. ne jamais déclencher Docling depuis l’interface.

## 17. Observabilité

Pour chaque requête IA, mesurer sans stocker inutilement la question complète :

```text
requestId
scopeType
sourcePathHash
artifactId
knowledgeSource
intent
retrievalDuration
retrievedChunks
retrievedSections
contextTokens
coverageKind
provider/model
cacheStatus
firstTokenDuration
totalDuration
citationCount
answerStatus
```

Tableau de bord recommandé :

- part de requêtes Docling vs fallback ;
- documents structurés les plus interrogés ;
- taux de réponses avec citation ;
- taux de clic sur citation ;
- erreurs d’artefact ;
- cache HIT des fiches/résumés ;
- coût par action ;
- questions sans preuve suffisante.

## 18. Évaluation de qualité

### 18.1 Jeu de référence

Construire un jeu d’au moins 30 documents :

- PDF texte propre ;
- PDF scanné/OCR ;
- DOCX structuré ;
- PPTX ;
- XLSX avec tableaux ;
- cours avec formules ;
- annales ;
- document contenant figures et légendes ;
- document long ;
- extraction Docling partiellement dégradée.

Pour chaque document :

- 3 questions factuelles ;
- 2 questions de compréhension ;
- 1 résumé attendu ;
- 1 question hors document ;
- citations de référence.

### 18.2 Métriques

```text
Recall@k des chunks
précision des citations
couverture des sections du résumé
fidélité factuelle
réponses « preuve insuffisante » correctes
latence premier token
coût par réponse
stabilité entre deux exécutions
```

### 18.3 Règles d’acceptation

- aucune affirmation spécifique au document sans citation lorsqu’une preuve est requise ;
- au moins 90 % des citations ouvrent un bloc existant ;
- aucune citation ne pointe vers un autre artefact ;
- un résumé complet couvre toutes les sections principales ou se déclare partiel ;
- le fallback ne prétend jamais disposer de la structure Docling ;
- une question hors contenu reçoit une limite claire.

## 19. Plan fichier par fichier

### Backend Go

```text
backend/internal/reader/
├── catalog.go       # reader/v1/catalog.json
├── resolver.go      # sourcePath -> révision
├── artifact.go      # manifest/document/chunks
├── outline.go       # arbre de sections
└── cache.go

backend/internal/study/
├── retrieve.go      # scoring lexical/structurel
├── evidence.go      # citations contrôlées
├── summarize.go     # map-reduce
├── actions.go       # fiche, quiz, glossaire
├── schema.go        # sorties JSON
└── cache.go
```

Évolutions :

```text
backend/internal/api/chat.go
- scope, intent, artifactId, anchor
- événements SSE scope/retrieval/citation
- branche Docling puis fallback

backend/internal/chat/retrieve.go
- conserver le classement global
- déléguer les questions ciblées au StructuredRetriever

backend/internal/chat/extract.go
- rester fallback uniquement
```

Configuration :

```text
HF_DERIVED_BUCKET_ID=ktongue/ENISE-SITE-DERIVED
AI_STUDY_PROFILE_VERSION=study-v1
AI_MAX_CONTEXT_CHUNKS=12
AI_MAX_CONTEXT_TOKENS=12000
AI_SUMMARY_CACHE_ENABLED=1
```

### Worker Cloudflare

- relayer les nouveaux champs sans les interpréter ;
- conserver le streaming SSE ;
- ajouter les routes de lecture si elles ne passent pas toutes par Go ;
- ne jamais contenir de clé fournisseur dans le navigateur ;
- ne jamais appeler le Space de conversion à la demande.

### Frontend

```text
src/components/DocumentStudyPanel.jsx
src/components/StudyActions.jsx
src/components/CitationLink.jsx
src/hooks/useDocumentStudy.js
src/services/study.js
```

Modifications :

```text
PreviewModal.jsx     # bouton Étudier avec l’IA
LibraryChat.jsx      # scope bibliothèque/document/comparaison
future DocumentReader.jsx # sélection de bloc et panneau partagé
```

### Appwrite

- étendre `scripts/appwrite-spec.js` sans casser les conversations actuelles ;
- ajouter les colonnes de scope en option ;
- ajouter `study_progress` dans un lot ultérieur ;
- garder les permissions par utilisateur.

## 20. Tests à prévoir

### Unitaires

- résolution Docling/fallback ;
- rejet d’un faux `sourcePath` ;
- construction du plan ;
- scoring titre/chunk/tableau ;
- fenêtre de voisins ;
- budget de contexte ;
- validation de citation ;
- invalidation par `artifactId` ;
- schémas de résumé et quiz ;
- détection de couverture partielle.

### Intégration

- requête ciblée sur un artefact prêt ;
- même requête avant conversion ;
- artefact annoncé mais manifest absent ;
- citation vers page/bloc ;
- résumé long avec plusieurs sections ;
- historique Appwrite avec scope ;
- fournisseur principal indisponible puis fallback ;
- cache partagé de fiche de révision ;
- deux demandes simultanées du même résumé.

### Frontend

- bouton depuis la modale ;
- document correctement attaché au panneau ;
- badge Docling/fallback ;
- clic citation vers PDF actuel ;
- clic citation vers futur bloc ;
- sélection de texte ;
- reprise d’une conversation ciblée ;
- changement explicite vers un nouvel artefact.

## 21. Ordre de mise en œuvre

### Lot 1 — fondation utilisable pendant la conversion

1. ajouter `HF_DERIVED_BUCKET_ID` ;
2. lire et mettre en cache `reader/v1/catalog.json` ;
3. créer `ArtifactResolver` ;
4. ajouter `scope.type=document` à `/api/chat` ;
5. ajouter le bouton **Étudier avec l’IA** dans la modale ;
6. conserver l’extracteur actuel comme fallback ;
7. afficher clairement le mode de connaissance.

**Résultat :** un document précis peut être interrogé dès maintenant. Les artefacts déjà convertis bénéficient de Docling ; les autres restent utilisables en mode partiel.

### Lot 2 — RAG structuré et citations

1. charger `document.json` et `chunks.jsonl` ;
2. construire le plan ;
3. implémenter le scoring lexical/structurel ;
4. produire des preuves avec page/bloc ;
5. imposer les citations contrôlées ;
6. rendre les citations ouvrables dans la vue PDF actuelle.

**Résultat :** l’assistant comprend réellement les sections pertinentes au lieu de lire uniquement le début du fichier.

### Lot 3 — résumés et outils d’étude

1. résumé map-reduce ;
2. fiche de révision ;
3. glossaire ;
4. quiz ;
5. cache et manifest `study/v1` ;
6. observabilité et quotas.

**Résultat :** l’IA devient un outil d’apprentissage, pas seulement un moteur de recherche.

### Lot 4 — lecteur interactif et annotations

1. brancher `DocumentReader` sur les mêmes `blockId` ;
2. sélectionner un passage ;
3. expliquer/quiz/annoter depuis la sélection ;
4. enregistrer les annotations Appwrite ;
5. migrer les ancres entre artefacts ;
6. suivre la progression par section.

**Résultat :** aucun travail du Lot 1 à 3 n’est perdu lorsque le lecteur structuré arrive.

### Lot 5 — recherche transverse avancée

1. comparaison multi-documents ;
2. index hybride global si les métriques le justifient ;
3. révision croisée cours/TD/annales ;
4. parcours d’étude personnalisés ;
5. pré-génération des documents populaires.

## 22. Critères d’acceptation globaux

### Fonctionnel

- [ ] l’utilisateur peut ouvrir un document et lui poser directement une question ;
- [ ] l’IA indique si elle utilise Docling ou un fallback partiel ;
- [ ] un résumé complet couvre les sections, pas seulement le début ;
- [ ] les réponses citent page, section et bloc lorsque Docling est prêt ;
- [ ] les citations ouvrent la vue actuelle puis le futur lecteur ;
- [ ] les tableaux et figures sont intégrés au contexte pertinent ;
- [ ] fiche, quiz et glossaire partagent le même contrat de preuve ;
- [ ] aucune conversion n’est lancée par un visiteur.

### Continuité du projet lecteur

- [ ] `sourcePath`, `artifactId` et `blockId` sont utilisés dès le premier lot ;
- [ ] le panneau IA est réutilisable dans `PreviewModal` et `DocumentReader` ;
- [ ] les citations sont compatibles avec les futures annotations ;
- [ ] les conversations restent attachées à une révision reproductible ;
- [ ] l’original reste accessible à côté de la lecture structurée.

### Qualité et sécurité

- [ ] chemins validés côté serveur ;
- [ ] citations contrôlées par le backend ;
- [ ] contenu documentaire isolé des instructions système ;
- [ ] couverture mesurée et affichée ;
- [ ] cache versionné et invalidable ;
- [ ] données privées uniquement dans Appwrite ;
- [ ] coûts et latences observables.

## Conclusion

L’amélioration prioritaire n’est pas de changer uniquement de modèle IA. Elle consiste à remplacer le contexte brut et tronqué par un **contexte documentaire structuré, ciblé et cité**.

Le chemin recommandé est progressif :

1. cibler explicitement un document dès maintenant ;
2. préférer automatiquement Docling lorsque l’artefact est prêt ;
3. garder le fichier original comme référence visuelle ;
4. produire des résumés hiérarchiques avec couverture mesurée ;
5. utiliser les mêmes ancres pour le futur lecteur, les annotations et l’IA.

Cette architecture permet d’améliorer l’assistant pendant que la conversion continue, sans créer une solution provisoire qui devrait être jetée une fois tous les documents convertis.
