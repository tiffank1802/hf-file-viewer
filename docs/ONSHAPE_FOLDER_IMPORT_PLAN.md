# Faisabilité & plan — un dossier = un document Onshape contenant tous ses fichiers

Question traitée : **insérer programmatiquement tous les documents 3D d’un dossier du
bucket dans un document Onshape**, de sorte que chaque dossier de la bibliothèque
corresponde à un document Onshape regroupant les fichiers de ce dossier.

Ce document est une analyse et un plan. **Aucune ligne de production n’est écrite** :
la phase 0 ci-dessous est bloquante et demande un compte Onshape + une paire de clés
d’API, que ce dépôt ne peut pas se procurer seul.

---

## 1. Verdict

| Point | Réponse | Conséquence pour le plan |
| --- | --- | --- |
| Peut-on importer un fichier CAD dans un document **existant** par API ? | **Oui** — `POST /api/v6/translations/d/{did}/w/{wid}` en `multipart/form-data`, la traduction en `ONSHAPE` étant le comportement par défaut | Le geste « insérer dans le document du dossier » est scriptable |
| Peut-on créer le document par API ? | **Oui** — `POST /api/v10/documents` avec `{"name": …}` | `dossier → document` est mécanique |
| Tous les fichiers du dossier atterrissent-ils dans **un seul onglet** ? | **Non**, pas tel quel : chaque import crée ses propres onglets (une Part Studio par partie/assemblage traduite, plus un onglet blob pour le fichier source) | Il faut choisir une **forme** (voir §3) ; la forme recommandée est « un document, un onglet par fichier » |
| Le nom de l’onglet vient-il de nous ? | **Oui, indirectement** : à l’import, « *the file name becomes the new tab name* » | On contrôle le nom d’onglet par le `filename` du part `multipart` |
| Formats 3D du dépôt acceptés par Onshape ? | STEP/IGES/Parasolid/ACIS, `.sldprt` (1999→2026), Inventor, CATIA v5, STL/OBJ, glTF 2.0, 3MF, DWG/DXF (mise en plan) | La plupart de nos fichiers passent **en natif**, sans repasser par HOOPS |
| Formats 3D du dépôt **refusés** | Revit (`.rvt`/`.rfa`), Navisworks (`.nwc`/`.nwd`/`.nwf`), IFC, `.fbx`, `.skp`, `.3ds`, `.max`, `.ma`/`.mb`, `.dwf` | Pour ceux-là, seule une **réexportation** (3MF/glTF/STEP) est possible |
| Import maillage (`.stl`, `.obj`) | Accepté, **mais « view and reference meshes only, unable to edit a mesh »** | Un STL importé reste consultatif dans Onshape : à dire aux étudiants |
| Taille maximale d’un fichier importé | **4 Go par fichier** | Largement au-dessus de nos plafonds actuels (25 Mo pour le GLB, 100 Mo pour SolidWorks) |
| Coût d’appel | **2 à 4 appels par fichier** + 2 à 3 par document | Voir §5 : c’est **la** contrainte structurante |
| Budget API annuel | EDU Student / Free / Standard : **2 500 appels/utilisateur/an** ; EDU Educator & Pro Discovery : 2 500/entreprise ; Professional : 5 000/utilisateur ; Enterprise : 10 000/utilisateur ; EDU Enterprise : 10 000/entreprise. Dépassement → réponse **402** | Un backfill complet de la bibliothèque est **impossible** sur un compte étudiant ; il doit être déclenché à la demande, ou via une application publiée (les appels OAuth2 d’une app du App Store **ne comptent pas**) |
| Cadence | Limites par endpoint non chiffrées publiquement : le guide Onshape impose un **backoff exponentiel** et une réponse `429` au dépassement (des en-têtes de quota ont été observés dans les réponses, à confirmer en phase 0) et déconseille de poller plusieurs fois par seconde | Polling borné, ou webhook `onshape.model.translation.complete` |
| Écriture dans un document partagé | Permissions par document Onshape (vue/édition par utilisateur ou équipe), pas par ligne | Un lien `public=true` rend le contenu publiquement lisible : décision à prendre (§8) |

**En l’état, la demande est réalisable, avec une forme à arbitrer et un budget à
tenir.** Le risque n’est pas géométrique (Onshape lit nos formats nativement), il est
**administratif et comptable** : quota annuel, propriété des documents, et fichiers
non traduisibles.

---

## 2. Ce que le dépôt fournit déjà

Le travail à faire est surtout de **câblage** : presque toutes les pièces du pipeline
existent déjà pour la conversion SolidWorks → STEP et pour Autodesk.

- **Énumérer les fichiers d’un dossier** : `GET /api/tree?prefix=…` côté Worker, servi par
  l’API publique du bucket (`/api/buckets/{bucket}/tree{prefix}`), et `fetchTree(prefix)`
  côté client. Aucune innovation nécessaire.
- **Rassembler le contenu d’un dossier en un paquet** : `collectSolidworksDependencies()`
  prend déjà **tous les fichiers SolidWorks frères du même préfixe**, avec plafond
  (`MAX_SOLIDWORKS_DEPENDENCY_FILES=64`, `MAX_SOLIDWORKS_BUNDLE_BYTES=250 Mo`) et
  empreintes SHA-256 par fichier. C’est très exactement la sémantique « un dossier = un
  paquet » demandée.
- **Idempotence par empreinte** : `POST /api/solidworks/step` recalcule l’empreinte de la
  source et de ses dépendances, réutilise un STEP identique et régénère sur demande
  (`force`). Ce mécanisme se transpose tel quel en « ne pas réimporter un dossier
  inchangé ».
- **Modèle complet pour un SaaS tiers** : la route Autodesk (`/api/aps/token`,
  `/api/aps/view`, `/api/aps/status`) fait déjà *demander une URL de téléversement →
  pousser les octets → valider → suivre l’état → mettre en cache dans `METADATA_KV`*.
  Un import Onshape a la même forme ; on copie la structure, pas le code.
- **Enregistrement des résultats** : le binding KV `METADATA_KV` existe (`KV_CACHE_TTL`),
  avec `readMetadataKv`/`storeMetadataKv`. Le mapping `dossier → document Onshape` y a sa
  place, pas dans le bucket.
- **Convention d’outillage** : `scripts/appwrite-setup.mjs` + `scripts/appwrite-spec.js`
  (le modèle et les chemins vivent dans le spec testé ; `--dry-run`, `--status`, le run
  réel consomment le même plan et ne peuvent pas diverger) et `scripts/check-dev-vars.mjs`
  (les variables requises sont vérifiées). **Le plan applique la même discipline** :
  `scripts/onshape-spec.js` + `scripts/onshape-import.mjs` + `--dry-run`/`--status`.
- **Précédent d’exécution locale** : `scripts/convert-solidworks-local.py` et
  `scripts/README_SOLIDWORKS_LOCAL.md` exécutent une conversion sur la machine d’un
  enseignant puis ne publient que le résultat dans le bucket. C’est le **repli naturel**
  pour un backfill qui dépasserait le quota du Worker (voir §5).
- **Garde-fous existants** : `tests/appwrite-config.test.js` interdit une clé serveur dans
  une variable `VITE_` ; `npm run check` (lint + tests Node + build) est la porte d’entrée.

---

## 3. Les trois formes possibles pour « le document contient les fichiers »

### Forme A — un document par dossier, un onglet par fichier *(recommandée)*

1. `POST /api/v10/documents` → `{"name": "<nom lisible du dossier>"}`.
2. Pour chaque fichier traduisible du dossier : `POST /api/v6/translations/d/{did}/w/{wid}`
   avec `file` (nom de part = `<fichier>.<ext>`), `storeInDocument=true`,
   `formatName=` vide (= traduction en `ONSHAPE`).
3. `GET /api/v6/translations/{translationId}` jusqu’à `requestState ∈ {DONE, FAILED}`.
4. `GET /api/v6/documents/{did}/elements` pour retrouver les onglets créés et les associer
   aux chemins d’origine.

Résultat dans Onshape : une Part Studio (ou une Assembly) par fichier importé, **plus**
l’onglet blob contenant le fichier tel qu’envoyé. Autrement dit, le document contient
littéralement les fichiers du dossier et leurs traductions exploitables. Chaque onglet
s’appelle comme le fichier, sans travail de renommage.

- Coût : ~2 à 4 appels par fichier + 3 par document.
- Fidélité : B-rep éditable pour STEP/Parasolid/SolidWorks ; maillage consultatif pour STL/OBJ.
- Risque : **le nombre d’onglets**. Un dossier de 60 fichiers fait 60+ onglets ; Onshape
  les aligne horizontalement, ça se parcourt mais ce n’est pas joli.

### Forme B — A, plus les assemblages reconstitués

Ajout sur les dossiers qui contiennent des `.sldasm` / `.iam` : fabriquer le **Pack-and-Go**
que la documentation Onshape attend — un `.zip` **nommé exactement comme l’assemblage
racine**, **aplati** (pas de sous-dossiers), contenant l’assemblage et toutes ses pièces,
**sans caractères spéciaux** dans les noms. Le collecteur de dépendances existant fournit
déjà les octets et l’aplatissement est trivial ; le nom d’onglet devient l’assemblage, avec
sa structure de composants et ses instances.

- Coût : +1 appel par assemblage, mais remplace N imports de pièces par 1 import.
- Bénéfice : c’est la seule forme qui **préserve la structure** d’un assemblage.
- Piège : nos noms de fichiers sont français et accentués (`GM/3A GM/méca.sldasm`) ; la
  exigence « no special characters » impose un **assainissement** du nom du zip, et donc un
  aller-retour nom court ↔ nom réel. D’où le manifeste ci-dessous, utile dans toutes les formes :

> Un `manifest.json` de quelques kilo-octets est importé comme blob dans le document :
> il liste, par onglet, le chemin d’origine dans le bucket, l’empreinte SHA-256, le
> traducteur utilisé et l’état. Le document devient auto-descriptif, l’écart de nommage
> est rattrapable à la main, et le site n’a pas besoin d’une base pour expliquer ses onglets.

### Forme C — un seul Part Studio contenant tous les corps

« Tous les fichiers dans un onglet » n’est pas ce que fait l’API : `flattenAssemblies=true`
aplatit **la structure d’un fichier d’assemblage**, il ne fusionne pas deux fichiers entre
eux. Deux voies seulement :

1. **fusion en amont** : demander à HOOPS (ou FreeCAD) de combiner les parties du dossier
   en un unique STEP/Parasolid multi-corps, puis importer ce seul fichier → Onshape crée
   une Part Studio à N corps. Coût : un import au lieu de N, mais géométrie perdue en tant
   que *pièces nommées*, et un point dur de conversion de plus (le dossier entier doit
   passer par le convertisseur).
2. **FeatureScript** : une feature custom qui assemble des corps importés dans le même
   Part Studio. C’est du développement Onshape spécifique, hors périmètre d’un simple
   import, et non maintenable pour un cours.

**Recommandation : refuser C par défaut**, et la proposer uniquement en option manuelle
« dossier → scène unique » pour les très gros fourre-tout. La valeur pédagogique demandée
(ouvrir un dossier et trouver tous ses fichiers dans Onshape) est servie par A, et par B
dès qu’il y a un assemblage.

---

---

## 3 bis. Variante « paquet unique » : un envoi, N onglets, un lien par fichier

Idée examinée après coup : **fabriquer un paquet unique par dossier, l’envoyer en une
seule fois, puis poser à l’emplacement de chaque fichier CAO du site un lien vers la
pièce correspondante dans ce document.** C’est la bonne direction — c’est le budget
d’appels qui commande — mais **le zip n’est pas le bon contenant**, et le lien ne peut
pas viser n’importe quoi. Trois faits le décident.

### a) Un zip de pièces libres n’est pas traduit

Onshape n’accepte un `.zip` que s’il contient **un fichier d’assemblage racine**, et ce
fichier doit porter **le même nom que le zip** — règle documentée, et confirmée par
l’équipe Onshape : si plusieurs assemblages existent sans que l’un d’eux porte le nom du
zip, « *we will still fail the translation* » ; un zip de parties sans assemblage ne
donne rien d’exploitable ([forum : règle du nom](https://forum.onshape.com/discussion/407/importing-a-sw-assembly),
[aussi : « le zip n’est importable que s’il contient un assemblage et ses pièces »](https://forum.onshape.com/discussion/25988/step-files-not-translating)).
Nos dossiers de cours contiennent des `.step`, `.stp`, `.iges`, `.sldprt`, `.stl`
**indépendants** : les zipper produit un paquet que la traduction refuse ou ignore. Le zip
reste donc pertinent **uniquement** pour reconstituer un assemblage (forme B).

### b) Le bon contenant est un **STEP multi-racines que nous fabriquons**

`POST /translations/d/{did}/w/{wid}` accepte bien plus que le minimum documenté dans le
guide. Les champs réellement exposés (relevés sur le client officiel, API v16 :
[TranslationApi.md](https://github.com/onshape-public/go-client/blob/master/onshape/docs/TranslationApi.md))
incluent `onePartPerDoc`, `splitAssembliesIntoMultipleDocuments`, `importWithinDocument`,
`extractAssemblyHierarchy`, `flattenAssemblies`, `createComposite`, `allowFaultyParts`,
`encodedFilename`, `uploadId`, `ownerId`, `parentId`, `makePublic`, `notifyUser`, `unit`,
`useIGESImportPostProcessing`. Deux conséquences :

- `GET /translations/d/{did}` permet de consulter l’état de **toutes** les traductions
  d’un document en **un seul appel** (au lieu d’un poll par fichier) ; `DELETE /translations/{tid}` nettoie.
- `storeInDocument=true` avec `onePartPerDoc=false` laisse à Onshape le soin de créer
  **un onglet par partie ou assemblage traduit** : « *Supported CAD files create two or
  more tabs — one for the original uploaded file, and one for each translated part or
  assembly* » ([importer des fichiers](https://cad.onshape.com/help/Content/Document/importing_files.htm)),
  et les onglets sont « *named according to the names in the imported file* ».

D’où la chaîne qui réalise l’idée :

1. dans la Space existante (`space-huggingface/app.py`, qui importe déjà FreeCAD), un
   endpoint `POST /api/merge-step` : importer les N fichiers traduisibles du dossier dans
   un document FreeCAD, **nommer chaque racine** d’après le nom de fichier
   (`piece-step-GM-3A-GM-meca` — voir d), puis `Part.export(racines, « dossier.step »)` :
   le STEP résultant contient **N racines nommées** ;
2. **une seule** `createTranslation` de ce STEP vers le document du dossier
   (`storeInDocument=true`, `onePartPerDoc=false`, `createComposite=false`,
   `allowFaultyParts=true` pour ne pas perdre une pièce sur un défaut isolé) ;
3. `GET /translations/d/{did}` jusqu’à `DONE`, puis `GET /documents/{did}/elements` :
   c’est la **table de correspondance nom d’onglet → élément**, écrite dans le KV ;
4. le site affiche, sur la ligne de chaque fichier CAO, un lien
   `https://cad.onshape.com/documents/{did}/w/{wid}/e/{eid}` — granularité **d’onglet**,
   qui est celle que la documentation garantit : « *our URLs are Document, Workspace or
   version and element specific, you can send them a link to the exact version/tab you
   want* ».

**Budget : ~6 appels par dossier** (1 document + 1 envoi + 2 à 3 polls groupés + 1 listing),
contre ~40 en un-import-par-fichier. À 2 500 appels/an, on passe de ~60 à **~400 dossiers**.

### c) Ce que le lien ne peut pas garantir : la granularité « corps »

Un lien vers **un corps précis** d’une Part Studio n’est pas documenté comme adresse
publique ; le partage par lien porte sur les onglets (Part Studio, Assembly, dessin,
images et PDF joints) et ne nécessite pas de compte —
[Share Documents](https://cad.onshape.com/help/Content/Collaboration/share_documents.htm) —
tandis que « *Link document* » est la permission à cocher si l’on veut qu’un autre document
Onshape pointe vers une pièce. Conséquence architecturale, et c’est le point sensible :

- si le STEP multi-racines donne **N onglets** → chaque fichier du site a son lien exact,
  l’idée est servie intégralement ;
- si Onshape produit **un seul onglet à N corps** → le lien ne peut viser que l’onglet, et
  plusieurs fichiers du site pointeraient au même endroit : trompeur.

**La phase 0 doit trancher cette question**, et le plan ne doit donc **pas** parier dessus.
Le routeur d’import choisit sa forme à partir du résultat réel :

```
importer(mergedStep) → elements
   ├─ un onglet par nom deracine attendu  → forme « paquet » (1 appel), liens par fichier
   ├─ un seul onglet multi-corps         → repli forme A : N imports, 1 onglet par fichier
   └─ échec partiel                       → retenter en excluant les fichiers fautifs,
                                            marquer `skipped` + raison (jamais de silence)
```

Le **manifeste** importé dans le même document (`manifest.json` en blob) garde, par
fichier : chemin bucket, empreinte SHA-256, nom de racine, `elementId` résolu. Le site
n’a donc aucune logique de devinette : il lit la table, et s’il n’y a pas d’onglet pour
un fichier, il affiche le lien du document avec la mention explicite « la pièce est dans
l’onglet X » plutôt qu’un lien faux.

### d) Noms : l’assainissement casse l’appariement, il faut le prévoir

Les règles Onshape (pas de caractères spéciaux dans un paquet, nom d’onglet issu du nom de
fichier) entrent en conflit avec nos chemins réels : `GM/3A GM/méca TD 1.sldprt`.
Ces deux exigences incompatibles — lien exact par nom, nom lisible dans l’onglet — se règlent par un
**nom de racine déterministe et réversible** :

```
stem = "GM-3A-GM__meca-TD-1"        // accents, espaces, diacritiques retirés,
                                     // chemin d'origine replié dans le nom
```

- la **fonction d’assainissement est testée** (collision détectée → suffixe `~2`, `~3`, et
  la collision est reportée dans le manifeste : deux fichiers du même dossier qui se
  resanitisent à l’identique ne peuvent pas être appariés par nom) ;
- le nom affiché dans l’interface Onshape sera moins joli que le nom réel : c’est le prix
  d’un lien exact sans passer par l’API de métadonnées (qui exige un `propertyId` opaque
  et un aller-retour de plus par onglet).


---

## 4. Modèle de données proposé

Aucune nouvelle table Appwrite n’est nécessaire au démarrage : le mapping est un cache de
service, pas une donnée utilisateur (leçon du travail sur les favoris : ce qui doit être
vrai vit dans un système qui le garantit ; ici le système qui garantit l’existence du
document, c’est Onshape lui-même, et le KV n’est qu’un index de rattrapage).

```
clé KV  : onshape:{bucketId}:{sha256(folderPath).slice(0,16)}
valeur  : {
  folderPath, documentId, workspaceId, publicAt?,
  fingerprint,              // sha256 du tri {path, sha256} de TOUS les fichiers du dossier
  importedAt, updatedAt,
  tabs: [{ path, elementId, tabName, state: "done" | "failed" | "skipped", reason? }],
  manifest: { elementId, sha256 },
  state:  "upToDate" | "stale" | "partial" | "failed" | "unconfigured" | "quotaReached"
}
```

- `fingerprint` : même recette que le manifest de dépendances SolidWorks → un dossier dont
  un seul fichier change est marqué `stale`, les autres ne sont pas retouchés.
- `state` est **affiché tel quel** dans l’interface, avec la cause (`reason`), et un bouton
  « Réessayer ». `unconfigured` et `quotaReached` doivent se distinguer : c’est exactement la
  classe de bug où une permission ou un quota manquant se déguise en « rien à montrer ».
- Une route `GET /api/onshape/status` (miroir de `/api/solidworks/status`) répond : clés
  présentes ? endpoint joignable ? formats acceptés récupérés (`GET /api/v6/translations/translationformats`)
  ? quota restant si l’API l’expose ? — sans jamais renvoyer de secret.

Le Worker ne stocke **aucun jeton** côté client : `ONSHAPE_ACCESS_KEY`, `ONSHAPE_SECRET_KEY`
(ou `ONSHAPE_REFRESH_TOKEN`) vivent en `wrangler secret`, sont listés dans
`.dev.vars.example` et vérifiés par `scripts/check-dev-vars.mjs`.

---

## 5. Budget d’appels : le vrai sujet d’architecture

Un exemple concret, avec un dossier de **12 fichiers** dont 2 assemblages (forme B) :

| Opération | Appels |
| --- | --- |
| création du document | 1 |
| 10 imports de pièces (1 `POST` + ~2 polls) | 30 |
| 2 imports d’assemblages (zip) | 6 |
| import du manifeste | 1 |
| listing des éléments (2 ×) | 2 |
| **total dossier (forme A/B, un envoi par fichier)** | **≈ 40** |
| **total dossier (variante §3 bis, paquet unique + polls groupés)** | **≈ 6** |

À 2 500 appels/an (compte EDU Student ou Free), le plafond est atteint vers **60 dossiers**.
À 10 000 (EDU Enterprise / Enterprise), environ **250 dossiers**. D’où les règles de conception,
dans l’ordre d’efficacité :

1. **Jamais d’import automatique à chaque visite.** L’import est **déclenché**
   (bouton d’un compte enseignant, ou script), jamais déclenché par une lecture.
2. **Rien ne repart si l’empreinte est bonne.** Un `stale` réimporte les fichiers dont
   l’empreinte SHA-256 a changé, pas les autres. C’est le gain le plus rentable du plan.
3. **Polling borné, puis reprise.** Un `POST` de traduction renvoie un `id` : on poll
   5 fois en backoff (1 s, 2 s, 4 s, 8 s, 15 s), sinon on laisse le job en `pending` et la
   synchro suivante relit l’état (1 appel) au lieu de boucler dans la requête.
   Option : webhook `onshape.model.translation.complete` (0 appel de polling, mais exige un
   endpoint public rappelable par Onshape et une registration par document).
4. **Les appels en 4xx/5xx ne comptent pas dans le quota**, mais un 402 doit être traduit
   en message explicite (« quota API annuel atteint : ~n restants, voir
   My Account → Developer ») et non en échec silencieux.
5. **Backfill hors quota** : `scripts/onshape-import.mjs` exécuté par un·e enseignant·e
   depuis sa machine, avec ses clés (précédent : le script de conversion SolidWorks local).
   Le site, lui, ne fait que des imports à la demande.
6. **Option structurante** : publier une **application OAuth2 sur l’App Store Onshape** —
   les appels faits par une application publique ne comptent pas dans les limites. C’est la
   seule voie tenable si l’on veut un backfill systématique de toute la bibliothèque, mais
   cela impose une app publique, sa revue, et son infrastructure de tokens.
7. **Le script renvoie son arithmétique** : `--dry-run` imprime le nombre de dossiers, de
   fichiers, d’appels estimés et ce que le quota permet — comme le fait déjà le plan de
   provisioning Appwrite. Un `estimateCalls(plan)` testé, pas une estimation à la main.

---

## 6. Phasage proposé

### Phase 0 — levée du doute (0,5 j, **bloquante**)

Une seule question : *est-ce que j’arrive, avec une clé d’API, à créer un document et à y
faire entrer un STEP du bucket, sans passer par l’interface ?*

1. Créer le compte/la clé (My Account → Developer → API Keys ; max 2 clés actives par
   compte individuel) et noter le type d’abonnement (→ le budget réel).
2. `curl` : `POST /api/v10/documents` → récupérer `id` et `defaultWorkspace.id`.
3. Télécharger un `.step` du bucket (`/api/files/<chemin>`), puis
   `POST /api/v6/translations/d/{did}/w/{wid}` avec `storeInDocument=true`.
4. Poll `GET /api/v6/translations/{id}`, puis `GET /api/v6/documents/{did}/elements`.
5. Écrire dans ce document les réponses réelles : noms exacts des champs, `resultElementIds`
   ou non, taille limite en API (la doc mentionne 4 Go pour l’import ; non vérifié côté API),
   en-têtes de quota, comportement d’un `.stl` (mesh view-only), d’un `.glb`
   (la liste documentée dit `.gltf`, **pas** `.glb`), d’un nom accentué.

**Deux questions à trancher ici, pas plus tard** (c’est ce qui décide de la forme) :

- un **STEP multi-racines** fabriqué par la Space donne-t-il **N onglets nommés** ou
  **un onglet à N corps** ? C’est ce qui rend l’idée « paquet unique + lien par fichier »
  possible ou non (§3 bis c).
- un `.glb` est-il accepté (la liste documente `.gltf` et `3MF`), et quelle est la taille
  maximale réelle d’un envoi en API multipart ?

**Critère** : un lien vers un document Onshape créé à la main, contenant 1 STEP traduit et
1 STL, avec la transcription des 5 réponses HTTP. Sans ça, toute estimation est de la fiction.

### Phase 1 — spec testée, exécution locale (1 à 2 j)

- `scripts/onshape-spec.js` : `IMPORTABLE_DIRECTEMENT`, `REQUERANT_REEXPORT`,
  `MESH_SEULEMENT`, `classifyFolder(files)`, `planFolderImport(files, { maxParExecution })`,
  `estimateCalls(plan)`, `sanitizeTabName()`, `packAndGoName(assembly)` (zip nommé comme la
  racine, aplati, sans caractères spéciaux), `buildManifest(...)`.
- `scripts/onshape-import.mjs` : `--dry-run` (plan + appels estimés + ce que le quota autorise),
  `--status` (auth joignable, formats, documents existants pour le bucket),
  `--folder "GM/3A GM"` (importe), `--force`, `--max-per-run`, et **reprise** : relancer la
  même commande sur un dossier partiel ne renvoie que ce qui manque.
- `tests/onshape-import-plan.test.js` : classement des formats (dont les refusés :
  IFC, Revit, Navisworks), assainissement des noms, `packAndGoName` conforme aux règles
  documentées, calcul du budget, idempotence (empreinte identique → plan vide), repli propre
  quand le quota est dépassé.

Aucun code applicatif dans cet ordre : le script est le lieu de validation, comme pour
Appwrite et pour la conversion SolidWorks.

### Phase 2 — routes Worker (1 à 2 j)

- `GET /api/onshape/status`, `POST /api/onshape/import?path=<dossier>`,
  `GET /api/onshape/state?path=<dossier>`.
- Réutilisation de `collectSolidworksDependencies` (ou de son jumeau générique) pour lire le
  dossier, `downloadConvertibleSource` pour les octets, `makeCacheKey`/`storeMetadataKv` pour
  l’état. **Mode synchrone borné d’abord** (≤ 3 fichiers par requête, le client rappelle),
  comme le prévoit déjà `docs/HOOPS_SOLIDWORKS_STEP_FEASIBILITY.md` §5 ; file asynchrone
  (Queue ou Durable Object) seulement si l’usage le justifie.
- `429` → backoff côté Worker (le client ne doit jamais boucler à vide) ; `402` →
  `state: quotaReached` avec le message de §5.4.
- Échec d’un seul fichier ≠ échec du dossier : `tabs[].state = failed` + `reason`, document
  conservé, `state: partial` affiché.

### Phase 3 — interface (1 j)

- En-tête de dossier (Explorer) : bouton « Ouvrir dans Onshape » si `documentId` existe, sinon
  « Créer le document Onshape de ce dossier » (visible seulement si `GET /api/onshape/status`
  répond configuré et si l’utilisateur a le droit de déclencher).
- `ModelViewer` : action « Importer ce fichier dans le document du dossier » pour le fichier
  seul (utile après un `failed` isolé).
- Bandeau d’état réutilisant la discipline des favoris : état + cause + « Relancer »,
  `role="alert"` sur un refus, aucun état fantaisiste quand rien n’a été tenté.
- Fichiers non traduisibles : le viewer explique *pourquoi* il n’y a pas d’onglet Onshape
  (IFC/Revit/Navisworks) plutôt que de masquer le bouton.
- Aucun token Onshape dans le bundle : la route Worker est le seul chemin, et un test
  `no-secret-in-client` (extension de `tests/appwrite-config.test.js`) le vérifie.

### Phase 4 — recettes et exploitation (0,5 à 1 j)

- 3 dossiers témoins : un de pièces STEP, un avec un assemblage `.sldasm` + ses pièces,
  un avec un STL et un IFC (attendu : mesh view-only ; IFC importé en 3MF après réexport, ou
  absent avec message).
- Vérifier le retour après modification d’un fichier du bucket : `stale` → réimport limité aux
  fichiers changés, et le nombre d’appels consommés par cette rattrapage est écrit dans la
  recette (chiffre réel, pas une promesse).
- `npm run onshape:status` dans la doc de déploiement ; les clés dans `wrangler secret`.

### Phase F (option) — aller-retour Onshape → bucket

Onshape exporte STEP, glTF, STL, 3MF, OBJ et DWG/DXF par API (`storeInDocument=true` ou
`downloadExternalData`). Un dossier importé peut donc être **renvoyé** vers le bucket sous
`derived/onshape/…` et suivi par le même mécanisme d’empreinte que `derived/step/…`. À ne
lancer que si un usage réel (devoir à rendre sur Onshape, correction en ligne) apparaît ;
sinon Onshape reste un lecteur/éditeur et le bucket la source.

---

## 7. Critères d’acceptation

1. Un dossier de la bibliothèque peut être importé **sans ouvrir l’interface Onshape** :
   une commande, un document Onshape créé, un onglet par fichier traduisible.
2. Un dossier réimporté sans changement ne consomme **aucun appel** en écriture (vérifié par
   le compteur du script, et par le relevé du quota dans My Account → Developer).
3. Un fichier qui échoue est **nommé avec sa cause** dans l’interface ; les autres onglets
   restent ; le réessai ne repart que sur l’échec.
4. Les formats non traduits par Onshape (IFC, Revit, Navisworks, maillages lourds) sont
   listés explicitement, pas silencieusement ignorés.
5. `npm run check` passe, avec les tests de plan ; aucune clé Onshape n’apparaît dans `src/`
   ni dans une variable `VITE_`.
6. Le budget est annoncé avant exécution (`--dry-run`) et vérifié après ; tout dépassement de
   quota se traduit en message actionnable.
7. La correspondance onglet ↔ fichier d’origine est lisible depuis le document seul
   (manifeste importé comme blob).

---

## 8. Décisions à prendre avant tout développement

1. **Compte de rattachement** : un compte EDU Student/Free (2 500 appels/an) ne suffit pas à
   une exploitation de classe. Un compte EDU Enterprise ou un achat d’appels, ou
   l’application publiée sur l’App Store (appels non comptés) — laquelle de ces trois voies ?
2. **Visibilité** : documents privés (chaque étudiant doit avoir un compte Onshape et une
   invitation), ou publics (lien partageable sans compte, contenu d’enseignement exposé) ?
   Recommandé : **privés**, avec un sous-ensemble public choisi à la main.
3. **Propriété et nettoyage** : qui a le droit de créer des documents dans l’espace de
   l’école, et qui supprime les doublons ? Sans réponse, le backfill va produire des
   documents orphelins introuvables à retirer.
4. **Forme retenue** : A seule, ou A+B (assemblages reconstitués) ? C est déconseillé (§3).
5. **Fichiers non 3D** : le document de dossier inclut-il aussi les PDF du même dossier
   (Onshape les stocke et les affiche) ? « Tous les fichiers du dossier » pourrait se lire
   plus largement que « tous les fichiers 3D ».
6. **Trigger** : bouton dans l’interface (déclic humain, coût maîtrisé) vs tâche périodique
   (backfill automatique, à chiffrer en appels avant d’accepter).
7. **File de conversion** : `.stl`/`.obj` importés en mesh **non éditable** — est-ce utile
   pédagogiquement, ou vaut-il mieux n’importer que les formats B-rep et le STEP réexporté ?
8. **Paquet ou fichier par fichier** : si la phase 0 confirme les N onglets, le paquet
   unique (≈ 6 appels/dossier) devient la forme par défaut et la forme A le repli — faut-il
   alors ajouter `POST /api/merge-step` à la Space (`space-huggingface/app.py`), qui est le
   seul morceau neuf non trivial de la chaîne ?
9. **Métadonnées d’onglet** : accepte-t-on des noms d’onglets assainis (`GM-3A-GM__meca-TD-1`)
   pour garder un lien exact, ou veut-on des noms jolis et donc un appel de renommage par
   onglet (API de métadonnées, `propertyId` opaque) ?
10. **Réexport** : la Space de conversion produit du `.glb` ; Onshape documente `.gltf` et
   `3MF`. Soit on vérifie que `.glb` passe (phase 0), soit on ajoute un mode **3MF** à la
   Space, qui est le format le plus sûr pour nos maillages.

---

## 9. Risques et replis

| Risque | Effet | Repli |
| --- | --- | --- |
| Quota annuel épuisé | `402`, plus aucun import | Imports à la demande + backfill par le script local ; app publiée si l’usage l’exige |
| `POST /translations` n’expose pas directement les `elementIds` créés | onglets introuvables pour l’association | 1 listing `documents/{did}/elements` après import (déjà prévu) ; nom d’onglet = nom de fichier comme clé de rattachement |
| Limite de taille de l’API multipart < 4 Go | refus sur les gros assemblages | seuil configurable `MAX_ONSHAPE_BYTES`, fichier marqué `skipped` avec message, import du STEP réexporté à la place du natif |
| Noms accentués/espaces | Pack-and-Go refusé, onglets illisibles | assainissement + manifeste (§3B) ; jamais de renommage destructeur sans trace |
| STL/OBJ importés non éditables | déception en TP | message en amont ; réexport 3MF/STEP si le but est l’édition |
| Durcissement récent des limites API Onshape | cadence plus sévère qu’annoncé | backoff + budget calculé avant exécution ; jamais de boucle côté client |
| Fichiers sensibles publiés dans un document public | fuite de contenu d’enseignement | `public=false` par défaut, liste blanche explicite |
| Onshape change/retire les endpoints de dossier (non documentés) | l’arbre Onshape ne se miroite pas | ne pas dépendre des dossiers Onshape : un document par dossier de notre bucket, nom = chemin lisible ; l’arborescence reste la nôtre |

**Repli sans API, à ne pas négliger** : l’interface Onshape sait déjà faire « sélectionner
tous les fichiers d’un dossier → importer dans un document unique » en une opération. Si la
voie API est refusée par le quota ou par la politique du compte, le script se réduit à
fabriquer **le zip du dossier** (nommé, aplati, manifeste inclus) et le site n’affiche qu’un
lien de téléchargement + la notice en 3 clics. On garde l’essentiel de la valeur —
*fichier du dossier = onglet du document* — pour zéro appel API.

---

## 10. Estimation

| Phase | Durée | Prérequis |
| --- | --- | --- |
| 0 — levée du doute | 0,5 j | compte + clé API Onshape |
| 1 — spec testée + script local | 1 à 2 j | phase 0 |
| 2 — routes Worker | 1 à 2 j | phase 1 |
| 3 — interface | 1 j | phase 2 |
| 4 — recette | 0,5 à 1 j | phases 2–3 |
| F — aller-retour Onshape → bucket | 1 à 2 j | décision §8.6 |

## Références techniques

- Import/export par API (multipart, `storeInDocument`, `flattenAssemblies`, poll
  `requestState`, `getAllTranslatorFormats`) :
  https://onshape-public.github.io/docs/api-adv/translation/
- Limites d’API (budget annuel par abonnement, `402`, ce qui compte ou non, 429) :
  https://onshape-public.github.io/docs/auth/limits/
- Clés d’API (2 clés max par compte individuel, Basic réservé aux tests locaux, request
  signature, OAuth2 obligatoire pour une app du App Store) :
  https://onshape-public.github.io/docs/auth/apikeys/
- Formats importables/exportables, y compris « Parasolid preferred », SOLIDWORKS 1999→2026,
  STL/OBJ en mesh non éditable, glTF 2.0 et 3MF :
  https://cad.onshape.com/help/Content/File/supported_file_formats.htm
- Import de fichiers : limite 4 Go par fichier, nom du fichier devient le nom de l’onglet,
  préparation Pack-and-Go (zip nommé comme l’assemblage racine, aplati, sans caractères
  spéciaux), options « import to a single document » / « split » / « combine to a single
  Part Studio » : https://cad.onshape.com/help/Content/Document/importing_files.htm
- Géométrie importée (composite, « allow faulty parts ») :
  https://cad.onshape.com/help/Content/Document/working_with_imported_cad.htm
- Documents par API (`POST /api/v10/documents`, mise à jour, versions) :
  https://onshape-public.github.io/docs/api-adv/documents/
- Webhooks (`onshape.model.translation.complete`) :
  https://onshape-public.github.io/docs/app-dev/webhook/
- Création de dossier et déplacement de document : endpoints **non documentés**
  (`POST /api/folders`, `parentId`) — discutés ici, donc hors périmètre recommandé :
  https://forum.onshape.com/discussion/25075/api-folder-creation-move-document-functionality
- Clients officiels et exemples d’import (test Python d’upload STL, `onshape-clients`) :
  https://github.com/onshape-public/onshape-clients
- Docs internes du dépôt : `docs/HOOPS_SOLIDWORKS_STEP_FEASIBILITY.md` (pipeline de
  conversion, contrat de service borné), `docs/FREECAD_WEB_AUTHORING_PLAN.md` §11
  (CAO/FEM dans le navigateur, alternative à Onshape comme destination d’édition),
  `docs/APPWRITE_AUTH_PLAN.md` (discipline provisioning/spec testée/états visibles).
