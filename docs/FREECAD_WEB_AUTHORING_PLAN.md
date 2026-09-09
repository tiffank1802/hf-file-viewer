# Plan — Atelier FreeCAD Web dans ENISE Docs

**Date : 9 septembre 2026**

**Statut : plan d’intégration, aucune route d’atelier n’est encore activée**

## 1. Objectif

Ajouter une route du site permettant de créer/modifier un fichier CAO dans
FreeCAD Web, puis de publier le fichier `.FCStd` créé dans le bucket
Hugging Face `ktongue/ENISE-SITE`.

L’application fournie est :

```text
https://tom.thecadhub.com/static/vendor/freecad/app.html
```

La page indique que FreeCAD Web fonctionne entièrement dans le navigateur via
WebAssembly, avec le noyau OpenCASCADE, WebGL2 et Python embarqué. Elle propose
`Open / Import` et `Save .FCStd`. Le premier chargement est d’environ 96 Mo et
requiert un navigateur Chromium récent (JSPI, indiqué comme Chromium 137+ sur
la page).

## 2. Point architectural essentiel

FreeCAD Web n’est pas une API de conversion appelée par le Worker. C’est une
application graphique qui s’exécute dans le navigateur de l’utilisateur.

Le flux doit donc être séparé en deux étapes :

```text
Navigateur
   │
   ├── /atelier-3d
   │     ouvre FreeCAD Web pour créer/modifier le modèle
   │
   ├── l’utilisateur clique Save .FCStd
   │     et récupère le fichier localement
   │
   └── formulaire ENISE Docs « Publier dans la bibliothèque »
         │ multipart, sans token HF dans le navigateur
         ▼
Cloudflare Worker
   │ valide le fichier, le chemin et la taille
   │ calcule SHA-256
   │ utilise un secret HF Write côté serveur
   ▼
Bucket Hugging Face
   └── created/3d/<chemin>/<nom>.FCStd
```

Il ne faut pas compter sur une communication directe avec l’application
externe par `postMessage`, ni sur la récupération de son fichier depuis une
iframe cross-origin : l’URL fournie ne documente aucun contrat d’intégration
avec le site ENISE.

## 3. Route frontend proposée

### Route principale

```text
/atelier-3d
```

La route doit être reconnue avant la route de bibliothèque actuelle
(`/bibliotheque/...`). Elle ne doit pas déclencher `useLibrary()` ni charger
l’index du bucket.

### Composants prévus

```text
src/components/FreecadWebPage.jsx
src/services/freecad.js
```

Responsabilités de `FreecadWebPage` :

1. afficher une présentation courte et les prérequis navigateur ;
2. proposer « Ouvrir FreeCAD Web » dans un nouvel onglet ;
3. proposer, si les headers le permettent, une iframe lazy de l’URL externe ;
4. proposer un champ de sélection `.FCStd` après le retour de FreeCAD Web ;
5. envoyer le fichier au Worker avec une barre de progression ;
6. afficher le chemin bucket et le lien de téléchargement après publication ;
7. conserver un fallback explicite vers l’ouverture externe si l’iframe est
   bloquée ou si le navigateur ne supporte pas le runtime WASM.

### Navigation

Ajouter un lien « Créer en 3D » :

- dans la navigation principale de `Header` ;
- dans le menu mobile ;
- éventuellement dans `Hero`/`CategoryGrid` comme action secondaire.

La route doit utiliser l’History API existante et rester compatible avec le
fallback SPA Cloudflare déjà configuré.

## 4. Iframe ou nouvel onglet

### Décision MVP : nouvel onglet obligatoire, iframe optionnelle

Le nouvel onglet est le chemin fiable :

```jsx
<a
  href="https://tom.thecadhub.com/static/vendor/freecad/app.html"
  target="_blank"
  rel="noreferrer"
>
  Ouvrir FreeCAD Web
</a>
```

Une iframe peut être ajoutée en amélioration progressive, mais elle dépend de
headers que le dépôt externe peut changer (`X-Frame-Options`, CSP,
`Cross-Origin-Resource-Policy`). Avant activation, vérifier dans un navigateur
réel que :

- le domaine autorise l’encadrement ;
- le téléchargement WASM fonctionne dans une iframe ;
- les raccourcis clavier et le viewport restent utilisables ;
- le chargement de 96 Mo ne bloque pas le reste du site.

Si l’iframe est retenue, ajouter uniquement le domaine nécessaire à
`frame-src` dans `public/_headers`. Ne pas ajouter de `COEP` global sans test,
car cela peut casser les iframes Office, Autodesk et ShareCAD existantes.

## 5. Route Worker de publication

Ajouter une route distincte de la lecture de bucket :

```text
POST /api/freecad/upload
```

Contrat multipart proposé :

```text
file        fichier .FCStd
path        chemin bucket relatif demandé par l’utilisateur
overwrite   0/1, désactivé par défaut
```

Réponse succès :

```json
{
  "status": "success",
  "path": "created/3d/GM/piece.FCStd",
  "manifestPath": "created/3d/GM/piece.FCStd.json",
  "sha256": "...",
  "size": 123456,
  "downloadUrl": "/api/file?path=created%2F3d%2FGM%2Fpiece.FCStd&download=1"
}
```

### Validation Worker

- accepter `.FCStd` avec une comparaison insensible à la casse ;
- limite initiale recommandée : 100 Mo, configurable par
  `MAX_FREECAD_AUTHORING_BYTES` ;
- refuser les chemins absolus, `..`, caractères de contrôle et chemins vides ;
- utiliser par défaut le préfixe `created/3d/` ;
- ne pas autoriser l’écrasement des sources pédagogiques existantes sans
  `overwrite=1` et une règle explicite ;
- calculer SHA-256 avant publication ;
- écrire un manifest de provenance à côté du `.FCStd` ;
- ne jamais accepter de token HF depuis `FormData` ou le navigateur.

### Écriture Hugging Face

Le Worker actuel possède un token de lecture pour servir le bucket. La
publication doit utiliser un secret séparé :

```text
HF_WRITE_TOKEN
```

L’implémentation devra choisir et tester une seule méthode d’écriture :

1. API Storage Buckets Hugging Face adaptée aux Workers ; ou
2. endpoint S3-compatible Hugging Face avec credentials Write ; ou
3. microservice serveur dédié qui reçoit le multipart et utilise
   `huggingface_hub.batch_bucket_files`.

Le token Write ne doit pas être placé dans `src/`, `public/`, `wrangler.jsonc`
ou une variable `VITE_*`.

## 6. Manifest publié

Exemple :

```json
{
  "kind": "freecad-web-authoring",
  "path": "created/3d/GM/piece.FCStd",
  "sha256": "...",
  "size": 123456,
  "source": "FreeCAD Web",
  "sourceUrl": "https://tom.thecadhub.com/static/vendor/freecad/app.html",
  "createdAt": "2026-09-09T00:00:00.000Z"
}
```

Le manifest permet de dédupliquer les publications et d’afficher un lien
stable dans l’interface.

## 7. Compatibilité avec les fonctions existantes

Cette intégration ne remplace pas les pipelines actuels :

- FreeCAD serveur `STEP/IGES/STL/OBJ → GLB` reste utilisé par
  `/api/model3d/glb` ;
- Autodesk et ShareCAD restent les fallbacks de visualisation ;
- l’export SolidWorks → STEP reste séparé et dépend de HOOPS Converter ;
- les fichiers `.FCStd` pourront ensuite être ajoutés à la détection des
  fichiers 3D et au viewer Autodesk/FreeCAD adapté, mais la première version
  doit se limiter à la création et au téléchargement/publication.

## 8. Phasage recommandé

### Phase A — vérification technique

- tester l’URL dans Chromium 137+ ;
- vérifier le premier chargement, le cache et la sauvegarde `.FCStd` ;
- vérifier les headers d’encadrement ;
- vérifier la licence et les conditions de redistribution avant tout
  auto-hébergement ;
- choisir nouvel onglet seul ou iframe progressive.

### Phase B — route frontend sans écriture

- ajouter `/atelier-3d` ;
- ajouter le lien de navigation ;
- afficher FreeCAD Web et les instructions ;
- ajouter le sélecteur local `.FCStd` mais conserver un mode téléchargement
  local uniquement ;
- ajouter tests de routage et de fallback navigateur.

### Phase C — publication sécurisée

- implémenter `POST /api/freecad/upload` ;
- brancher le secret `HF_WRITE_TOKEN` ;
- ajouter validation taille/chemin/extension ;
- écrire fichier + manifest ;
- tester les erreurs 400, 413, 409, 502 et l’absence de secret ;
- ne jamais journaliser le contenu du token.

### Phase D — intégration bibliothèque

- afficher le fichier publié dans la bibliothèque après rafraîchissement ;
- proposer aperçu/téléchargement ;
- ajouter la déduplication SHA-256 ;
- ajouter éventuellement une liste « Mes créations » dans `localStorage` ou
  via un identifiant utilisateur, sans exposer de secret.

## 9. Critères d’acceptation

- `/atelier-3d` est accessible par lien direct après un rafraîchissement ;
- le site ne charge pas les 96 Mo FreeCAD sur la page d’accueil ;
- un utilisateur Chromium compatible peut ouvrir FreeCAD Web, créer un modèle
  et sauvegarder un `.FCStd` ;
- le fichier peut être sélectionné puis publié sans token côté navigateur ;
- le fichier et le manifest apparaissent dans le bucket au chemin validé ;
- un deuxième envoi avec le même SHA-256 est dédupliqué ;
- les secrets restent dans les variables Worker/Space ;
- les viewers Autodesk, ShareCAD, Office et le pipeline GLB existants ne sont
  pas régressés.

## 10. Décision à prendre avant le développement

Le choix recommandé est :

> **MVP en nouvel onglet + publication `.FCStd` via le Worker ; iframe seulement
> après vérification des headers de FreeCAD Web.**

Ce choix évite de dépendre d’une API cross-origin non documentée tout en
permettant de créer et publier de vrais fichiers FreeCAD.
