# Plan — modifier un document depuis son compte (MS Office et PDF)

Question traitée : **comment ajouter la modification des fichiers depuis le compte
utilisateur**, par exemple les fichiers Microsoft Office (`.docx`, `.xlsx`, `.pptx`) et les
PDF, alors que le site est une visionneuse en lecture sur un bucket Hugging Face.

Analyse et plan ; rien n’est implémenté ici. Deux décisions d’hébergement (§5) et une
levée de doute (§7, phase 0) conditionnent tout le reste.

---

## 1. Verdict, format par format

| Format | « modifier » veut dire quoi | Faisable comment | Coût |
| --- | --- | --- | --- |
| `.docx`, `.xlsx`, `.pptx` | édition réelle, avec mise en forme préservée | **Document Server** (ONLYOFFICE Docs, ou Collabora) dans une iframe, `callbackUrl` qui réécrit le fichier | un hôte Docker **permanent** + 1 aller-retour Worker |
| `.xlsx` / `.csv` | éditer des **valeurs** (pas la charte graphique) | SheetJS — **déjà une dépendance du projet** — avec `XLSX.write` (le dépôt ne l’utilise qu’en lecture : `XLSX.utils.sheet_to_json`) | zéro infrastructure, zéro dépendance nouvelle ; **perte de mise en forme** à assumer |
| `.docx` | remplacer du texte sans toucher à la structure | réécriture des `word/document.xml` dans le ZIP (`jszip`, déjà utilisé par `PptxViewer`/`OdbViewer`) | zéro infra ; fragile, réservé à des remplacements ciblés |
| PDF — remplir un formulaire | valeurs de champs AcroForm | ONLYOFFICE renvoie les **données** en JSON (`formsdataurl`), **pas** un PDF : il faut les réécrire (pypdf côté Space) | 1 endpoint dans la Space existante |
| PDF — réorganiser des pages | rotation, fusion, extrait de pages | `qpdf` (à ajouter à l’image Docker de la Space, qui installe déjà LibreOffice et FreeCAD) | 1 endpoint, très robuste |
| PDF — annoter, surligner, tamponner | marquage léger, sans toucher au texte | côté client avec `pdf-lib` (nouvelle dépendance, ~90 ko gzip), ou annotations via le Space | petit ; à arbitrer |
| PDF — **changer le texte ou l’image** | édition du contenu | **pas par le PDF** : éditer sa source `.docx`/`.odt` puis reconvertir — c’est déjà le pipeline du dépôt (LibreOffice headless) | souvent gratuit : le TD et son PDF coexistent dans le même dossier |
| `.doc`, `.xls`, `.ppt` (binaires) | | pas d’édition : conversion d’abord (la Space sait déjà le faire vers PDF ; l’inverse n’est pas vrai fidèlement) | hors périmètre |
| `.odt`, `.ods`, `.odp` | | ONLYOFFICE les édite nativement ; Collabora aussi ; SheetJS non | idem `.docx` |

Le point d’orgue du tableau : **il n’existe pas de « bouton éditer le PDF »**. Ce qui
existe, c’est éditer la source, ou annoter/remplir/recomposer. Confondre les deux est le
meilleur moyen de promettre une fonctionnalité qui décevra une classe entière.

---

## 2. La contrainte qui decide tout : il faut un service *vivant*

Le dépôt tient sur deux briques sans état durable : le **Worker Cloudflare** (request/response,
aucun processus résident, aucun fichier) et la **Space Hugging Face** (`space-huggingface/`,
Docker, LibreOffice + FreeCAD, écriture dans le bucket via `huggingface_hub`). La première
conséquence est désagréable :

> Un éditeur de documents collaboratifs n’est **pas** un service sans état. Si l’hôte
> d’édition s’endort ou redémarre pendant une session, l’utilisateur ne reçoit qu’un
> « Could not be saved » — c’est-à-dire **ses modifications perdues**.

C’est ce qui sépare ce projet des conversions déjà en place (une conversion qui échoue ne
coûte que du temps). Trois faits à prendre au sérieux :

1. **La limite de connexions d’ONLYOFFICE Community Edition n’existe plus.** Le changelog
   officiel de la 9.4 (mai 2026) indique « Removed the limitation of 20 simultaneously opened
   documents », la suppression du code minifié, le passage en **processus unique** et
   l’**abandon de RabbitMQ et des bases de données** [4](https://helpcenter.onlyoffice.com/docs/docs-changelog.aspx).
   Un Document Server auto-hébergé devient donc une simple boîte Docker, sans dépendance
   externe : c’est ce qui rend la voie réaliste pour un projet de cette taille.
2. **La mise en veille d’un Space HF est incompatible avec une session d’édition.** Les
   relevés publics disent « CPU Basic gratuit = 2 vCPU / 16 Go / ~50 Go **éphémères**,
   endormi après inactivité, démarrage à froid 30–90 s, stockage persistant payant », et
   certains indiquent qu’**un Space Docker demande désormais un plan payant** — chiffres
   divergents selon les sources, donc à vérifier sur la doc HF avant de retenir cette voie
   (§7, phase 0). Le bucket, lui, ne dort pas.
3. **Autres hébergeurs possibles** : n’importe quel conteneur permanent (VPS à 5 €, Fly.io,
   Railway, un poste de l’école sur réseau avec HTTPS). Dimensionnement indicatif relevé
   pour ONLYOFFICE : le rendu étant fait côté client, on annonce environ
   **75 connexions par Go de RAM**, soit de l’ordre de 200–400 connexions sur 4 Go [4](https://autoize.com/building-onlyoffice-document-server-from-source/).
   Une promotion de 30 étudiants en TP est dans cette enveloppe.

Et une conséquence architecturale qui tombe bien : **le Worker Cloudflare peut jouer le rôle
de « document storage service »** que la documentation ONLYOFFICE laisse à l’intégrateur —
c’est un endpoint HTTP public, exactement ce que le callback exige. Aucun serveur applicatif
à nous n’est nécessaire, seul l’hôte du Document Server manque.

---

## 3. Ce que le dépôt fournit déjà

- **Écrire dans le bucket** : `_upload_solidworks_step()` fait `HfApi.batch_bucket_files(...)`
  avec un `HF_TOKEN` d’écriture, en publiant **le fichier et son manifeste de provenance**
  (`derived/step/…`). C’est le patron complet d’une écriture vérifiable ; l’édition doit le
  même chemin, sous un préfixe à elle.
- **LibreOffice headless** dans la Space (`convert_office_to_pdf_bytes`, profil utilisateur
  isolé par conversion pour éviter les verrous concurrents) : la boucle *source Office → PDF*
  existe déjà.
- **Dépendances front utiles** : `xlsx` (SheetJS) et `jszip`, toutes deux chargées à la
  demande dans les visionneuses ; `docx-preview` en lecture seule.
- **Comptes, sessions, profils** : `src/contexts/AuthContext.jsx`, `src/services/appwriteAuth.js`
  — donc « depuis son compte » a un sens : on sait **qui** a modifié.
- **Provisioning idempotent et contrôlable** : `scripts/appwrite-setup.mjs` +
  `scripts/appwrite-spec.js` (`--dry-run`, `--status`, `--fix-enums`, détection de dérive
  d’`enum`) ; le modèle de permissions « `create("users")` sur la table + permissions de
  ligne vers le seul propriétaire » est **déjà validé** pour `favorites`.
- **Garde-fous qui doivent être étendus, pas contournés** : `tests/appwrite-config.test.js`
  interdit une clé serveur dans une variable `VITE_` ; `tests/csp-appwrite.test.js` vérifie
  que chaque hôte tiers figure dans la CSP de `public/_headers`. Un Document Server est un
  hôte tiers de plus — **et de deux façons** : `frame-src` pour l’iframe,
  `connect-src` en `wss://` pour le canal de coédition. L’oublier, c’est un éditeur qui
  fonctionne en `vite dev` et qui est muet en production : le même piège qu’Appwrite.

---

## 4. Architecture cible

```
navigateur ── iframe DocsAPI.DocEditor ──► Document Server (Docker permanent, hôte à choisir)
    ▲                                          │  ① GET  document.url  → https://<site>/api/edit/file/<id>
    │                                          ▼
    │                                   ┌────────────────────────┐
    └── état de session, révision ───── │  Worker Cloudflare     │  ② POST callbackUrl (status 2 | 6)
                                        │  = storage service     │     → télécharge le fichier édité
                                        └──────────┬─────────────┘     → vérifie sha256, écrit la révision
                                                   │                    → répond {"error":0}
                                                   ▼
                              Appwrite Storage `editions` (brouillon, par ligne = par auteur)
                                                   │  « Publier sur la bibliothèque » (rôle enseignant)
                                                   ▼
                              Space → bucket HF `derived/editions/<sha16(path)>-<n>.docx` + manifeste
```

Quatre règles rendent le schéma tenable, toutes issues de la doc officielle :

1. **`document.key` est régénéré à chaque sauvegarde.** La documentation est explicite :
   le serveur d’édition ne retélécharge pas le fichier si la clé ne change pas, et
   l’erreur « The file version has been changed » vient de là [1](https://api.onlyoffice.com/docs/docs-api/more-information/troubleshooting/).
   Proposition : `key = sha16(path) + '-' + revision`, incrémenté à chaque callback réussi.
2. **Le handler répond `{"error": 0}`**, sinon l’éditeur affiche l’erreur — et c’est
   **voulu** : un `{"error": 1}` (ou un HTTP 500) sur un échec d’écriture est le seul moyen
   d’empêcher la perte silencieuse, et ONLYOFFICE retente le callback [3](https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler/).
   C’est la transposition exacte de la règle retenue pour les favoris : *une écriture ne doit
   jamais échouer en silence*.
3. **On ne prend jamais un URL fourni par le client.** `document.url` et `callbackUrl` sont
   construits par le Worker, et l’URL `url` du callback n’est rappée que si son hôte est
   celui du Document Server (allowlist) — sinon le Worker devient un proxy SSRF.
4. **Les statuts 1 (édition), 4 (fermé sans changement) et 7 (force-save en erreur) ne
   déclenchent aucune écriture** ; seuls 2 (à sauvegarder) et 6 (force-save) portent un `url`
   exploitable [4](https://www.bookstack.cn/read/onlyoffice-ds-7.3-en/5374ed752649ee6b.md).

---

## 5. Où vivent les modifications (la vraie décision de conception)

Un bucket public de ressources pédagogiques n’est **pas** un disque réinscriptible : `.docx`
écrasé = TD saccagé pour toute l’école, sans historique lisible dans le site. Donc :

| Endroit | Brouillon personnel | Publication | Qui peut écrire | Persistant | Déjà provisionné |
| --- | --- | --- | --- | --- | --- |
| **Appwrite Storage `editions`** | ✅ | — | l’auteur seul (permissions par fichier) | ✅ | ❌ (nouveau bucket, + `role` dans `profiles`) |
| **Bucket HF `derived/editions/…`** | ⚠️ (visible publiquement) | ✅ | le Space, sur jeton serveur | ✅ | ✅ (le chemin existe) |
| **Overwrite du chemin original** | ❌ | ✅ | rôle enseignant uniquement | ✅ | — |

Recommandation : **brouillon dans Appwrite Storage, publication dans le bucket sous préfixe
`derived/editions/`, et écrasement de l’original explicitement interdit** (ou, si un usage
d’archivage le justifie plus tard, réservé au rôle enseignant et toujours accompagné du
manifeste de provenance à la manière de `derived/step`).

Conséquences concrètes :

- un bucket de stockage Appwrite `editions`, créé par `scripts/appwrite-setup.mjs` (même
  discipline : modèle dans `appwrite-spec.js`, `--status` qui vérifie les permissions réelles),
  avec `create("users")` et, par fichier, `Permission.read/update/delete(Role.user(userId))` ;
- **une révision de travail par (utilisateur, chemin source)** : `ID.custom(userId + ':' + sha16(path))`
  → deux onglets ouverts sur le même fichier écrivent la même révision, un camarade ne voit
  jamais la tienne, et le réessai est inoffensif (le précédent `profiles` utilise déjà
  `ID.custom`) ;
- la table `editions` (TablesDB) porte les métadonnées : `userId`, `sourcePath`, `storageFileId`,
  `sha256`, `bytes`, `revision`, `publishedAt` ; une écriture qui a réussi **sans** ligne est
  une écriture perdue, donc le hook affiche l’état des deux écritures séparément ;
- `profiles.role`, nouvel `enum` (`etudiant`, `enseignant`, `biblio`) : seul le rôle qui publie
  déclenche `derived/editions/…`. `--fix-enums` gère l’ajout ; l’interface doit refuser une
  publication par un compte sans rôle plutôt que de l’accepter silencieusement.

---

## 6. Le cas PDF, traité sérieusement

1. **Formulaire** : ONLYOFFICE remplit les champs, puis envoie `formsdataurl` (JSON) —
   **il ne renvoie pas un PDF modifié** [5](https://deepwiki.com/ONLYOFFICE/DocumentServer/9-development-roadmap).
   Il faut donc un `POST /api/pdf-form-fill` dans la Space (pypdf, `update_page_form_field_values`)
   qui réécrit les valeurs dans le PDF. À valider en phase 0 sur un vrai sujet d’ENISE :
   les champs des PDF de cours sont souvent absents (PDF « aplatis » depuis Word) — **sans
   champs AcroForm, il n’y a rien à remplir**, et l’interface doit le dire au lieu d’ouvrir un
   formulaire vide.
2. **Pages** : rotation, découpe, fusion, extraction — `qpdf`, quelques lignes dans le
   `Dockerfile`, aucune ambiguïté de fidélité. C’est le meilleur rapport valeur/risque de
   toute la fonctionnalité, et il ne demande pas de Document Server.
3. **Annotations** : surlignage, notes, tampons. Soit `pdf-lib` côté client (dépendance
   nouvelle, mais le fichier ne quitte pas le navigateur — argument à faire valoir au RGPD
   pour des copies d’étudiants annotées), soit un `POST /api/pdf-annotate` dans la Space.
4. **Contenu** : éditer la **source**. Beaucoup de TD existent en `.docx` **et** en `.pdf`
   dans le même dossier : le bouton doit alors s’appeler « Modifier la source du PDF » et
   reconvertir, avec le PDF régénéré comme conséquence visible. Si la source n’existe pas,
   on n’offre pas l’édition de contenu — on l’explique.

Un PDF « éditable » sans précision est une promesse invendable en fac : chaque bouton doit
nommer l’opération réelle.

---

## 7. Phasage

### Phase 0 — levée du doute (1 j, bloquante)

1. Monter un ONLYOFFICE Docs 9.4 (image Docker officielle) sur **n’importe** quel hôte HTTPS
   joignable, même un laptop sur le réseau de l’école avec un tunnel.
2. Vérifier les trois canaux : `frame-src` + `connect-src wss://` dans `public/_headers`,
   le Document Server capable de joindre `https://<site>/api/edit/file/<id>`, et le Worker
   capable de rappeler l’hôte du serveur.
3. Faire un aller-retour complet sur un `.docx` : ouverture, modification, fermeture, callback
   `status 2`, téléchargement de `url`, écriture, `{"error": 0}`, **nouvelle clé** regénérée,
   réouverture montrant la modification.
4. Tester le comportement quand le serveur **s’endort/redémarre en pleine session** (le pire
   scénario utilisateur) et confirmer que `forcesave` limite la perte.
5. Trancher l’hébergement permanent (Space HF payant ? VPS ? machine de l’école ?) et vérifier
   sur la doc HF : création d’un Space Docker avec un compte gratuit, politique de veille,
   prix du stockage persistant.

**Critère** : une vidéo ou une transcription HTTP prouvant l’aller-retour, et un chiffre de
coût mensuel pour l’hébergement. Sans ça, on écrit un plan sur du sable.

### Phase 1 — éditions sans Document Server (1 à 2 j)

- `GET /api/edit/capabilities?path=…` : pour un fichier donné, ce qui est réellement
  modifiable (formulaire PDF avec champs ? source Office à côté du PDF ? tableur seulement ?)
  et **pourquoi** le reste est refusé.
- Endpoint Space `POST /api/pdf-pages` (qpdf) puis `POST /api/pdf-form-fill` (pypdf).
- Tableur : édition de valeurs via SheetJS côté client, avec l’avertissement explicite sur la
  mise en forme ; écriture dans le brouillon Appwrite.
- Provisioning : bucket `editions`, table `editions`, `profiles.role` ; `npm run appwrite:setup`
  et `--status` étendus ; tests de plan dans `tests/appwrite-provisioning-plan.test.js`.
- UI : un onglet « Modifier » dans `PreviewModal`, **désactivé avec sa cause** quand les
  capacités le disent — même discipline d’états que les favoris.

### Phase 2 — Document Server (2 à 3 j)

- `POST /api/edit/session` (fabrique config + JWT signé côté Worker), `GET /api/edit/file/<id>`
  (brouillon ou source, session vérifiée), `POST /api/edit/callback` (statuts, `sha256`,
  révisions, `{"error":0|1}`), `GET /api/edit/state`.
- `src/components/OfficeEditor.jsx` (iframe + `DocsAPI.DocEditor`), repli propre si le serveur
  est injoignable (état, pas d’iframe grise), et `test csp` étendu pour exiger l’hôte dans les
  deux directives.
- Journal de révisions consultable (qui, quand, sha256) : c’est ce qui rend l’édition
  acceptable pédagogiquement.

### Phase 3 — publication contrôlée (1 j)

- Bouton « Publier sur la bibliothèque », réservé au rôle qui peut le faire, écrivant sous
  `derived/editions/…` + manifeste (auteur, source, date, sha256, dépendances), à la manière
  du STEP dérivé.
- Demande de publication → notification à un enseignant (mail Appwrite ou simple file
  d’attente listée dans son panneau de compte, pas d’e-mail non demandé).

### Phase 4 — collaboratif (option)

- Coédition : mêmes clés partagées par plusieurs `users`, commentaires/modération, verrou
  d’un PDF publié. Uniquement si un usage de TP le justifie : la coédition multiplie les
  connexions (une session ouverte = une connexion, pas un utilisateur) et complique la
  notion de révision.

---

## 8. Critères d’acceptation

1. Aucun fichier **original** du bucket n’est écrasé par un chemin d’édition ordinaire : la
   seule écriture possible est `derived/editions/…`, tracée dans un manifeste.
2. Toute sauvegarde affichée comme réussie est **revérifiable** : révision, octets, sha256,
   et la relecture du fichier écrit (écrit = relu, pas « je crois que ça a marché »).
3. Un échec d’écriture est envoyé au Document Server sous forme `{"error": 1}`/HTTP 500 et
   visible dans l’interface ; jamais un `{"error": 0}` de complaisance.
4. Un utilisateur non connecté, ou sans rôle de publication, ne peut pas déclencher une écriture
   dans le bucket ; le refus est nommé.
5. Les capacités d’édition sont expliquées fichier par fichier : pas de bouton grisé sans
   raison, pas de « Modifier le PDF » qui ouvre en fait un éditeur de texte.
6. `public/_headers` contient l’hôte du Document Server dans `frame-src` **et** `connect-src`
   (`wss://`), et un test l’affirme ; `npm run check` passe.
7. Aucune clé (JWT du Document Server, `HF_TOKEN`, Appwrite) n’apparaît dans `src/` ni dans
   une variable `VITE_` ; toutes en secrets du Worker (`wrangler secret put`) et listées dans
   `.dev.vars.example` + `scripts/check-dev-vars.mjs`.
8. Si l’hôte d’édition est endormi ou coupé, l’utilisateur voit un état explicite, et une
   sauvegarde déjà faite n’est pas perdue.

---

## 9. Sécurité (à traiter comme des critères, pas comme une annexe)

- **JWT dans les deux sens** : `services.CoAuthoring.secret.inbox`/`outbox` ; depuis la 7.2
  le JWT est activé par défaut et le secret est généré [1](https://helpcenter.onlyoffice.com/integration/owncloud.aspx).
  Un callback non signé doit être rejeté par le Worker, sinon n’importe qui peut nous faire
  écrire un fichier.
- **Allowlist d’hôtes** pour l’`url` du callback : le Worker ne télécharge que depuis l’hôte du
  Document Server, sinon on construit un voleur de fichiers interne.
- **URL courte durée de vie** pour `document.url` (jeton signed avec `exp` à ~5 min) même si le
  bucket est public en lecture : les brouillons, eux, ne sont **pas** publics.
- **Validation de chemin** réutilisant les gardes du Worker (`/api/files`), plafond de taille
  (`MAX_*`), et compteur par utilisateur dans `METADATA_KV` : un éditeur de documents est aussi
  un service de conversion gratuit pour le reste d’Internet.
- `frame-ancestors 'self'` : l’iframe est chez nous, pas l’inverse.
- **Données personnelles** : un PDF de copie d’étudiant qui transite par un service tiers
  doit être déclaré/passé au crible du service informatique ; l’option `pdf-lib` côté client
  (rien ne quitte le navigateur) est à préférer pour ce cas.

---

## 10. Décisions à prendre

1. **Hébergement permanent** du Document Server : Space HF payant, VPS, ou machine de l’école
   en HTTPS ? (chiffre mensuel à produire en phase 0)
2. **ONLYOFFICE ou Collabora** : ONLYOFFICE a l’avantage d’un format natif Office (OOXML) et
   d’un `callbackUrl` simple ; Collabora (LibreOffice) est plus fidèle sur certains fichiers
   légués mais exige une **implémentation WOPI côté nous** (`CheckFileInfo`/`GetFile`/`PutFile`),
   soit plus de surface à sécuriser. Recommandation : ONLYOFFICE, et Collabora comme repli si
   un `.doc` légué résiste mal.
3. **Brouillons** : Appwrite Storage (recommandé) ou un préfixe du bucket `derived/editions`
   (zéro provisioning mais exposition publique).
4. **Rôle** : un `enum` unique dans `profiles` (`etudiant`/`enseignant`/`biblio`) ou une table
   de droits séparée ? Le premier suffit au début et `--fix-enums` le fait vivre.
5. **Dépendances front** : accepte-t-on `pdf-lib` (~90 ko) pour l’annotation locale, ou tout
   passe par la Space ?
6. **Licence** : ONLYOFFICE Docs est AGPL ; cela oblige l’**opérateur du serveur** (le repo n’en
   devient pas AGPL, le frontend reste indépendant), mais l’école doit l’assumer. À faire
   valider, comme pour HOOPS dont le binaire est hors Git.
7. **Fichiers légués** (`.doc`, `.xls`) : conversion vers OOXML au premier édition ? (perte de
   macros, mise en page parfois) et que répond-on quand la conversion échoue.
8. **Après publication** : la source Office est-elle régénérée en PDF systématiquement
   (cohérence du catalogue) ou sur demande ?

## Références techniques

- Callback handler (statuts 1/2/3/4/6/7, `url`, `changesurl`, `users`, `forcesavetype`,
  réponse `{"error":0}`) : https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler/
- Dépannage officiel (clé à régénérer, « Could not be saved », jeton invalide, `url`
  inaccessible depuis le conteneur) : https://api.onlyoffice.com/docs/docs-api/more-information/troubleshooting/
- Intégration (champ `url`, `callbackUrl`, `key` = UUID + horodatage de modification, JWT
  activé par défaut depuis 7.2 et secret dans `local.json`, formats PDF/DJVU/DOCXF/OFORM) :
  https://helpcenter.onlyoffice.com/integration/owncloud.aspx
- Changelog 9.4 (20 connexions supprimées, processus unique, plus de RabbitMQ ni de base) :
  https://helpcenter.onlyoffice.com/docs/docs-changelog.aspx — annonce :
  https://www.onlyoffice.com/blog/2026/05/onlyoffice-docs-9-4
- Paramètres de connecteur utiles à reprendre (`defFormats`, `editFormats`,
  `customization_forcesave`, `customization_autosave`, `disable_download`,
  `DocumentServerInternalUrl`, `StorageUrl`) :
  https://api.onlyoffice.com/docs/docs-api/get-started/ready-to-use-connectors/nextcloud-integration/
- Formulaire PDF : données renvoyées en `formsdataurl` (JSON), et non un PDF modifié :
  https://deepwiki.com/ONLYOFFICE/DocumentServer/9-development-roadmap
- Dimensionnement indicatif (rendu côté client, ~75 connexions/Go) :
  https://autoize.com/building-onlyoffice-document-server-from-source/
- Hugging Face Spaces (matériel gratuit, disque éphémère, veille, Space Docker et plan
  payant : **à confirmer sur la doc officielle**, sources secondaires divergentes) :
  https://huggingface.co/docs/hub/spaces-overview
- Docs internes du dépôt : `docs/HOOPS_SOLIDWORKS_STEP_FEASIBILITY.md` (écriture dans le
  bucket + manifeste de provenance, contrat de service borné),
  `docs/APPWRITE_AUTH_PLAN.md` (modèle de permissions, provisioning idempotent, `role.users`
  refusé pour `create`), `docs/FREECAD_WEB_AUTHORING_PLAN.md` (la Space comme lieu
  d’exécution), `docs/ONSHAPE_FOLDER_IMPORT_PLAN.md` (§5 : la discipline « une écriture ne doit
  jamais échouer en silence » appliquée à un service tiers).
