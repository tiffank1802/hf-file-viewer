# Pipeline de conversion et visualisation web de fichiers SolidWorks (.sldprt)

Ce projet contient tous les éléments nécessaires pour mettre en place un pipeline complet de conversion de fichiers SolidWorks (.sldprt) vers un format visualisable dans le navigateur (GLB), ainsi que l'intégration d'un viewer 3D interactif.

## 📁 Structure du projet

```
/workspace/
├── space-huggingface/          # Hugging Face Space (moteur de conversion)
│   ├── Dockerfile              # Configuration Docker avec FreeCAD
│   ├── requirements.txt        # Dépendances Python
│   ├── app.py                  # Application Gradio (API de conversion)
│   ├── freecad_convert.py      # Script de conversion FreeCAD
│   └── README.md               # Documentation du Space
│
├── client-examples/            # Exemples d'intégration client
│   ├── python-client.py        # Client Python (gradio_client)
│   ├── javascript-client.js    # Client JavaScript (@gradio/client)
│   └── model-viewer-integration.html  # Viewer HTML avec model-viewer
│
└── PIPELINE_README.md          # Ce fichier
```

## 🏗️ Architecture

```
┌─────────────────┐     ┌─────────────────────────────┐     ┌──────────────────┐
│  Utilisateur    │     │  Hugging Face Space         │     │  Site Web        │
│  upload .sldprt │────▶│  (Docker + FreeCAD)         │────▶│  <model-viewer>  │
│                 │     │                             │     │                  │
│                 │     │  1. freecadcmd: .sldprt     │     │  Affichage GLB   │
│                 │     │           → .stl            │     │  interactif      │
│                 │     │  2. trimesh: .stl → .glb    │     │                  │
│                 │     │     (échelle: 0.001)        │     │                  │
└─────────────────┘     └─────────────────────────────┘     └──────────────────┘
```

## 🚀 Déploiement du Space Hugging Face

### Étape 1 : Créer un nouveau Space

1. Allez sur https://huggingface.co/spaces
2. Cliquez sur "Create new Space"
3. Remplissez :
   - **Space name**: `sldprt-to-glb` (ou votre choix)
   - **License**: MIT
   - **SDK**: **Docker** (important !)
   - **Visibility**: Public ou Private selon vos besoins

### Étape 2 : Pousser les fichiers

```bash
cd /workspace/space-huggingface

# Initialiser le repo Git si nécessaire
git init
git add .
git commit -m "Initial commit: SolidWorks to GLB converter"

# Ajouter le remote Hugging Face
git remote add origin https://huggingface.co/spaces/YOUR_USERNAME/sldprt-to-glb

# Pousser
git push -u origin main
```

### Étape 3 : Attendre le build

- Le Space va construire l'image Docker (~5-10 minutes)
- Une fois prêt, l'interface Gradio sera accessible
- Notez l'URL du Space : `https://huggingface.co/spaces/YOUR_USERNAME/sldprt-to-glb`

## 📡 Appel de l'API depuis votre site

### Option A : Backend Python

```python
from gradio_client import Client

# Initialiser le client
client = Client("YOUR_USERNAME/sldprt-to-glb")

# Convertir un fichier
result = client.predict(
    uploaded_file="/chemin/vers/fichier.sldprt",
    api_name="/process_file"
)

print(f"Fichier GLB généré : {result}")
```

Voir `/workspace/client-examples/python-client.py` pour un exemple complet avec Flask.

### Option B : Backend Node.js/JavaScript

```javascript
import { Client } from "@gradio/client";

const client = new Client("YOUR_USERNAME/sldprt-to-glb");

const result = await client.predict("/process_file", {
    uploaded_file: fileInput.files[0]
});

console.log("GLB file:", result.data);
```

Voir `/workspace/client-examples/javascript-client.js` pour un exemple complet avec Express.

### ⚠️ Important : Sécurité

- **Toujours appeler le Space depuis votre backend**, jamais directement depuis le navigateur
- Stockez `HF_TOKEN` dans les variables d'environnement (jamais dans le code client)
- Pour un Space public, le token n'est pas requis pour la lecture

## 🎨 Intégration du viewer 3D

### Utilisation de `<model-viewer>`

```html
<script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js"></script>

<model-viewer
    src="URL_DE_VOTRE_FICHIER_GLB.glb"
    camera-controls
    auto-rotate
    shadow-intensity="1"
    style="width: 100%; height: 500px;">
</model-viewer>
```

Voir `/workspace/client-examples/model-viewer-integration.html` pour une implémentation complète avec :
- Contrôles interactifs (rotation, zoom, panoramique)
- Bouton AR pour mobile
- Indicateurs de chargement
- Interface responsive

## ⚠️ Limites et considérations

### Limitations techniques

| Aspect | Préservé ? | Notes |
|--------|-----------|-------|
| Géométrie | ✅ Oui | Maillage tessellé |
| Couleurs | ❌ Non | Perdu dans la conversion |
| Matériaux | ❌ Non | Perdu dans la conversion |
| Historique paramétrique | ❌ Non | Format maillé uniquement |
| Assemblages | ⚠️ Partiel | Tester au cas par cas |

### Fiabilité de lecture .sldprt

Le module d'import `.sldprt` de FreeCAD est **expérimental** :

- ✅ **Fonctionne bien** : Pièces simples, géométrie basique
- ⚠️ **Peut échouer** : Surfaces complexes, features récentes
- ❌ **Non supporté** : Certaines fonctionnalités SolidWorks avancées

### Cold Start

Les Spaces gratuits se mettent en veille après inactivité :
- **Premier appel** : 30-60 secondes (cold start)
- **Appels suivants** : ~5-10 secondes

Prévoyez un état de chargement dans votre UI.

## 🔧 Personnalisation

### Modifier l'échelle de conversion

Dans `app.py`, ligne ~85 :
```python
geom.apply_scale(0.001)  # mm → mètres
```

Ajustez selon vos besoins (certaines pièces peuvent être dans une autre unité).

### Augmenter le timeout FreeCAD

Dans `app.py`, ligne ~55 :
```python
timeout=120  # secondes
```

Augmentez pour des pièces très complexes.

### Changer la qualité du maillage

Dans `freecad_convert.py`, ligne ~45 :
```python
mesh = Mesh.Mesh(obj.Shape.tessellate(0.1)[0])
```

Valeur plus petite = maillage plus fin (mais fichier plus lourd).

## 📊 Cas d'usage recommandés

| Usage | Recommandé | Alternative |
|-------|-----------|-------------|
| Portfolio personnel | ✅ Oui | - |
| Prototype / MVP | ✅ Oui | - |
| Visualisation client simple | ✅ Oui | - |
| Assemblages complexes | ⚠️ Tester | HOOPS Exchange |
| Tolérances critiques | ❌ Non | CAD Exchanger |
| Conservation couleurs | ❌ Non | SDK commercial |

## 🆘 Dépannage

### Erreur : "freecadcmd not found"
→ Vérifiez que le Space utilise bien le SDK Docker (pas Gradio natif)

### Erreur : "Failed to open document"
→ Le fichier .sldprt utilise des features non supportées par FreeCAD
→ Essayez d'exporter depuis SolidWorks en STEP ou IGES, puis convertissez

### Timeout de conversion
→ La pièce est trop complexe
→ Augmentez le timeout dans `app.py` ou simplifiez le maillage

### Fichier GLB vide ou corrompu
→ Vérifiez que le fichier STL intermédiaire a été créé
→ Consultez les logs du Space Hugging Face

## 📄 Licences

- **Code source** : MIT License
- **FreeCAD** : LGPL-2.0-or-later
- **trimesh** : MIT License
- **model-viewer** : Apache 2.0
- **Gradio** : Apache 2.0

## 🔗 Ressources

- [Documentation FreeCAD](https://wiki.freecad.org/)
- [Documentation trimesh](https://trimsh.org/)
- [Documentation model-viewer](https://modelviewer.dev/)
- [Documentation Gradio Client](https://www.gradio.app/guides/getting-started-with-the-python-client)
- [Hugging Face Spaces Docker](https://huggingface.co/docs/hub/spaces-sdks-docker)
