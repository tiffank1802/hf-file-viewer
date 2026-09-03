# Déploiement automatique du Space Hugging Face

Ce script crée et déploie automatiquement le Space Hugging Face pour la conversion de fichiers SolidWorks.

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
- Créer un Space nommé `<username>/solidworks-viewer`
- Uploader tous les fichiers du dossier `space-huggingface/`
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
🔧 Déploiement automatique du Space SolidWorks Viewer

📋 Récupération des informations utilisateur...
🎯 Space ID cible: mon-username/solidworks-viewer

🚀 Création du Space: mon-username/solidworks-viewer
   SDK: docker
   Hardware: cpu-basic
   Visibilité: public
✅ Space créé avec succès

📁 Upload des fichiers depuis ./space-huggingface
   📤 Upload: Dockerfile
   📤 Upload: requirements.txt
   📤 Upload: app.py
   📤 Upload: freecad_convert.py
   📤 Upload: README.md
✅ Tous les fichiers ont été uploadés

⏳ Attente du déploiement (timeout: 10min)...
   Status: BUILDING
   Status: RUNNING
✅ Space déployé et opérationnel!

✅ DÉPLOIEMENT TERMINÉ AVEC SUCCÈS!

📍 URL du Space: https://huggingface.co/spaces/mon-username/solidworks-viewer
```

## Après le déploiement

### URL d'accès
- Interface web: `https://huggingface.co/spaces/<username>/solidworks-viewer`
- API endpoint: `https://<username>-solidworks-viewer.hf.space`

### Intégration dans votre site

Utilisez l'un des clients fournis:

**Python:**
```python
from gradio_client import Client

client = Client("username/solidworks-viewer")
result = client.predict(
    file="piece.sldprt",
    api_name="/convertir"
)
```

**JavaScript:**
```javascript
import { Client } from '@gradio/client';

const client = await Client.connect('username/solidworks-viewer');
const result = await client.predict('/convertir', {
  file: new File([...], 'piece.sldprt')
});
```

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
https://huggingface.co/spaces/<username>/solidworks-viewer/tree/main

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
