# Plan — Un explorateur web inspiré du Finder

**Objectif :** retrouver les gestes et les repères du Finder dans la bibliothèque ENISE : dossiers bleus par défaut, quatre modes d’affichage, navigation dans l’arborescence, Coup d’œil, sélection, tags et recherche. On reproduit les usages pertinents pour une bibliothèque web, pas l’accès système de macOS.

## État de la livraison

- **Lots 1 et 2 — en place :** quatre vues, dossiers bleus, préférences mémorisées, liste dépliable, historique, onglets, sélection, Coup d’œil, informations, raccourcis, favoris, tags, recherches enregistrées et regroupement. L’aperçu intégré de la galerie montre les images matricielles jusqu’à 5 Mio ; les autres formats s’ouvrent dans les visualiseurs existants. L’historique Précédent/Suivant suit le navigateur ; les onglets gardent leur dossier et leur état d’affichage pendant la session.
- **Options de présentation étendues :** volet de prévisualisation indépendant de Coup d’œil, réglages par dossier, tailles du texte et des icônes, positions des noms, espacement, fond de grille, choix des colonnes et des barres, vignettes facultatives. Le volet utilise les métadonnées et un aperçu borné quand le format le permet ; l’ouverture complète et les téléchargements restent disponibles.
- **Lot 3 — non activé :** pas de création, import, renommage, déplacement ou corbeille depuis l’explorateur. Ces opérations nécessitent la décision sur les rôles et le stockage et un environnement de test qui permet de valider la restauration. Les intégrations système macOS ne font pas partie du périmètre web.

Validation reproductible : `npm run check` pour les tests unitaires et le build. Pour les parcours Chromium simulant l’API, installer le navigateur avec `npx playwright-core install chromium`, puis exécuter `npm run test:finder-browser`. On peut aussi utiliser un navigateur déjà installé avec `FINDER_CHROMIUM=/chemin/vers/chromium npm run test:finder-browser`.

## 1. Point de départ et décision d’architecture

- Avant la refonte, [`Explorer.jsx`](../src/components/Explorer.jsx) proposait grille, liste, tri en mémoire et fil d’Ariane. Les actions d’ouverture, d’aperçu, de téléchargement et de favoris étaient disponibles au clic.
- [`App.jsx`](../src/App.jsx) assemble la barre latérale, l’explorateur, la palette de recherche et la fenêtre d’aperçu. [`useLibrary.js`](../src/hooks/useLibrary.js) gère le dossier actif, l’historique du navigateur, le chargement et le repli local. [`useIndexCatalog.js`](../src/hooks/useIndexCatalog.js) fournit le catalogue global.
- Les chemins du bucket Hugging Face restent la référence. `/api/tree` charge les enfants directs ; `/api/index` sert au catalogue et à la recherche. Le premier lot ne déplace aucun fichier, ne change pas les URL `/bibliotheque/…` et ne touche pas à l’accueil éditorial ni aux visualiseurs. Il n’existe pas d’API générique de mutation de la bibliothèque ; l’export STEP sous `derived/step/` est un flux distinct.
- « Architecture type MacBook » signifie ici **une arborescence et des accès inspirés du Finder**, pas la création de dossiers système comme Applications ou Bureau dans le bucket. Les sections **Favoris**, **Récents**, **Emplacements** (les espaces ENISE) et **Tags** sont des accès virtuels : un même document peut apparaître dans plusieurs vues sans être copié.

### Structure cible (proposée)

| Couche | Responsabilité |
|---|---|
| `Explorer.jsx`, `SideNav.jsx` | Cadre de l’explorateur : barre d’outils, emplacements, zone de contenu, barre de chemin et état. |
| `src/components/explorer/` | Moteurs de rendu `IconView`, `ListView`, `ColumnView`, `GalleryView` ; menu d’actions, inspecteur d’informations et composant SVG `FolderIcon` original. Toutes les vues partagent les mêmes actions. |
| `useLibrary` + couche de lecture par dossier | Séparer le chargement des enfants (clé = chemin, cache et annulation) de la navigation. L’index peut aider à afficher rapidement un dossier, mais n’est pas une preuve qu’il est vide. |
| `Explorer` et `useLibrary` | Le premier conserve les préférences et la sélection par onglet ; le second garde l’onglet actif, son chemin et l’historique synchronisés avec l’URL. La sélection n’est pas dans l’URL. |
| Métadonnées personnelles | Préférences d’affichage, favoris de dossiers, récents, tags et recherches enregistrées. Rien n’est écrit dans le bucket pour ces usages. Réutiliser le stockage local puis faire évoluer la synchronisation Appwrite si nécessaire. |

## 2. Lots de livraison

### Lot 1 — Apparence, navigation et affichages (recommandé pour commencer)

1. **Dossiers bleus par défaut** : SVG original inspiré des proportions du Finder, avec languette et dégradé bleu. Utiliser le même pictogramme en icônes, liste, colonnes et galerie. La sélection modifie le fond et le contour, pas la couleur du dossier. Les étiquettes ajoutent ensuite des pastilles nommées, sans remplacer le bleu de base.
2. **Barre d’outils** : Précédent/Suivant pour l’historique des dossiers ; un bouton distinct « Dossier parent » ; recherche ; choix de vue et tri. Conserver le fil d’Ariane cliquable et afficher le nombre d’éléments ou d’éléments sélectionnés. Enregistrer vue et tri globalement par défaut ; les options par dossier peuvent venir ensuite.
3. **Quatre vues**, sur la même arborescence :
   - **Icônes** : grille, grandes icônes bleues, nom sous l’icône ; taille ajustable.
   - **Liste** : en-têtes triables (nom, modification, type, taille), dossiers dépliables avec chargement à la demande. Afficher « — » pour une taille inconnue plutôt qu’un zéro trompeur.
   - **Colonnes** : une colonne par niveau du chemin ; sélectionner un dossier révèle ses enfants sans attendre un double-clic. Les colonnes déjà ouvertes restent visibles ; la navigation confirmée prend en charge les liens directs et l’historique sans ajouter une entrée par déplacement de focus.
   - **Galerie** : aperçu dominant du fichier sélectionné et bande de vignettes. Charger d’abord des aperçus légers ; garder Office et CAO/3D complets à la demande via les visualiseurs existants. Si aucune vignette n’est disponible, montrer l’icône de type et l’action « Ouvrir ».
4. **Adaptation mobile** : grille/liste en accès direct ; colonnes sous forme d’un niveau à la fois avec fil d’Ariane ; galerie sans panneau latéral permanent. Un tap ne doit jamais exiger un double-tap pour ouvrir.

**Validation :** les modes montrent les mêmes éléments pour un dossier donné ; un changement de vue préserve le chemin ; la préférence survit au rechargement ; les liens existants et le repli local continuent de fonctionner. Un dossier vide renvoyé par l’API reste navigable et se distingue d’un chargement ou d’une indisponibilité réseau.

### Lot 2 — Gestes du Finder, Coup d’œil et organisation personnelle

- **Sélection et ouverture** : clic simple pour sélectionner, double-clic ou Entrée pour ouvrir sur ordinateur (sauf révélation de colonne), action explicite « Ouvrir » sur écran tactile, multi-sélection avec Maj et Cmd/Ctrl. Navigation au clavier avec les flèches ; Espace lance **Coup d’œil** quand le focus est dans les résultats ; Échap referme l’aperçu et restaure le focus. Ne pas intercepter les raccourcis réservés du navigateur ni les frappes dans les champs. Pour les onglets, fournir un bouton dans l’interface plutôt que détourner `Cmd/Ctrl+T`.
- **Menu contextuel** également accessible par bouton et clavier : ouvrir, Coup d’œil, télécharger, copier le lien, ajouter aux favoris, lire les informations. Le panneau « Lire les informations » expose les métadonnées disponibles : nom, type, chemin, taille et date de modification, plus les tags personnels.
- **Barre latérale** : favoris de fichiers et dossiers, récents propres à l’utilisateur ou à l’appareil, emplacements ENISE et tags. Épinglage et réorganisation avec alternative clavier ; un glisser-déposer de favori ne déplace jamais la source. Vérifier la compatibilité du modèle des favoris et préserver les favoris existants avant d’étendre leur synchronisation aux dossiers.
- **Recherche façon Finder** : choix visible « Toute la bibliothèque / Ce dossier et ses sous-dossiers », filtres par type, date, taille et tag selon les données disponibles. Créer des **dossiers intelligents** en enregistrant des requêtes, sans dupliquer les fichiers. La première version filtre les métadonnées ; une recherche fiable dans le contenu nécessite une indexation distincte.
- **Onglets d’exploration** : chemin, sélection et position de défilement par onglet. Préférer des onglets internes aux fenêtres simulées ; ouvrir le même dossier dans un nouvel onglet du navigateur par son URL reste possible. Prévoir tri et regroupement (type, date, tags) ainsi que l’affichage facultatif du chemin, de l’état et de l’inspecteur.

**Validation :** parcours sans souris et sur mobile ; aucun conflit avec la recherche globale ni avec les dialogues ; tags et favoris ne modifient jamais le catalogue partagé ; ouvrir Coup d’œil et revenir restaure la sélection. Les métadonnées personnelles ne fuitent pas entre comptes sur le même appareil.

### Lot 3 — Gestion des fichiers, à décider séparément

Ne pas transformer une bibliothèque publique en espace modifiable pour tous. Recommandation : garder le catalogue ENISE en lecture seule pour le public ; activer les opérations d’écriture pour des rôles autorisés, ou dans un espace privé **réellement isolé** si chaque utilisateur doit gérer ses fichiers. La connexion Appwrite et le masquage de boutons ne suffisent pas à autoriser une opération.

1. **Prototype de stockage** : vérifier les capacités du bucket sur un environnement de test : création de dossier vide, import de dossiers, copie et déplacement, traitement des gros fichiers, versions et suppression. Si un renommage ou déplacement est une copie suivie d’une suppression, n’enlever la source qu’après vérification de la destination ; journaliser les échecs et permettre une reprise. Choisir ensuite entre stockage existant et espace dédié.
2. **API d’écriture** : un seul service applique les permissions par chemin et opération (par exemple Go, routé par le Worker en production). Secrets côté serveur, validation des chemins, limites de taille et quotas, résolution explicite des collisions (remplacer, renommer, ignorer), progression, journal d’audit et vérification des autorisations sur les deux chemins lors d’un déplacement.
3. **Commandes** : nouveau dossier, import, renommage simple puis groupé, duplication, copier/couper/coller internes, glisser-déposer, téléchargement groupé ; mesures de capacité avant compression ZIP volumineuse. Ajouter ensuite corbeille, restauration et annulation des seules opérations réellement réversibles. Pas de suppression définitive par défaut ; définir une politique de rétention et tester la restauration sur une copie.
4. **Cohérence** : invalider les caches des dossiers source et destination et réindexer. Les chemins actuels identifient les favoris et les liens : avant de permettre les renommages, choisir un identifiant durable avec redirections, ou une table d’anciens chemins et des règles de mise à jour des références personnelles. Documenter le comportement lors d’un conflit, d’une mise à jour concurrente ou d’un lien devenu inaccessible.

**Validation :** aucune écriture anonyme, aucune opération hors périmètre autorisé, pas de perte de source lors d’un déplacement partiel, les dossiers et index se mettent à jour après succès, et une restauration est possible tant que l’élément est dans la corbeille.

## 3. Limites web et équivalents

| Usage macOS | Équivalent envisageable |
|---|---|
| Spotlight système, dossiers intelligents | Recherche du catalogue et recherches enregistrées ; pas d’index du disque de l’utilisateur. |
| AirDrop, menu Partager, alias | Copier le lien, partage natif web selon le navigateur, raccourcis virtuels. Un lien partagé ne change pas les droits. |
| Finder sur disque, iCloud Drive, volumes réseau, Time Machine | Pas d’accès système transparent. Import/export via choix explicite de l’utilisateur ; connecteurs ou historique de versions éventuels, chacun dans un projet séparé. |
| Coup d’œil, actions rapides, plugins système | Réutiliser les aperçus PDF, Office et CAO/3D existants ; n’exposer que les actions web compatibles avec le format et les droits. Pas de plugins Finder natifs. |

## 4. Vérifications avant livraison

- **Fonctionnel** : navigation par lien direct et historique ; noms accentués, espaces et caractères encodés ; dossier vide ; erreur réseau ; tri stable ; sélection conservée au passage entre vues. Tester les réponses arrivant dans le désordre lors d’une navigation rapide entre colonnes.
- **Accessibilité** : ordre de tabulation, boutons nommés, focus visible, contraste clair/sombre, Voix hors champ (VoiceOver) sur macOS et parcours clavier sur Windows. La couleur seule ne signale ni la sélection ni le tag.
- **Performance** : requêtes de dossiers dédupliquées et annulables, vignettes paresseuses, liste virtualisée si les mesures sur un gros dossier l’exigent. Aucun chargement massif des fichiers binaires pour afficher la galerie.
- **Régression** : `npm run check` pour lint, tests et build ; tests de navigation sur navigateur en complément ; `go test ./...` depuis `backend/` si l’API Go évolue. Préserver les aperçus, favoris, téléchargements et liens partagés existants.

**Ordre recommandé :** livrer le lot 1 dans l’explorateur actuel, puis le lot 2. Avant le lot 3, décider explicitement **qui peut modifier quels fichiers** et **où vivent les contenus privés**.
