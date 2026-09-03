/**
 * Script de déploiement automatique du Space Hugging Face
 * 
 * Utilisation:
 *   HF_TOKEN=your_token node deploy-space.js
 * 
 * Variables d'environnement requises:
 *   - HF_TOKEN: Token Hugging Face avec permissions "write" et "repo.create"
 * 
 * Options en ligne de commande:
 *   --space-id <username/space-name>  : ID personnalisé (défaut: <username>/solidworks-viewer)
 *   --private                         : Rendre le Space privé (défaut: public)
 *   --skip-files                      : Ne pas uploader les fichiers (seulement création)
 */

import { existsSync, openAsBlob } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration
const SPACE_NAME = 'solidworks-viewer';
const SPACE_SDK = 'docker';
const SPACE_HARDWARE = 'cpu-basic'; // cpu-basic, cpu-upgrade, t4-medium, a10g-small, a10g-large
const README_CONTENT = `---
title: SolidWorks Viewer
emoji: 🔧
colorFrom: blue
colorTo: gray
sdk: docker
pinned: false
license: mit
tags:
  - cad
  - solidworks
  - freecad
  - 3d
  - converter
---

# SolidWorks to glTF Converter

Convertit les fichiers SolidWorks (.sldprt) en format glTF (.glb) pour visualisation web.

## Comment utiliser

1. Uploadez un fichier \`.sldprt\`
2. Attendez la conversion (30-60s au premier appel - cold start)
3. Téléchargez le fichier \`.glb\` résultant

## Limites

- Format expérimental: peut échouer sur des pièces complexes
- Seule la géométrie est conservée (pas de couleurs/matériaux)
- Timeout: 120 secondes maximum

## Technologie

- FreeCAD (headless) pour la conversion .sldprt → .stl
- trimesh pour la conversion .stl → .glb avec mise à l'échelle mm→mètres
`;

/**
 * Parse les arguments CLI
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    spaceId: null,
    private: false,
    skipFiles: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--space-id' && args[i + 1]) {
      options.spaceId = args[++i];
    } else if (args[i] === '--private') {
      options.private = true;
    } else if (args[i] === '--skip-files') {
      options.skipFiles = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node deploy-space.js [options]

Options:
  --space-id <id>     Space ID (format: username/space-name)
  --private           Créer un Space privé
  --skip-files        Ne pas uploader les fichiers
  --help, -h          Afficher cette aide

Variables d'environnement:
  HF_TOKEN            Token Hugging Face (requis)
`);
      process.exit(0);
    }
  }

  return options;
}

/**
 * Récupère le username depuis l'API Hugging Face
 */
async function getUsername(hf) {
  try {
    const response = await fetch('https://huggingface.co/api/whoami-v2', {
      headers: {
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
      },
    });
    
    if (!response.ok) {
      throw new Error('Impossible de récupérer les informations utilisateur');
    }
    
    const data = await response.json();
    return data.name;
  } catch (error) {
    console.error('Erreur lors de la récupération du username:', error.message);
    throw error;
  }
}

/**
 * Crée le Space via l'API Hugging Face
 */
async function createSpace(hf, spaceId, isPrivate) {
  console.log(`\n🚀 Création du Space: ${spaceId}`);
  console.log(`   SDK: ${SPACE_SDK}`);
  console.log(`   Hardware: ${SPACE_HARDWARE}`);
  console.log(`   Visibilité: ${isPrivate ? 'privé' : 'public'}`);

  try {
    const response = await fetch('https://huggingface.co/api/repos/create', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'space',
        name: spaceId,
        sdk: SPACE_SDK,
        hardware: SPACE_HARDWARE,
        private: isPrivate,
      }),
    });

    if (response.status === 409) {
      console.log(`⚠️  Le Space ${spaceId} existe déjà`);
      return false;
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Erreur API: ${response.status} - ${error}`);
    }

    console.log(`✅ Space créé avec succès`);
    return true;
  } catch (error) {
    console.error('❌ Erreur lors de la création du Space:', error.message);
    throw error;
  }
}

/**
 * Upload un fichier vers le Space
 */
async function uploadFile(spaceId, filePath, pathInRepo = null) {
  const fileName = basename(filePath);
  const relativePath = pathInRepo || fileName;

  console.log(`   📤 Upload: ${relativePath}`);

  try {
    const fileData = await openAsBlob(filePath);
    const formData = new FormData();
    formData.append('file', fileData, fileName);
    formData.append('path_in_repo', relativePath);
    formData.append('commit_message', `Upload ${relativePath}`);

    const response = await fetch(
      `https://huggingface.co/api/${spaceId}/commit/main`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.HF_TOKEN}`,
        },
        body: formData,
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Erreur upload: ${response.status} - ${error}`);
    }

    return true;
  } catch (error) {
    console.error(`   ❌ Erreur upload ${fileName}:`, error.message);
    throw error;
  }
}

/**
 * Upload tous les fichiers du Space
 */
async function uploadSpaceFiles(spaceId, sourceDir) {
  console.log(`\n📁 Upload des fichiers depuis ${sourceDir}`);

  const files = [
    'Dockerfile',
    'requirements.txt',
    'app.py',
    'freecad_convert.py',
    'README.md',
  ];

  for (const file of files) {
    const filePath = join(sourceDir, file);
    
    if (!existsSync(filePath)) {
      console.warn(`   ⚠️  Fichier manquant: ${filePath}`);
      continue;
    }

    await uploadFile(spaceId, filePath, file);
  }

  console.log(`✅ Tous les fichiers ont été uploadés`);
}

/**
 * Attend que le Space soit déployé
 */
async function waitForDeployment(spaceId, timeout = 600000) {
  console.log(`\n⏳ Attente du déploiement (timeout: ${timeout / 60000}min)...`);

  const startTime = Date.now();
  const checkInterval = 10000; // 10 secondes

  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(
        `https://huggingface.co/api/spaces/${spaceId}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.HF_TOKEN}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Erreur status: ${response.status}`);
      }

      const data = await response.json();
      const runtime = data.runtime || {};
      const stage = runtime.stage || 'NO_APP_FILE';

      console.log(`   Status: ${stage}`);

      if (stage === 'RUNNING') {
        console.log(`✅ Space déployé et opérationnel!`);
        return true;
      }

      if (stage === 'RUNTIME_ERROR') {
        console.error(`❌ Erreur de déploiement: ${runtime.message || 'Erreur inconnue'}`);
        return false;
      }
    } catch (error) {
      console.error(`   Erreur vérification status:`, error.message);
    }

    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }

  console.error(`⏰ Timeout atteint - le déploiement est toujours en cours`);
  return false;
}

/**
 * Fonction principale
 */
async function main() {
  const options = parseArgs();

  // Afficher l'aide si demandée (avant vérification du token)
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    return; // Déjà affiché par parseArgs
  }

  console.log('🔧 Déploiement automatique du Space SolidWorks Viewer\n');

  // Vérification du token
  if (!process.env.HF_TOKEN) {
    console.error('❌ Variable HF_TOKEN manquante');
    console.error('   Usage: HF_TOKEN=your_token node deploy-space.js');
    console.error('   Ou: HF_TOKEN=your_token npm run deploy:space');
    process.exit(1);
  }
  const sourceDir = join(__dirname, '..', 'space-huggingface');

  // Vérifier que les fichiers sources existent
  if (!existsSync(sourceDir)) {
    console.error(`❌ Dossier source introuvable: ${sourceDir}`);
    process.exit(1);
  }

  try {
    // Récupérer le username
    console.log('📋 Récupération des informations utilisateur...');
    const username = await getUsername();
    
    // Déterminer le spaceId
    const spaceId = options.spaceId || `${username}/${SPACE_NAME}`;
    console.log(`🎯 Space ID cible: ${spaceId}`);

    // Créer le Space
    await createSpace(spaceId, options.private);

    // Upload des fichiers
    if (!options.skipFiles) {
      await uploadSpaceFiles(spaceId, sourceDir);
    }

    // Attendre le déploiement
    console.log('\n🔄 Le déploiement va prendre quelques minutes...');
    console.log(`   Vous pouvez suivre la progression sur:`);
    console.log(`   https://huggingface.co/spaces/${spaceId}`);
    
    const deployed = await waitForDeployment(spaceId);

    if (deployed) {
      console.log('\n✅ DÉPLOIEMENT TERMINÉ AVEC SUCCÈS!');
      console.log(`\n📍 URL du Space: https://huggingface.co/spaces/${spaceId}`);
      console.log(`\n💡 Pour appeler ce Space depuis votre application:`);
      console.log(`   - Utilisez gradio_client (Python) ou @gradio/client (JS)`);
      console.log(`   - Endpoint: https://${spaceId.replace('/', '-')}.hf.space`);
      console.log(`\n⚠️  Note: Le Space se met en veille après inactivité.`);
      console.log(`   Premier appel = cold start (30-60 secondes)`);
    } else {
      console.log('\n⚠️  Déploiement en cours ou échoué - vérifiez les logs manuellement');
      console.log(`   https://huggingface.co/spaces/${spaceId}/tree/main`);
    }

  } catch (error) {
    console.error('\n❌ ERREUR CRITIQUE:', error.message);
    process.exit(1);
  }
}

// Exécution
main().catch(console.error);
