# Faisabilité — SolidWorks → STEP → bucket Hugging Face

**Date de planification : 9 septembre 2026**

**Statut : étude, aucune conversion ni aucun secret n’est enregistré dans le dépôt**

## 1. Décision de faisabilité

Le besoin est **techniquement faisable**, mais pas avec le seul JavaScript de
**HOOPS Visualize Web** dans le navigateur.

Il faut déployer le composant serveur **HOOPS Converter / HOOPS Exchange**,
avec un droit de licence qui couvre à la fois :

1. la lecture de `SLDPRT` / `SLDASM` ;
2. l’export STEP ;
3. l’exécution sur le système cible (Linux conteneurisé si le convertisseur
   reste dans le Space Hugging Face).

La documentation HOOPS indique que les formats SolidWorks (`SLDASM`, `SLDPRT`)
sont pris en charge jusqu’aux versions publiées indiquées par le produit, et
que STEP fait partie des exports additionnels soumis à la licence HOOPS Web /
HOOPS Exchange. Le convertisseur est une application autonome située dans le
package produit : le viewer Web n’est pas, à lui seul, un moteur de conversion.

Le dépôt actuel est compatible avec cette évolution, mais il ne la réalise pas
encore :

- `worker/index.js` lit le bucket et orchestre déjà des services de conversion ;
- `space-huggingface/app.py` ne traite aujourd’hui que STEP/IGES/STL/OBJ avec
  FreeCAD et rejette volontairement les formats propriétaires ;
- `src/components/AutodeskViewer.jsx` constitue le fallback actuel pour
  `SLDPRT`/`SLDASM` ;
- aucun chemin d’écriture n’existe actuellement vers le bucket ;
- la configuration `HF_TOKEN` documentée est prévue pour la lecture, pas pour
  l’écriture.

**Conclusion : faisabilité conditionnelle, avec un risque principal licence /
package HOOPS et un risque secondaire assemblies / dépendances.**

## 2. Ce que HOOPS apporte exactement

### Conversion serveur envisagée

Le binaire HOOPS Converter sera appelé dans un répertoire temporaire isolé,
avec des arguments de type :

```text
converter
  --input <source.sldprt|source.sldasm>
  --license <clé injectée par secret>
  --output_step <sortie.step>
  --step_export_format 2
  --read_geometry true
```

`2` correspond au choix initial recommandé pour STEP AP242. Le choix définitif
(AP203, AP214 ou AP242) devra être validé avec les usages de l’école et avec un
fichier de référence. Les options exactes seront vérifiées contre la version du
package HOOPS effectivement fournie avant toute mise en production.

### Ce qui est préservé / perdu

| Élément | Attendu |
|---|---|
| Géométrie B-Rep | Oui, si le fichier source contient une géométrie lisible |
| Arbre d’assemblage et instances | Oui pour les assemblages correctement empaquetés |
| PMI / tolérances | À privilégier en AP242 et à valider sur des fichiers réels |
| Historique des features SolidWorks | Non : STEP est un format d’échange, pas un fichier paramétrique SolidWorks |
| Équations, mates et logique de conception | Non ou partiel selon la donnée exportée |
| Dessins `.slddrw` | Hors périmètre STEP ; à conserver comme fichier original |

Un `.sldasm` n’est pas autonome dans le cas général : il référence des
`.sldprt`, des sous-assemblages et parfois des références externes. Convertir
uniquement le fichier `.sldasm` sans ses dépendances produira un échec ou un
résultat incomplet. Le job devra donc télécharger le paquet de dépendances,
ou refuser proprement l’assemblage incomplet.

## 3. Architecture recommandée

```text
Navigateur
   │  demande d’aperçu / de génération
   ▼
Cloudflare Worker
   │  valide le chemin, déduplique, crée ou suit un job
   ▼
Service privé de conversion HOOPS
   │  récupère le source et ses dépendances
   │  HOOPS Converter : SolidWorks → STEP
   │  vérifie la signature et la taille du STEP
   │  écrit le résultat avec un token HF write-only côté serveur
   ▼
Bucket Hugging Face
   ├── source/.../piece.sldprt
   └── derived/step/.../piece.step
```

### Pourquoi pas dans le Worker ?

Le Worker Cloudflare ne peut pas embarquer de manière fiable un binaire natif
HOOPS, ni fournir le CPU, la mémoire et le temps d’exécution nécessaires aux
modèles CAO complexes. Il doit rester une façade légère : validation,
cache/status, proxy et lien de téléchargement.

### Où exécuter HOOPS ?

Deux options sont possibles :

1. **Space Hugging Face Docker dédié** : réutilise la structure actuelle, mais
   nécessite une image privée ou un mécanisme de distribution autorisé pour le
   binaire HOOPS. Il faudra aussi tester `Xvfb`/les bibliothèques Linux et les
   limites du hardware gratuit.
2. **Service dédié (Cloud Run, VM ou conteneur privé)** : meilleur choix pour
   la disponibilité, la confidentialité, la file d’attente et les gros
   assemblages. Le Space actuel peut rester le service FreeCAD/LibreOffice
   séparé.

Pour une preuve de concept, l’option 1 est suffisante. Pour un usage régulier
ou des modèles confidentiels, l’option 2 est recommandée.

## 4. Écriture dans le bucket

Le bucket est un Storage Bucket Hugging Face mutable. Le service de conversion
peut écrire le résultat avec l’API Python `huggingface_hub` (`batch_bucket_files`)
ou avec l’API S3 compatible Hugging Face.

### Recommandation MVP

Utiliser l’API Python depuis le service de conversion :

```python
batch_bucket_files(
    "namespace/ENISE-SITE",
    add=[(step_bytes, "derived/step/GM/piece.step")],
)
```

Le token d’écriture doit être limité au namespace/bucket concernés et rester
uniquement dans le runtime du service. Il ne doit jamais être envoyé au
navigateur, au bundle Vite, au Worker public ou au dépôt.

L’API S3 est une alternative pour les gros fichiers/flux : elle demande des
identifiants S3 Hugging Face dérivés d’un token avec permission Write et une
signature AWS SigV4. Elle évite d’ajouter la librairie Python, mais augmente la
surface d’implémentation et de test.

### Organisation cible

```text
derived/step/<chemin-relatif-sans-extension>.step
 derived/step/<chemin-relatif-sans-extension>.json   # optionnel : manifest
```

Le préfixe `derived/step/` est préféré à l’écrasement du dossier source : il
conserve l’original, évite les collisions et rend le nettoyage possible. Le
manifest peut contenir le chemin source, son empreinte SHA-256, la version du
convertisseur, l’AP STEP, la date, la taille et le statut de validation.

Le job sera idempotent : même source + même version du convertisseur = réemploi
du STEP existant ; une empreinte différente déclenche une nouvelle conversion.

## 5. Contrat de service proposé

### Mode initial : job synchrone borné

À réserver aux pièces de petite taille et aux tests :

```text
POST /api/convert-solidworks-step
multipart: file, output_path optionnel
→ 201 { status: "success", step_path, size, sha256 }
```

### Mode production : asynchrone

À retenir pour le site public et les assemblages :

```text
POST /api/solidworks/step?path=<chemin>&force=0
→ 202 { jobId, status: "queued" }

GET /api/solidworks/step/status?job=<jobId>
→ { status: queued|running|success|failed,
     stepPath, error, startedAt, finishedAt }
```

La conversion asynchrone évite de maintenir une requête Worker ouverte pendant
un cold start ou une conversion longue. Le job doit être protégé par un secret
interne entre Worker et convertisseur, limité par taille, et soumis à un
rate-limit. L’API ne doit jamais accepter un chemin arbitraire vers le système
de fichiers du conteneur.

## 6. Déclenchement fonctionnel à décider

Le dépôt ne contient pas aujourd’hui d’interface d’upload. Il faut choisir le
comportement métier :

- **backfill** : convertir maintenant les `.sldprt` / `.sldasm` déjà présents ;
- **à la demande** : convertir lorsqu’un utilisateur clique sur « Générer le
  STEP » ;
- **automatique** : convertir tout nouveau fichier détecté lors d’un scan ;
- **hybride recommandé** : backfill contrôlé, puis génération à la demande,
  avec un script batch pour les nouveaux lots.

L’interface pourra afficher un bouton « Générer / mettre à jour le STEP » et,
une fois le job terminé, « Télécharger le STEP ». L’onglet Autodesk reste le
fallback tant que la conversion n’est pas terminée ou si elle échoue.

## 7. Phasage proposé

### Phase 0 — validation bloquante (0,5 à 1 jour)

- confirmer que la clé fournie correspond bien à une licence HOOPS Converter /
  Exchange et autorise l’exécution serveur Linux/production ;
- obtenir le package `converter` correspondant à la licence ;
- exécuter `converter --help` et une conversion locale sans modifier le
  dépôt ;
- recueillir trois fichiers de test non confidentiels : une pièce simple, une
  pièce avec surfaces/PMI et un assemblage avec tous ses fichiers liés.

**Go / no-go :** sans binaire et entitlement d’export STEP, le projet ne doit
pas passer à l’intégration.

### Phase 1 — spike de conversion (1 à 2 jours)

- image Docker dédiée avec HOOPS, `Xvfb` si nécessaire et nettoyage des
  répertoires temporaires ;
- wrapper Python ou Node avec arguments sans shell interpolation ;
- sorties AP242 et AP214 comparées ;
- validation de la signature `ISO-10303-21;`, de la taille, du code retour et
  d’un rechargement du STEP ;
- mesure temps/mémoire/taille sur les trois fichiers.

### Phase 2 — stockage et backfill (1 jour)

- token HF write séparé, injecté au runtime ;
- upload `derived/step/...` après succès uniquement ;
- manifest et déduplication SHA-256 ;
- script de scan/backfill avec `--prefix`, `--dry-run`, `--force` et reprise
  après erreur ;
- invalidation ou versionnement de l’index Worker pour que les nouveaux
  fichiers ne restent pas invisibles dans le cache.

### Phase 3 — intégration site (1 à 2 jours)

- routes Worker status/start ;
- authentification du service interne, quotas et messages d’erreur ;
- bouton et état de job dans `PreviewModal` / `ModelViewer` ;
- lien STEP généré, téléchargement et fallback Autodesk ;
- maintien des secrets hors frontend.

### Phase 4 — recette et exploitation (1 jour)

- tests unitaires Worker et tests API du convertisseur ;
- test de non-régression des fichiers existants ;
- validation de 5 à 10 fichiers SolidWorks de versions différentes ;
- logs sans données CAO sensibles, métriques de durée/échec, nettoyage et
  documentation de déploiement.

**Estimation globale : 3 à 6 jours de développement après obtention du
package/licence et des fichiers de test.** La durée ne comprend pas une
éventuelle procédure d’achat, de licence ou de validation juridique.

## 8. Critères d’acceptation

- Une pièce `.sldprt` valide produit un `.step` téléchargeable dans le bucket.
- Un second appel sur la même empreinte ne relance pas HOOPS.
- Le STEP s’ouvre dans au moins un lecteur de contrôle et dans HOOPS.
- Les dimensions, unités et volume d’une pièce de référence restent dans la
  tolérance définie avec l’utilisateur.
- Un assemblage avec toutes ses dépendances conserve sa structure attendue.
- Un assemblage incomplet est signalé comme tel et ne publie pas un faux succès.
- Une source corrompue, trop volumineuse ou non supportée retourne une erreur
  compréhensible et ne laisse pas de fichier partiel dans le bucket.
- Aucun secret HOOPS/Hugging Face ne se retrouve dans `src/`, `public/`, les
  logs, Git ou une réponse HTTP publique.
- L’ancien aperçu Autodesk continue de fonctionner en cas d’échec.

## 9. Risques et plans de repli

| Risque | Impact | Repli |
|---|---|---|
| La clé ne couvre que le viewer Web | Pas de conversion serveur | demander HOOPS Converter/Exchange ou conserver APS |
| Binaire Linux indisponible | Space impossible à construire | service/VM privé ou image fournie par Tech Soft 3D |
| Assemblage sans dépendances | STEP incomplet | exiger un package complet, convertir les pièces seules |
| Version SolidWorks non supportée | échec de lecture | export STEP côté SolidWorks / Autodesk viewer |
| Fichiers confidentiels dans un bucket public | fuite de propriété intellectuelle | bucket privé + authentification du portail |
| Cold start / timeout / gros modèle | expérience lente | job asynchrone + service toujours allumé |
| Cache index Cloudflare | STEP absent de la navigation | invalidation versionnée + manifest de conversion |
| STEP ne conserve pas l’historique | perte de données métier | garder le `.sldprt` comme source et documenter la perte |

## 10. Sécurité immédiate

La chaîne fournie dans la demande ressemble à une clé de licence ou à un secret.
Elle ne doit pas être copiée dans ce dépôt, un exemple `.env`, le frontend ou
un ticket public. Si elle est active, il est prudent de la révoquer/régénérer
et de stocker la nouvelle valeur dans le gestionnaire de secrets du service
(`HOOPS_LICENSE_KEY`, jamais `VITE_*`).

## 11. Décisions nécessaires avant implémentation

1. La clé autorise-t-elle **HOOPS Converter/Exchange**, l’import SolidWorks,
   l’export STEP et un déploiement serveur Linux ?
2. Faut-il convertir les fichiers existants, les nouveaux fichiers, ou les
   deux ?
3. Les assemblages `.sldasm` ont-ils tous leurs `.sldprt` et dépendances dans
   le même bucket/dossier ?
4. Le chemin cible convient-il : `derived/step/...` ?
5. Le bucket peut-il devenir privé pendant la conversion et l’accès au site ?
6. Quel matériel est acceptable : Space gratuit pour le POC ou service dédié
   pour la production ?
7. L’export doit-il être AP242 (PMI/archivage) ou AP214 (compatibilité
   historique) ?

## Références techniques

- [Formats HOOPS Visualize Web](https://docs.techsoft3d.com/hoops/visualize-web/overview/supported-formats.html)
- [Options du HOOPS Converter](https://docs.techsoft3d.com/hoops/visualize-web/api_ref/data_import/converter-command-line-options.html)
- [STEP Writer HOOPS Exchange](https://docs.techsoft3d.com/hoops/exchange/start/format/step_writer.html)
- [Storage Buckets Hugging Face](https://huggingface.co/docs/hub/en/storage-buckets)
- [API S3 des Storage Buckets Hugging Face](https://huggingface.co/docs/hub/en/storage-buckets-s3)
