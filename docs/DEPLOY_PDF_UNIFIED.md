# Déployer le lecteur PDF unifié

Ce guide décrit le déploiement **Appwrite → API Go sur Cloud Run → Worker et frontend Cloudflare**. Le PDF original reste dans le bucket Hugging Face existant ; Docling n'est pas nécessaire pour le nouveau parcours PDF. La base et les services de production ne sont pas modifiés par ce document.

> **Commencer par un staging distinct.** Les valeurs par défaut du dépôt pointent vers des ressources existantes. Vérifier explicitement les identifiants, les comptes connectés et les commandes avant de lancer une opération réelle. Les services réellement configurés et les permissions doivent être validés dans votre environnement.

## 1. Prérequis et sauvegardes

- Disposer de Node.js >= 20.19, `npm`, `gcloud` connecté au bon projet Google, et Wrangler connecté au bon compte Cloudflare. Cloud Run/Cloud Build nécessitent les droits et la facturation appropriés. À la racine du dépôt : `npm ci`.
- Identifier séparément les ressources de staging et de production : projet/base Appwrite, clé serveur Appwrite, projet Google, service Cloud Run, Worker et nom de domaine, KV, buckets et fournisseur IA. Le code du nouveau lecteur et son schéma doivent provenir de la même révision.
- Avant le changement, effectuer **et tester une sauvegarde/restauration Appwrite** adaptée à votre instance : toutes les tables et lignes, leurs IDs, permissions et liens avec les utilisateurs. Sauvegarder également la configuration du projet/authentification selon les capacités de votre instance. Ne pas se fier à un export tronqué à la première page.
- Noter la révision Cloud Run servant le trafic, la version/déploiement Cloudflare actuel, ses bindings et secrets, ainsi que la configuration Appwrite existante. Sauvegarder séparément, avec accès restreint, le fichier de configuration du service :

  ```sh
  export PROJECT_ID="identifiant-du-projet-google"
  export REGION="europe-west1"
  export SERVICE="enise-docs-api"  # nom réel du service à sauvegarder
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

Éditer localement `.dev.vars` sans publier son contenu. Remplacer **explicitement** au minimum :

```dotenv
APPWRITE_ENDPOINT="https://endpoint-appwrite-de-cet-environnement/v1"
APPWRITE_PROJECT_ID="projet-appwrite-de-cet-environnement"
APPWRITE_DATABASE_ID="base-appwrite-de-cet-environnement"
APPWRITE_FLAVOR="tablesdb"
APPWRITE_PUBLIC_ORIGIN="https://domaine-du-site-de-cet-environnement"
APPWRITE_API_KEY="cle-serveur-de-provisionnement"
```

- `tablesdb` correspond à l'API TablesDB 2.x ; si l'instance utilise les collections héritées, employer `databases` de manière cohérente dans le fichier et les commandes ci-dessous. L'endpoint doit être celui de l'instance, avec `/v1` une seule fois.
- La clé serveur doit avoir les droits de lecture et d'écriture du schéma nécessaires au script pour la base, les tables/collections, colonnes/attributs, index et permissions. Elle sert au **provisionnement seulement** : elle n'est pas copiée par le script dans Cloud Run et ne doit jamais être exposée au frontend ni préfixée par `VITE_`.
- La nouvelle table est `pdf_annotations_v2` par défaut. Si un ID différent est requis, renseigner `APPWRITE_PDF_ANNOTATIONS_TABLE_ID` **avant** le provisioning et le déploiement ; il doit être distinct de toutes les autres tables. Les IDs personnalisés des profils, favoris, conversations, messages et annotations historiques (`APPWRITE_*_TABLE_ID`) doivent également être identiques entre les deux opérations.
- Si l'assistant IA est requis, renseigner aussi dans `.dev.vars` les variables serveur d'un fournisseur disponible, par exemple `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`, ou les variables Cloudflare AI. Sans fournisseur, la rédaction IA ne sera pas disponible. Ne pas mettre de clé dans les variables `VITE_`, dans Git, dans une capture ou dans le navigateur.
- **Attention aux priorités différentes :** le script Appwrite privilégie les variables déjà exportées dans le shell sur `.dev.vars`, puis lit aussi `.env` et `.env.local` ; le script Cloud Run privilégie `.dev.vars` et complète depuis le shell. Une variable résiduelle peut donc cibler une autre base. Vérifier les noms exportés avec `env | cut -d= -f1 | grep -E '^(APPWRITE_|VITE_APPWRITE_)'` et supprimer/aligner les valeurs conflictuelles sans les afficher. Le dry-run ci-dessous affiche l'endpoint, le projet et les chemins de base effectivement visés.

## 3. Provisionner la base

Exemple pour TablesDB ; utiliser `--flavor=databases` partout pour une instance héritée :

```sh
npm run appwrite:setup -- --dry-run --flavor=tablesdb
```

Lire le plan entier avant confirmation : projet, base, IDs, colonnes, index et surtout permissions de chaque table. **Ce n'est pas une migration limitée à la nouvelle table : le script réapplique les permissions et l'activation de toutes les tables connues, y compris celles qui existent déjà.** Vérifier les conséquences sur la configuration actuelle ; si elles sont inacceptables, ne pas exécuter le script sur cette base et créer le schéma voulu séparément après revue.

Après sauvegarde et validation du plan :

```sh
npm run appwrite:ping
npm run appwrite:setup -- --flavor=tablesdb
npm run appwrite:status -- --flavor=tablesdb
```

Attendre que les colonnes et index soient disponibles. Lire tous les avertissements de `status` et vérifier dans la console les tables, les permissions réelles et la sécurité par ligne/document : **le code de sortie de `status` à lui seul ne garantit pas que tout est correct**. Vérifier notamment l'isolation des notes entre comptes. Les anciennes annotations restent dans leur table ; les nouvelles notes PDF utilisent la table v2.

Ne jamais utiliser `--drop` pour déployer ni pour revenir en arrière : cette option détruit les tables ciblées. Ne pas appliquer `--fix-enums` sans examen séparé de son effet.

## 4. Déployer l'API Go Cloud Run

Utiliser d'abord un service de staging distinct. Le script construit l'image depuis `backend/Dockerfile`, active des API Google si nécessaire, puis publie le service. Il impose les buckets HF historiques du dépôt, `CHAT_TRUST_PROXY=1`, certaines limites Cloud Run et `--allow-unauthenticated` ; il écrit les variables retenues via `--env-vars-file`. Il ne recopie pas automatiquement les autres variables ni les références Secret Manager : selon la configuration existante, elles peuvent être remplacées. Comparer le dry-run et la configuration sauvegardée ; si ces choix ne conviennent pas, adapter/revoir le déploiement et les secrets au lieu d'exécuter le script tel quel. Les clés IA transmises par ce script sont des variables Cloud Run ; gérer les accès IAM et les secrets en conséquence.

**Le staging des exemples n'est pas automatiquement isolé des buckets HF.** La copie du Worker conserve elle aussi le bucket source du fichier de production. Pour un staging complètement isolé, utiliser des buckets de test, adapter les valeurs fixes et le déploiement du backend, ainsi que `HF_BUCKET_ID` dans la configuration du Worker de staging. Vérifier également les autres intégrations et ne pas autoriser de tests d'écriture sur les buckets de production.

**Sécurité :** l'URL Cloud Run est publiquement joignable. Un client direct peut forger des en-têtes d'adresse IP que le backend croit venir du proxy : ne pas considérer la limitation par IP comme une protection suffisante. Fixer `APPWRITE_PUBLIC_ORIGIN` à l'origine HTTPS légitime, revoir IAM/ingress et mettre en place une frontière d'accès fiable compatible avec le Worker et les clients Tauri avant une utilisation sensible.

```sh
export PROJECT_ID="identifiant-du-projet-google-de-staging"
export REGION="europe-west1"
export SERVICE="enise-docs-api-staging"

# --no-origin évite de modifier le wrangler.jsonc de production.
npm run deploy:api:firebase -- --project "$PROJECT_ID" --region "$REGION" \
  --service "$SERVICE" --no-origin --dry-run
# Après revue et uniquement avec les bons accès et la bonne configuration :
npm run deploy:api:firebase -- --project "$PROJECT_ID" --region "$REGION" \
  --service "$SERVICE" --no-origin

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

```sh
# Chemin exact d'un PDF présent dans le bucket, pas une URL :
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
