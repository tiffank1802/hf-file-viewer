# Lecteur PDF unifié : exploitation et contrat

## Périmètre

Le lecteur Web et l’enveloppe Tauri utilisent la même interface React et PDF.js ; l’API reste en Go. Le PDF original, sa couche de texte sélectionnable, les surlignages, les notes privées et l’assistant sont réunis dans la vue `/read`. La disponibilité d’un artefact Docling n’est pas nécessaire à ce parcours. La vue structurée Docling reste proposée séparément lorsqu’elle est prête ; les autres formats gardent leur parcours existant.

Une sélection peut être surlignée, accompagnée d’une note ou envoyée à l’assistant. Une question sans sélection recherche des extraits dans un index local. L’utilisateur voit la progression et le fait que le texte transmis par le lecteur **n’est pas vérifié par le serveur**. Même quand toutes les pages ont été indexées, seuls quelques passages sont envoyés : une réponse ou un résumé ne constitue donc pas une lecture exhaustive.

### Choix Go / Rust

Conserver l’API Go réutilise l’authentification, les permissions, les caches, le catalogue et le streaming existants ; une migration complète de l’API vers Rust ne résoudrait pas, à elle seule, le décalage entre PDF affiché et artefacts Docling. Elle exigerait une réécriture et une validation équivalentes des routes et permissions. Le Rust déjà présent reste la passerelle native Tauri ; aucun service Rust supplémentaire n’est nécessaire à ce lot.

Slint, Iced ou egui restent des pistes pour un prototype d’interface native distincte, pas des dépendances de ce lecteur. Un moteur tel que PDFium via `pdfium-render` doit être fourni et testé sur chaque plateforme ; il faut également examiner les licences, l’accessibilité et les capacités mobiles. Un noyau Rust partagé ciblant aussi WASM nécessite un prototype et des mesures avant toute migration.

## Révision et transport

1. `GET /api/reader/pdf-revision?path=…` contrôle que le chemin appartient à la bibliothèque et interroge l’origine du PDF. Un ETag **fort** est transformé en `etag-sha256:<hash-de-l-etag>`. Cet identifiant est le hash d’un validateur HTTP opaque, **pas** le hash des octets ; sa fiabilité dépend du respect des ETag forts par le stockage.
2. `GET /api/file?path=…&reader=1&revision=…` contourne les caches par chemin du Worker et de Go. Pour une révision ETag, chaque réponse, y compris chaque `Range`, doit avoir le même ETag fort ; sinon Go renvoie `409` et le lecteur doit être rouvert ou retenté.
3. Sans ETag fort, le lecteur calcule `sha256:<hash-des-octets>` sur les octets chargés avec WebCrypto ; avant de créer/lister des notes ou d’interroger l’assistant, Go recalcule l’empreinte du fichier source. Ce repli est limité à **64 Mio** et nécessite WebCrypto : au-delà de la limite ou si l’API cryptographique est indisponible, les notes et l’IA restent désactivées si aucune révision fiable n’est disponible. La vérification SHA implique de relire tout le fichier côté serveur et peut être coûteuse.
4. Dans Tauri, le protocole local tamponne chaque réponse : le lecteur demande donc les octets par plages de 256 Kio, avec au plus quatre requêtes simultanées par plage demandée par PDF.js. Un serveur qui ignore `Range` ne fonctionne en repli que si sa réponse complète tient dans le tampon de la passerelle (64 Mio). La passerelle n’accepte pas les origines Web tierces pour les appels portant une origine ; une exception locale existe en build de développement.

Le fichier doit être visible dans l’index de la bibliothèque ; une indication de catalogue envoyée par le client ne suffit pas à autoriser une source. La révision protège contre un placement silencieux sur un fichier modifié, pas contre un stockage qui réutiliserait abusivement un ETag fort pour des octets différents.

## Ancre et compatibilité

Une ancre `pdf-anchor/v1` comprend la révision source, l’origine (`pdf-text`, ou `ocr` réservé pour une future intégration), la citation, son contexte, la page initiale et des segments ordonnés par page. Chaque segment porte la `pageView` PDF et des quadrilatères en coordonnées PDF non liées au zoom. PDF.js effectue les conversions selon la CropBox, la rotation et l’échelle. Les citations issues d’une sélection réutilisent ces segments ; celles issues de l’index global pointent à la page, sans prétendre positionner précisément le texte.

Limites : **2 000 caractères**, **8 pages**, **32 quadrilatères**, 16 000 octets pour l’ancre JSON, 4 000 caractères de note et 32 Kio pour la requête complète. Le serveur valide la forme, les bornes et la révision, mais ne ré-extrait pas le texte ni la géométrie pour les certifier. Les ancres endommagées, les notes héritées et celles d’une autre révision sont marquées « à vérifier » et ne sont pas positionnées automatiquement. Leur contenu reste lisible et modifiable ; il n’y a pas de réancrage automatique ni de migration destructive.

Les nouvelles notes sont écrites dans `pdf_annotations_v2` ; l’ancienne table `annotations` et son `artifactId` restent intacts. Les identifiants publics `pdfv2:` aiguillent les modifications vers la nouvelle table. La session Appwrite détermine le propriétaire, des permissions privées sont attachées à chaque ligne, et l’API vérifie également le propriétaire. La liste pagine par 25, avec une borne de 400 pages par table : une réponse tronquée ou une borne dépassée produit une erreur explicite, jamais une liste faussement vide.

Schéma de la nouvelle table (source exacte : `scripts/appwrite-spec.js`) : `userId`, `documentKey` (hash du chemin), `sourcePath`, `sourceRevision`, `anchorJson`, `page`, `kind`, `color`, `body` et `status`, plus `artifactId` et `blockId` optionnels pour compatibilité de représentation. Les index portent sur `(documentKey, $updatedAt)`, `(documentKey, sourceRevision, $updatedAt)` et `(userId, $updatedAt)`. Les dates sont celles des lignes Appwrite. Les valeurs de provenance, les segments et le contexte sont sérialisés dans `anchorJson` ; les permissions de ligne ne sont pas déduites de ce JSON.

## Index et confidentialité

- Indexation progressive locale de **600 pages maximum**, **40 000 caractères maximum par page** et **6 millions de caractères** au total. Le compteur inclut les pages sans texte ; une extraction interrompue ou tronquée reste indiquée comme incomplète.
- Une recherche lexicale simple retient au plus six extraits d’environ 1 800 caractères ; les questions générales peuvent donc manquer des éléments pertinents. Les passages, la question et un historique conversationnel limité sont transmis à l’API et, si configuré, au fournisseur IA choisi.
- Les notes privées ne sont pas ajoutées automatiquement au contexte IA. Les métriques du lecteur sont agrégées ; elles n’incluent ni texte de sélection, ni note, ni question. Les journaux HTTP existants peuvent contenir les chemins et paramètres des requêtes, mais pas les corps des notes ou des questions.
- Si une page ne fournit aucun texte sélectionnable, un message signale qu’un OCR peut être nécessaire. Il ne s’agit pas d’un OCR, d’une analyse visuelle, ni d’une preuve que toutes les images sont des scans. OCR géométrique, fonctionnement hors ligne et export des annotations dans le PDF sont des lots distincts, non implémentés ici.

## Provisionnement Appwrite

Le [guide de déploiement](DEPLOY_PDF_UNIFIED.md) détaille les sauvegardes, les environnements, les commandes, les secrets et le retour arrière. **Le script réapplique les permissions et l’activation de toutes les tables connues, pas seulement de la table PDF** : vérifier le plan et les permissions existantes avant toute exécution.

Avant d’ouvrir l’écriture des nouvelles notes dans un environnement :

1. Sauvegarder et vérifier la base et les tables existantes. Définir côté opérateur une clé Appwrite autorisée au provisioning, sans préfixe `VITE_` et sans la committer. Les comptes et sessions utilisés par le lecteur restent ceux d’Appwrite Auth.
2. Configurer les mêmes `APPWRITE_DATABASE_ID` et, si nécessaire, `APPWRITE_PDF_ANNOTATIONS_TABLE_ID` dans le backend et l’environnement du script. Le défaut est `pdf_annotations_v2`. L’ID doit être valide et distinct de toutes les autres tables ; le script et le client Go refusent les collisions.
3. Sur une base de staging distincte, examiner le plan ciblé avec `npm run appwrite:setup -- --dry-run --flavor=tablesdb --table=pdf_annotations_v2 --new-table-only` (ou `--flavor=databases` pour l’API héritée). Avant toute écriture, suivre le [guide de déploiement](DEPLOY_PDF_UNIFIED.md) : sauvegarde/restauration vérifiées, revue de la cible et du plan, clé aux droits minimaux et accord explicite. Le script ne redimensionne pas automatiquement les colonnes existantes. Vérifier ensuite l’état réel des colonnes, index et permissions avec deux comptes.
4. Vérifier avec **deux comptes** qu’un utilisateur ne voit ni ne modifie les notes de l’autre ; valider création, modification, suppression, réouverture et anciennes notes. Si la table PDF n’existe pas, les anciennes notes peuvent être listées avec un avertissement, mais une nouvelle note ne peut pas être créée.

**Ne pas utiliser `--drop` pour un déploiement ou un rollback** : cette option du script supprime des tables et peut détruire les données. Ne pas publier de clé serveur dans le frontend, le dépôt ou les journaux.

## Déploiement progressif et retour arrière

1. Valider les tests ci-dessous, le backup, les réglages d’origine et le provisioning dans un environnement isolé. Le backend Go, le Worker et le frontend doivent être compatibles : le nouveau frontend dépend des routes de révision et de la table additive. Les applications Tauri existantes doivent être reconstruites et redistribuées pour bénéficier de leur transport par plages ; une release publiée auparavant n’est pas modifiée automatiquement.
2. Déployer d’abord la table additive et le backend compatible, puis le Worker qui relaie `/api/reader/*` et `/api/file?reader=1`. Tester `200`/`206`, les en-têtes `Content-Range`, `Accept-Ranges`, `ETag`, `Cache-Control: no-store`, les cas `409`, une absence d’ETag, la connexion et les permissions. Ne pas changer ni supprimer l’ancienne table.
3. Construire un frontend pilote avec `VITE_READER_ROLLOUT=pilot` et `VITE_READER_PILOT_PATHS` contenant des chemins exacts ; tester quelques PDF réels, puis élargir. `off`, `pilot`, `pdf` et `all` sont des réglages **au build** du lecteur existant, pas un interrupteur dynamique par utilisateur ; `off` désactive l’ouverture de ce lecteur, y compris pour les autres formats. Le défaut du dépôt est `all`, il faut donc définir explicitement le pilote avant publication. L’audit `npm run reader:audit` vérifie le parcours Docling historique et ne prouve pas à lui seul la disponibilité du nouveau parcours PDF.
4. Suivre les erreurs de lecture/révision, les échecs d’annotations, la couverture, l’annulation et les retours utilisateurs sans journaliser de passages ni de notes. Tester aussi sur des appareils et WebView représentatifs avant diffusion large.
5. En cas de problème, restaurer le build frontend/Worker et, si nécessaire, le backend précédent ou réduire la diffusion. **Conserver les deux tables et leurs sauvegardes**. Une ancienne version ne sait pas afficher les notes `pdf_annotations_v2` : elles ne sont pas perdues, mais restent invisibles jusqu’au retour d’une version compatible. Ne pas promettre leur visibilité pendant le rollback. Le retour à une version compatible doit les retrouver, sous réserve de la révision source.

Aucun provisioning, déploiement Cloudflare/Go ou publication Tauri n’est effectué par ces instructions.

## Vérification

Prérequis : Node.js 20.19+, Go 1.22+ et Python 3. Les navigateurs Playwright et leurs bibliothèques système doivent être installés pour les deux dernières commandes. Sous Linux, `test:e2e:install` peut demander les droits nécessaires à l’installation des dépendances du système.

```bash
npm ci
npm run check                      # lint, tests Node/Python, build Vite
(cd backend && go test -race ./...) # compilateur C et CGO requis pour -race
npm run test:e2e:install
npm run test:e2e                   # API simulée ; desktop et mobile émulé
npm run test:pdf-integration       # vrai backend Go ; Chromium, Firefox et WebKit
```

Pour limiter le dernier parcours à un moteur ou un test :

```bash
npm run test:pdf-integration -- --project=chromium --workers=1
npm run test:pdf-integration -- --project=firefox -g 'repli SHA-256'
```

Le runner d’intégration reconstruit `dist/` avec les origines et réglages frontend de test, compile un binaire Go temporaire, puis démarre des services locaux simulant Hugging Face, Appwrite et le fournisseur IA. **Le contenu précédent de `dist/` est remplacé** : reconstruire avec les réglages de l’environnement ciblé avant toute publication. Le navigateur est limité à l’origine locale du test. Les données sont synthétiques et les annotations en mémoire disparaissent à la fin ; aucun provisioning, secret ou compte réel n’est nécessaire.

La suite combine le frontend de production construit, PDF.js et l’API Go réelle. Elle couvre sélection et notes, relecture et modification, permissions privées demandées à Appwrite, filtrage et refus d’écriture entre comptes, révision périmée (`409`), plages (`206`), repli SHA-256, Docling indisponible, citations IA, absence des notes privées dans le prompt et annulation du flux jusqu’au fournisseur simulé. Un parcours Chromium mobile émulé vérifie aussi la note persistée et l’assistant. La suite contrôle qu’une liste d’annotations lente ne masque pas une note enregistrée entre-temps. Les parcours navigateur séparés vérifient également modification et suppression pendant une actualisation, ainsi que l’arrivée tardive de Docling pendant une écriture PDF.

Un autre parcours utilise une **passerelle HTTP et un IPC Tauri simulés** avec le même backend Go pour les plages, la session et le streaming ; il n’exécute ni le Rust, ni le protocole natif, ni une WebView. Les tests unitaires et navigateurs séparés couvrent également zoom, rotations, CropBox, sélection multipage, scans sans texte, indexation, pagination, double clic sur l’écriture et changement de mode pendant une écriture.

Les faux services ne reproduisent pas toutes les garanties ou pannes d’Appwrite, du bucket Hugging Face et d’un véritable fournisseur IA. Le Worker Cloudflare n’est pas dans cette pile d’intégration, et les navigateurs Playwright ne remplacent pas les appareils ni les WebView natives. Le workflow `.github/workflows/pdf-reader-checks.yml` prévoit ces contrôles dans les trois moteurs ; `.github/workflows/tauri-build.yml` prévoit les compilations natives ainsi que les tests Rust de contrôle d’origine en modes développement et production. Leur présence n’est pas une preuve d’exécution : consulter les résultats CI.

Avant une diffusion réelle, valider aussi les builds Tauri de la révision courante, l’installation et les parcours sur macOS, iOS, Android et Windows, le Worker déployé, et deux comptes sur un véritable projet Appwrite avec un fournisseur IA configuré. Les anciennes releases ne contiennent pas automatiquement ces modifications.
