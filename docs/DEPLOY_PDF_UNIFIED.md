# Déployer le lecteur PDF unifié

Ce guide décrit le déploiement **Appwrite → API Go sur Cloud Run → Worker et frontend Cloudflare**. Le PDF original reste dans le bucket Hugging Face existant ; Docling n'est pas nécessaire pour le nouveau parcours PDF. La base et les services de production ne sont pas modifiés par ce document.

> **Commencer par un staging distinct.** Les valeurs par défaut du dépôt pointent vers des ressources existantes. Vérifier explicitement les identifiants, les comptes connectés et les commandes avant de lancer une opération réelle. Les services réellement configurés et les permissions doivent être validés dans votre environnement.
>
> Les identifiants d’exemple dans ce guide sont des **substituts, pas des valeurs à utiliser**. Les remplacer par les identifiants réels avant d’exécuter les commandes concernées. Exécuter et vérifier chaque étape séparément ; ne pas coller ensemble une simulation et une commande réelle. Dans le zsh interactif de macOS, une ligne `#` peut être traitée comme une commande si l’option `interactivecomments` est désactivée.

## 1. Prérequis et sauvegardes

- Disposer de Node.js >= 20.19, `npm`, `gcloud` connecté au bon projet Google, et Wrangler connecté au bon compte Cloudflare. Cloud Run/Cloud Build nécessitent les droits et la facturation appropriés. À la racine du dépôt : `npm ci`.
- Identifier séparément les ressources de staging et de production : projet/base Appwrite, clé serveur Appwrite, projet Google, service Cloud Run, Worker et nom de domaine, KV, buckets et fournisseur IA. Le code du nouveau lecteur et son schéma doivent provenir de la même révision.
- Avant le changement, effectuer **et tester une sauvegarde/restauration Appwrite** adaptée à votre instance : toutes les tables et lignes, leurs IDs, permissions et liens avec les utilisateurs. Sauvegarder également la configuration du projet/authentification selon les capacités de votre instance. Ne pas se fier à un export tronqué à la première page.
  - Si la fonctionnalité est disponible sur votre offre Appwrite, créer une sauvegarde manuelle dans **Databases → base → Backups**, puis tester sa restauration vers une **nouvelle** base isolée. Vérifier les droits et la couverture exacts de votre offre.
  - Sinon, envisager un export CSV **de chaque table**, plus la capture séparée du schéma, des index, des permissions de table, de `rowSecurity`, de l'état `enabled` et de la configuration du projet. Vérifier que l'export contient les IDs, dates et permissions par ligne quand ils sont nécessaires. Plusieurs CSV ne constituent pas un instantané atomique : suspendre les écritures ou mettre en place une procédure cohérente. Un CSV seul n'est pas une sauvegarde complète de la configuration ni d'Appwrite Auth.
  - Protéger ces fichiers et tester la restauration dans une **autre** base : comparer nombres et IDs de lignes, données, schéma, index et permissions ; contrôler les accès avec deux comptes. Si la restauration n'est pas vérifiée ou si des données/configurations manquent, ne pas considérer la sauvegarde comme complète.
- Noter la révision Cloud Run servant le trafic, la version/déploiement Cloudflare actuel, ses bindings et secrets, ainsi que la configuration Appwrite existante. Sauvegarder séparément, avec accès restreint, le fichier de configuration du service :

  ```sh
  export PROJECT_ID="identifiant-du-projet-google"
  export REGION="europe-west1"
  export SERVICE="nom-reel-du-service-a-sauvegarder"
  umask 077
  BACKUP_DIR="$HOME/backups/enise-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$BACKUP_DIR"
  gcloud run services describe "$SERVICE" --project "$PROJECT_ID" \
    --region "$REGION" --format export > "$BACKUP_DIR/cloudrun.yaml"
  cp wrangler.jsonc "$BACKUP_DIR/wrangler.jsonc"
  npx wrangler deployments list
  ```

  Ce fichier Cloud Run peut contenir des secrets en clair : le conserver hors Git, sans le partager. Si le service n'existe pas encore, sauvegarder les ressources existantes équivalentes ; ne pas inventer de révision de retour arrière.

- Dans Appwrite, ajouter le nom de domaine HTTPS du site comme plateforme autorisée et configurer les emails d'authentification si nécessaires. Utiliser deux comptes de test distincts.

## 2. Configurer l'environnement Appwrite

Créer `.dev.vars` depuis `.dev.vars.example` uniquement s'il n'existe pas, puis le protéger :

```sh
cp -n .dev.vars.example .dev.vars
chmod 600 .dev.vars
```

Éditer localement `.dev.vars` sans publier son contenu. Le fait que le fichier soit ignoré par Git **n'empêche pas** sa synchronisation par Google Drive, iCloud ou un autre service si le dossier du dépôt est synchronisé. Utiliser un dossier et un stockage de secrets adaptés, privés et non partagés. Remplacer **explicitement** au minimum :

```dotenv
APPWRITE_ENDPOINT="https://endpoint-appwrite-de-cet-environnement/v1"
APPWRITE_PROJECT_ID="projet-appwrite-de-cet-environnement"
APPWRITE_DATABASE_ID="base-appwrite-de-cet-environnement"
APPWRITE_FLAVOR="tablesdb"
APPWRITE_PUBLIC_ORIGIN="https://domaine-du-site-de-cet-environnement"
APPWRITE_API_KEY="cle-serveur-de-provisionnement"
```

- `tablesdb` correspond à l'API TablesDB 2.x ; si l'instance utilise les collections héritées, employer `databases` de manière cohérente dans le fichier et les commandes ci-dessous. L'endpoint doit être celui de l'instance, avec `/v1` une seule fois.
- Pour le diagnostic seul, utiliser une clé dédiée avec uniquement les scopes de lecture nécessaires : `databases.read`, `tables.read`, `columns.read` et `indexes.read` pour TablesDB, selon votre version. Après sauvegarde, test et revue seulement, une clé de provisioning séparée peut nécessiter les scopes `.write` correspondants. Restreindre ou révoquer cette dernière une fois terminée, après avoir vérifié qu'elle n'est utilisée par aucun autre service. La clé de provisioning n'est pas copiée par le script dans Cloud Run et ne doit jamais être exposée au frontend ni préfixée par `VITE_`.
- La nouvelle table est `pdf_annotations_v2` par défaut. Si un ID différent est requis, renseigner `APPWRITE_PDF_ANNOTATIONS_TABLE_ID` **avant** le provisioning et le déploiement ; il doit être distinct de toutes les autres tables. Les IDs personnalisés des profils, favoris, conversations, messages et annotations historiques (`APPWRITE_*_TABLE_ID`) doivent également être identiques entre les deux opérations.
- Si l'assistant IA est requis, renseigner aussi dans `.dev.vars` les variables serveur d'un fournisseur disponible, par exemple `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`, ou les variables Cloudflare AI. Sans fournisseur, la rédaction IA ne sera pas disponible. Ne pas mettre de clé dans les variables `VITE_`, dans Git, dans une capture ou dans le navigateur.
- **Attention aux priorités différentes :** le script Appwrite privilégie les variables déjà exportées dans le shell sur `.dev.vars`, puis lit aussi `.env` et `.env.local` ; le script Cloud Run privilégie `.dev.vars` et complète depuis le shell. Une variable résiduelle peut donc cibler une autre base. Vérifier les noms exportés avec `env | cut -d= -f1 | grep -E '^(APPWRITE_|VITE_APPWRITE_)'` et supprimer/aligner les valeurs conflictuelles sans les afficher. Le dry-run ci-dessous affiche l'endpoint, le projet et les chemins de base effectivement visés.

## 3. Préparer le schéma Appwrite sans toucher aux données existantes

**Arrêt si une sauvegarde complète et sa restauration n'ont pas été vérifiées, ou si une exécution précédente a échoué.** Le script ne rend pas une écriture atomique et ne répare pas automatiquement un état partiel. Ne pas supprimer ni recréer une table existante pour corriger un échec.

La colonne `anchorJson` est déclarée à **16 384 caractères** dans le schéma. Les versions de l'adaptateur SQL Appwrite examinées stockent une `string` au-delà de 16 381 caractères en `TEXT`, ce qui évite de compter 16 000 caractères × 4 dans la largeur maximale de ligne. L'API Go continue de limiter le JSON de l'ancre à **16 000 octets**. Ce choix dépend de l'adaptateur et de la version Appwrite : vérifier la création et des écritures longues, y compris Unicode, sur une base de staging du même environnement avant de l'envisager ailleurs. Sources : [adaptateur Utopia 3.5 utilisé par Appwrite 1.8.1](https://github.com/utopia-php/database/blob/5da71b65a6123ce2e78795522b05b7458aabfbd7/src/Database/Adapter/SQL.php#L1099-L1144) ; [adaptateur Utopia 8.3 utilisé par Appwrite 2.6.2](https://github.com/utopia-php/database/blob/86e31fb84e535c69e58bcbc19037bf1fb472fccb/src/Database/Adapter/SQL.php#L2636-L2693).

Avec la clé en lecture seule, vérifier d'abord le projet et la base :

```sh
npm run appwrite:status -- --flavor=tablesdb
```

Le diagnostic reste partiel : il compare notamment les permissions de table, la sécurité par ligne, les noms, définitions et états des colonnes et index attendus ; il ne vérifie pas les données ou les permissions de chaque ligne. Si un champ, une permission ou une ressource ne peut être vérifié, examiner la console sans tenter de correction automatique. Les permissions de ligne peuvent autoriser des accès même si les permissions de table sont vides.

Puis examiner le plan **statique**, sans appel réseau ni modification, pour la seule nouvelle table (adapter l'ID s'il a été configuré) :

```sh
npm run appwrite:setup -- --dry-run --flavor=tablesdb --table=pdf_annotations_v2 --new-table-only
```

**Le plan ne prouve pas que la table est absente ni que l'instance acceptera le schéma.** Tester d'abord sur une base de staging séparée avec une clé et des comptes de test dédiés, sans accès aux données réelles. Faire valider le plan, l'identifiant de la base et les permissions. Le mode `--new-table-only` exige une cible unique et refuse une table existante ; il ne crée pas la base. Pour toute écriture, une autorisation explicite `--apply` est également requise. La création peut néanmoins s'arrêter à mi-parcours et laisser une **nouvelle** table incomplète : dans ce cas, s'arrêter, examiner l'état et ne pas relancer automatiquement. Le mode ciblé ne verrouille pas l'instance contre des modifications concurrentes : coordonner les autres opérateurs.

La création de la table PDF seule ne répare pas la table `annotations` historique. Le backend lit les anciennes annotations avant les nouvelles ; une panne ou une autorisation refusée sur la table historique peut donc affecter le parcours PDF. Évaluer son schéma, ses données et ses permissions avant de décider d'une éventuelle réparation séparée. Une colonne existante de taille différente n'est pas redimensionnée automatiquement.

Le mode général avec `--apply --all-tables` peut modifier les permissions, noms, activation et sécurité de **toutes** les tables du modèle. Ne l'utiliser qu'après revue spécifique et accord. Ne jamais utiliser `--drop` pour déployer ni pour revenir en arrière : cette option détruit les tables ciblées. Ne pas appliquer `--fix-enums` sans examen séparé de son effet.

## 4. Déployer l'API Go Cloud Run

Utiliser d'abord un service de staging distinct. Le script construit l'image depuis `backend/Dockerfile`, active des API Google si nécessaire, puis publie le service. Il impose les buckets HF historiques du dépôt, `CHAT_TRUST_PROXY=1`, certaines limites Cloud Run et `--allow-unauthenticated` ; il écrit les variables retenues via `--env-vars-file`. Il ne recopie pas automatiquement les autres variables ni les références Secret Manager : selon la configuration existante, elles peuvent être remplacées. Comparer le dry-run et la configuration sauvegardée ; si ces choix ne conviennent pas, adapter/revoir le déploiement et les secrets au lieu d'exécuter le script tel quel. Les clés IA transmises par ce script sont des variables Cloud Run ; gérer les accès IAM et les secrets en conséquence.

**Le staging des exemples n'est pas automatiquement isolé des buckets HF.** La copie du Worker conserve elle aussi le bucket source du fichier de production. Pour un staging complètement isolé, utiliser des buckets de test, adapter les valeurs fixes et le déploiement du backend, ainsi que `HF_BUCKET_ID` dans la configuration du Worker de staging. Vérifier également les autres intégrations et ne pas autoriser de tests d'écriture sur les buckets de production.

**Sécurité :** l'URL Cloud Run est publiquement joignable. Un client direct peut forger des en-têtes d'adresse IP que le backend croit venir du proxy : ne pas considérer la limitation par IP comme une protection suffisante. Fixer `APPWRITE_PUBLIC_ORIGIN` à l'origine HTTPS légitime, revoir IAM/ingress et mettre en place une frontière d'accès fiable compatible avec le Worker et les clients Tauri avant une utilisation sensible.

Remplacer les valeurs d'exemple par l'ID Google et le nom de service réellement choisis :

```sh
export PROJECT_ID="identifiant-reel-du-projet-google-de-staging"
export REGION="europe-west1"
export SERVICE="nom-reel-du-service-staging"
```

Lancer d'abord la simulation seule. L'option `--no-origin` évite de modifier le `wrangler.jsonc` de production :

```sh
npm run deploy:api:firebase -- --project "$PROJECT_ID" --region "$REGION" \
  --service "$SERVICE" --no-origin --dry-run
```

Un déploiement réel exige maintenant `--apply` et un `--project` explicite. Ne pas le lancer avant d'avoir identifié le vrai projet, confirmé facturation et droits, sauvegardé la configuration, testé le staging et validé l'impact sur le service et les secrets. Exécuter la commande réelle séparément après cette revue, jamais dans le même bloc que la simulation.

Seulement si le déploiement a réussi, récupérer l'URL et tester la santé :

```sh
API_ORIGIN="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" \
  --region "$REGION" --format='value(status.url)')"
curl -fsS "$API_ORIGIN/api/health"
```

La réponse directe doit indiquer `ok: true` et `backend: "go"`. `/api/health` ne prouve pas l'accès Appwrite ni l'IA : les tester avec de vrais comptes plus bas. Si un bucket HF devient privé, traiter séparément les secrets nécessaires au backend et au Worker ; le script Cloud Run n'envoie `HF_TOKEN` que si on ajoute `--with-hf-token`.

Pour la production, reprendre les mêmes contrôles et commandes avec **les vrais** `PROJECT_ID`, `REGION` et `SERVICE` de production et la configuration Appwrite de production. Laisser `--no-origin` permet de vérifier manuellement le changement de `GO_API_ORIGIN` avant de publier le Worker ; sans ce flag, le script modifie `wrangler.jsonc` après déploiement.

## 5. Déployer le Worker et le frontend

### Staging isolé

Le fichier `wrangler.jsonc` du dépôt cible le Worker et la KV existants. Créer une copie locale à la racine, par exemple `wrangler.staging.jsonc`, puis l'éditer **avant tout déploiement** :

```sh
cp -n wrangler.jsonc wrangler.staging.jsonc
```

Dans cette copie, changer le `name` pour un Worker de staging, renseigner `vars.GO_API_ORIGIN` avec l'URL Cloud Run **staging** obtenue ci-dessus, et retirer le binding KV de production ou le remplacer par une KV de staging. Contrôler aussi le compte, les domaines/routes, les secrets Worker et tous les autres bindings. Le binding `METADATA_KV` est facultatif ; ne pas partager une KV de production par inadvertance. Si le nom de domaine staging a changé, répercuter l'origine correcte dans `APPWRITE_PUBLIC_ORIGIN` sur le service Cloud Run ainsi que dans `.dev.vars` pour les déploiements suivants, et mettre à jour la configuration Appwrite.

Renseigner le chemin exact d'un PDF présent dans le bucket, pas une URL :

```sh
export PILOT_PATH="chemin/exact/vers/un-test.pdf"
VITE_API_ORIGIN="" VITE_READER_ROLLOUT=pilot \
  VITE_READER_PILOT_PATHS="$PILOT_PATH" npm run build
npx wrangler deploy --config wrangler.staging.jsonc
```

Ne pas utiliser `npm run deploy` pour ce staging : cette commande utilise le `wrangler.jsonc` normal. `VITE_API_ORIGIN` vide permet au site Web de passer par son Worker ; les variables `VITE_*` sont publiques et fixées **au build**.

### Production, après validation du staging

Vérifier dans `wrangler.jsonc` le nom, le compte, les bindings et `vars.GO_API_ORIGIN` pointant vers la bonne API de production. Les secrets du Worker doivent déjà être configurés séparément ; `.dev.vars` n'est pas automatiquement publié comme secrets Worker. Reconstruire et déployer explicitement :

```sh
export PILOT_PATH="chemin/exact/vers/un-test.pdf"
VITE_API_ORIGIN="" VITE_READER_ROLLOUT=pilot \
  VITE_READER_PILOT_PATHS="$PILOT_PATH" npm run deploy
```

**Impact du pilote :** le filtre s'applique au lecteur structuré tout entier, pas seulement aux nouveaux PDF. Les autres fichiers non listés n'ouvriront pas ce lecteur ; `off` le désactive, `pdf` limite aux PDF et `all` l'active pour tous les formats pris en charge. Le défaut est `all`. Choisir le mode selon l'impact accepté, puis reconstruire et redéployer pour l'élargir : ce n'est pas un réglage dynamique par compte. L'audit Docling existant ne valide pas à lui seul le nouveau parcours.

## 6. Vérifier les parcours réels

1. Tester le Worker, pas seulement Cloud Run. `SITE` est son origine HTTPS et `PDF_PATH` un chemin existant :

   ```sh
   export SITE="https://domaine-du-site-a-tester"
   export PDF_PATH="chemin/exact/vers/un-test.pdf"
   curl -fsS -G "$SITE/api/reader/pdf-revision" --data-urlencode "path=$PDF_PATH"
   curl -sS -D - -o /dev/null -G "$SITE/api/file" \
     --data-urlencode "path=$PDF_PATH" --data-urlencode "reader=1" \
     -H 'Range: bytes=0-31'
   ```

   Contrôler la révision et `X-Backend: go`. Quand la source prend en charge les plages, vérifier `206` et `Content-Range`. Une réponse sans ETag fort peut employer le repli SHA prévu pour les fichiers de taille compatible. Le `/api/health` du Worker décrit le Worker, pas l'état complet de Go/Appwrite.
2. Avec le **compte A**, ouvrir un PDF réel, sélectionner et surligner, créer/modifier une note, recharger, changer zoom et rotation ; tester une question IA et une citation ainsi qu'une sélection sur plusieurs pages. Vérifier l'indication de couverture pour une question globale et le message adapté à un scan sans texte.
3. Avec le **compte B**, vérifier qu'aucune note privée de A n'est lisible, modifiable ou supprimable ; vérifier aussi les anciennes annotations et les permissions dans Appwrite. Revenir au compte A et confirmer la persistance. Tester une révision différente du document sans réancrage silencieux.
4. Vérifier les logs, erreurs et le coût des services, les secrets, l'origine publique et les accès. Une réponse 200 de santé ou un test simulé ne remplace pas ces essais de bout en bout sur vos vrais services.
5. L'application Tauri déjà publiée n'est pas automatiquement mise à jour par ce déploiement Web. La nouvelle révision nécessite sa propre compilation, validation sur plateformes/appareils et publication/signature selon la procédure de release. Le test Tauri simulé n'est pas une validation native.

## 7. Retour arrière non destructif

- Arrêter la diffusion du nouveau frontend en restaurant la version Cloudflare connue, ou reconstruire avec un mode de rollout accepté. Identifier précisément le Worker et la version avant de confirmer ; avec la configuration Wrangler correcte, `npx wrangler rollback <id-version-connue>` peut restaurer une version. Vérifier ensuite frontend, bindings et origine API.
- Si nécessaire, rediriger le trafic Cloud Run vers la révision précédente conservée : `gcloud run services update-traffic "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --to-revisions "<revision-precedente>=100"`. Vérifier ses variables et secrets ainsi que sa compatibilité avec le frontend restauré.
- **Conserver toutes les tables et les données.** Une ancienne version peut ne pas afficher les notes PDF v2 ; elles restent en base. Ne pas lancer `--drop` ni écraser la base depuis une sauvegarde sans plan de restauration et évaluation des écritures postérieures. Si le provisioning a changé les permissions d'anciennes tables, les restaurer depuis la configuration sauvegardée et les revérifier avec les deux comptes.
