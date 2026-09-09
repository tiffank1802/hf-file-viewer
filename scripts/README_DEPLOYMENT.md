# Déploiement automatique du Space Hugging Face

Ce script crée et déploie automatiquement le Space Hugging Face ENISE Converters (conversion 3D → GLB via FreeCAD et Office → PDF via LibreOffice).

## Prérequis

1. **Token Hugging Face** avec permissions:
   - `write`
   - `repo.create`

2. **Node.js** >= 20.19.0

3. **Dépendances npm** installées:
   ```bash
   npm install
   ```

## Obtenir un token Hugging Face

1. Allez sur https://huggingface.co/settings/tokens
2. Créez un nouveau token avec:
   - Type: **Write**
   - Permissions: `repo.create`, `repo.write`
3. Copiez le token (commence par `hf_...`)

## Utilisation

### Déploiement simple

```bash
HF_TOKEN=votre_token npm run deploy:space
```

Le script va:
- Récupérer votre username Hugging Face automatiquement
- Créer le Space s'il n'existe pas (défaut : `<username>/solidworks-viewer`), sinon mettre à jour ses fichiers
- Pousser les fichiers du dossier `space-huggingface/` en un commit atomique
- Attendre le déploiement (quelques minutes)

### Options avancées

```bash
# Space avec un nom personnalisé
HF_TOKEN=votre_token npm run deploy:space -- --space-id mon-org/mon-space

# Créer un Space privé
HF_TOKEN=votre_token npm run deploy:space -- --private

# Seulement créer le Space (sans uploader les fichiers)
HF_TOKEN=votre_token npm run deploy:space -- --skip-files

# Aide
npm run deploy:space -- --help
```

## Sortie attendue

```
🔧 Déploiement automatique du Space ENISE Converters (3D + Office)

📋 Récupération des informations utilisateur...
🎯 Space ID cible: mon-username/mon-space

⚠️  Le Space mon-username/mon-space existe déjà — mise à jour des fichiers.

📁 Upload des fichiers depuis ./space-huggingface
   📤 Commit: Dockerfile
   📤 Commit: requirements.txt
   📤 Commit: app.py
   📤 Commit: freecad_cad_convert.py
   📤 Commit: README.md
✅ Commit poussé (5 fichiers)

⏳ Attente du déploiement (timeout: 10min)...
   Status: BUILDING
   Status: RUNNING
✅ Space déployé et opérationnel!

✅ DÉPLOIEMENT TERMINÉ AVEC SUCCÈS!

📍 URL du Space: https://huggingface.co/spaces/mon-username/mon-space

💡 Endpoints utilisés par le Worker Cloudflare:
   - POST https://mon-username-mon-space.hf.space/api/convert-3d
   - POST https://mon-username-mon-space.hf.space/api/convert-office
```

## Après le déploiement

### URL d'accès
- Interface web : `https://huggingface.co/spaces/<username>/<space>`
- API runtime : `https://<username>-<space>.hf.space`

### Intégration dans votre site

Le Worker Cloudflare appelle l'API REST du Space (pas de client Gradio) :

```bash
# Conversion 3D : STEP/IGES/STL/OBJ → GLB (+ X-Model3D-Meta)
curl -X POST https://<username>-<space>.hf.space/api/convert-3d \
  -F "file=@piece.step;filename=piece.step" -F "quality=standard" \
  --output piece.glb

# Conversion Office → PDF
curl -X POST https://<username>-<space>.hf.space/api/convert-office \
  -F "file=@doc.docx;filename=doc.docx" --output doc.pdf
```

Le pipeline SolidWorks → STEP est également présent, mais le binaire HOOPS
propriétaire n’est pas uploadé par ce script. Il faut utiliser une image privée
ou un montage contenant HOOPS Converter, puis configurer `HOOPS_LICENSE_FILE`
ou `HOOPS_LICENSE_KEY`, `HF_BUCKET_ID`, un `HF_TOKEN` avec droit d’écriture et
`SOLIDWORKS_CONVERTER_TOKEN`. Le Worker appelle alors
`POST /api/convert-solidworks-step` et le service écrit sous `derived/step/`.

Exemples complets : `client-examples/python-client.py` et
`client-examples/javascript-client.js`.

## Dépannage

### Erreur "Token invalide"
Vérifiez que votre token HF_TOKEN est correct et n'a pas expiré.

### Erreur "Space existe déjà"
Le script détecte automatiquement cette situation et continue avec l'upload des fichiers.

### Timeout de déploiement
Le déploiement Docker peut prendre 5-10 minutes. Augmentez le timeout:
```bash
# Modifier waitForDeployment() dans deploy-space.js
const timeout = 1200000; // 20 minutes
```

### Erreur de build Docker
Consultez les logs du Space:
https://huggingface.co/spaces/<username>/<space>/tree/main

## Coûts

- **cpu-basic**: Gratuit (2 vCPU, mémoire limitée)
- **cpu-upgrade**: ~$0.05/heure
- **t4-medium** (GPU): ~$0.23/heure

Pour un usage personnel/portfolio, `cpu-basic` est suffisant.

## Sécurité

⚠️ **Ne jamais exposer HF_TOKEN côté client!**

Appelez toujours le Space depuis votre backend:
```
Browser → Votre Backend (HF_TOKEN) → Space Hugging Face
```
