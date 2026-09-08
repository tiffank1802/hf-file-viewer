/**
 * Script de déploiement du Space Hugging Face (convertisseurs 3D + Office).
 *
 * Utilisation:
 *   HF_TOKEN=... npm run deploy:space -- --space-id <utilisateur>/<space>
 *
 * Variables d'environnement requises:
 *   - HF_TOKEN: Token Hugging Face avec permissions "write"
 *
 * Options en ligne de commande:
 *   --space-id <username/space-name>  : ID personnalisé (défaut: <username>/solidworks-viewer)
 *   --private                         : Rendre le Space privé (défaut: public)
 *   --skip-files                      : Ne pas uploader les fichiers (seulement création)
 *
 * Si le Space existe déjà, la création est ignorée et les fichiers sont mis
 * à jour via un commit atomique (format NDJSON officiel du Hub).
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration
const SPACE_NAME = 'solidworks-viewer';
const SPACE_SDK = 'docker';
const SPACE_HARDWARE = 'cpu-basic'; // cpu-basic, cpu-upgrade, t4-medium, a10g-small, a10g-large
const HF_API = 'https://huggingface.co/api';

/** Fichiers synchronisés vers le Space (commit atomique unique). */
const SPACE_FILES = [
  'Dockerfile',
  'requirements.txt',
  'app.py',
  'freecad_convert.py',
  'freecad_cad_convert.py',
  'README.md',
];

/**
 * Parse les arguments CLI.
 */
function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    spaceId: null,
    private: false,
    skipFiles: false,
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--space-id' && argv[i + 1]) {
      options.spaceId = argv[++i];
    } else if (argv[i] === '--private') {
      options.private = true;
    } else if (argv[i] === '--skip-files') {
      options.skipFiles = true;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
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

function authHeaders() {
  return { Authorization: `Bearer ${process.env.HF_TOKEN}` };
}

/**
 * Récupère le username depuis l'API Hugging Face.
 */
async function getUsername() {
  let response;
  try {
    response = await fetch(`${HF_API}/whoami-v2`, { headers: authHeaders() });
  } catch {
    throw new Error('Connexion à Hugging Face impossible.');
  }

  if (response.status === 401) {
    throw new Error('Token HF_TOKEN invalide.');
  }
  if (!response.ok) {
    throw new Error('Impossible de récupérer les informations utilisateur');
  }

  const data = await response.json();
  return data.name;
}

/**
 * Vérifie si le Space existe déjà (évite un appel de création inutile).
 */
async function spaceExists(spaceId) {
  let response;
  try {
    response = await fetch(`${HF_API}/spaces/${spaceId}`, { headers: authHeaders() });
  } catch {
    throw new Error('Connexion à Hugging Face impossible.');
  }

  if (response.status === 401) {
    throw new Error('Token HF_TOKEN invalide.');
  }
  return response.ok;
}

/**
 * Crée le Space via l'API Hugging Face.
 * `name` ne contient que le nom du dépôt, le namespace va dans `organization`
 * (comme `huggingface_hub.create_repo`).
 */
async function createSpace(spaceId, username, isPrivate) {
  console.log(`\n🚀 Création du Space: ${spaceId}`);
  console.log(`   SDK: ${SPACE_SDK}`);
  console.log(`   Hardware: ${SPACE_HARDWARE}`);
  console.log(`   Visibilité: ${isPrivate ? 'privé' : 'public'}`);

  const slash = spaceId.indexOf('/');
  const name = slash === -1 ? spaceId : spaceId.slice(slash + 1);
  const organization = slash === -1 ? null : spaceId.slice(0, slash) || null;

  try {
    const response = await fetch(`${HF_API}/repos/create`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'space',
        name,
        organization,
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
 * Pousse tous les fichiers du Space en un seul commit atomique
 * (format NDJSON officiel : en-tête + un objet `file` base64 par fichier).
 */
async function uploadSpaceFiles(spaceId, sourceDir) {
  console.log(`\n📁 Upload des fichiers depuis ${sourceDir}`);

  const operations = [];
  for (const file of SPACE_FILES) {
    const filePath = join(sourceDir, file);
    if (!existsSync(filePath)) {
      throw new Error(`Fichier source manquant: ${filePath}`);
    }
    console.log(`   📤 Commit: ${file}`);
    operations.push({
      key: 'file',
      value: { content: readFileSync(filePath).toString('base64'), path: file, encoding: 'base64' },
    });
  }

  const lines = [
    { key: 'header', value: { summary: 'Deploy converters (3D + Office)', description: '' } },
    ...operations,
  ];
  const body = lines.map((line) => JSON.stringify(line)).join('\n');

  let response;
  try {
    response = await fetch(`${HF_API}/spaces/${spaceId}/commit/main`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/x-ndjson' },
      body,
    });
  } catch {
    throw new Error('Connexion à Hugging Face impossible pendant l’upload.');
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Erreur upload: ${response.status} - ${error}`);
  }

  console.log(`✅ Commit poussé (${operations.length} fichiers)`);
}

/**
 * Attend que le Space soit déployé.
 */
async function waitForDeployment(spaceId, timeout = 600000) {
  console.log(`\n⏳ Attente du déploiement (timeout: ${timeout / 60000}min)...`);

  const startTime = Date.now();
  const checkInterval = 10000; // 10 secondes

  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(`${HF_API}/spaces/${spaceId}`, { headers: authHeaders() });

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

      if (stage === 'RUNTIME_ERROR' || stage === 'BUILD_ERROR') {
        const detail = runtime.message || JSON.stringify(runtime);
        console.error(`❌ Erreur de déploiement: ${detail}`);
        return false;
      }
    } catch (error) {
      console.error(`   Erreur vérification status:`, error.message);
    }

    await new Promise((resolveTimer) => setTimeout(resolveTimer, checkInterval));
  }

  console.error(`⏰ Timeout atteint - le déploiement est toujours en cours`);
  return false;
}

/**
 * Fonction principale.
 */
async function main() {
  const options = parseArgs();

  // Afficher l'aide si demandée (avant vérification du token)
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    return; // Déjà affiché par parseArgs
  }

  console.log('🔧 Déploiement automatique du Space ENISE Converters (3D + Office)\n');

  // Vérification du token
  if (!process.env.HF_TOKEN) {
    console.error('❌ Variable HF_TOKEN manquante');
    console.error('   Usage: HF_TOKEN=your_token npm run deploy:space -- --space-id <user>/<space>');
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

    // Créer le Space sauf s'il existe déjà
    if (await spaceExists(spaceId)) {
      console.log(`⚠️  Le Space ${spaceId} existe déjà — mise à jour des fichiers.`);
    } else {
      await createSpace(spaceId, username, options.private);
    }

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
      console.log(`\n💡 Endpoints utilisés par le Worker Cloudflare:`);
      console.log(`   - POST https://${spaceId.replace('/', '-')}.hf.space/api/convert-3d`);
      console.log(`   - POST https://${spaceId.replace('/', '-')}.hf.space/api/convert-office`);
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

// Exécution uniquement en appel direct (pas à l'import pour les tests)
const invokedAsScript = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().catch(console.error);
}

export { HF_API, SPACE_FILES, createSpace, parseArgs, spaceExists, uploadSpaceFiles, waitForDeployment };
