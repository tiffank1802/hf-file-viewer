/**
 * Déploie le préprocesseur documentaire Docling dans ktongue/Rupture.
 *
 * Le commit Hub est atomique : il ajoute la nouvelle application et supprime,
 * dans la même révision, chaque fichier distant absent de l'allowlist. Cela
 * retire réellement les anciens convertisseurs LibreOffice, FreeCAD, CAO et
 * SolidWorks, y compris les fichiers qui n'existent plus dans ce checkout.
 *
 * Utilisation :
 *   HF_TOKEN=... npm run deploy:space
 *   HF_TOKEN=... npm run deploy:space -- --space-id utilisateur/space
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SPACE_ID = 'ktongue/Rupture';
const SPACE_SDK = 'docker';
const SPACE_HARDWARE = 'cpu-basic';
const HF_API = 'https://huggingface.co/api';

/** Fichiers qui constituent intégralement l'application Docling distante. */
const SPACE_FILES = [
  'Dockerfile',
  'requirements.txt',
  'app.py',
  'reader_pipeline.py',
  'README.md',
];

/** Fichiers Hub gérés par la plateforme et conservés s'ils existent déjà. */
const PRESERVED_REMOTE_FILES = new Set(['.gitattributes']);

const SPACE_VARIABLES = {
  SOURCE_BUCKET_ID: 'ktongue/ENISE-SITE',
  DERIVED_BUCKET_ID: 'ktongue/ENISE-SITE-DERIVED',
  PIPELINE_VERSION: 'docling-2.130.0-enise-reader-v1',
  AUTO_SYNC_ON_START: '1',
  SYNC_INTERVAL_SECONDS: '21600',
};

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    spaceId: DEFAULT_SPACE_ID,
    private: false,
    skipFiles: false,
    prune: true,
    configureHfToken: true,
    configureVariables: true,
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--space-id' && argv[i + 1]) {
      options.spaceId = argv[++i];
    } else if (argv[i] === '--private') {
      options.private = true;
    } else if (argv[i] === '--skip-files') {
      options.skipFiles = true;
    } else if (argv[i] === '--no-prune') {
      options.prune = false;
    } else if (argv[i] === '--skip-hf-token-secret') {
      options.configureHfToken = false;
    } else if (argv[i] === '--skip-variables') {
      options.configureVariables = false;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(`
Usage: node scripts/deploy-space.js [options]

Options:
  --space-id <id>              Space cible (défaut: ${DEFAULT_SPACE_ID})
  --private                    Créer un éventuel nouveau Space privé
  --skip-files                 Ne pas pousser de commit
  --no-prune                   Conserver les fichiers distants hors allowlist
  --skip-hf-token-secret       Ne pas configurer HF_TOKEN comme secret du Space
  --skip-variables             Ne pas configurer les variables bucket/pipeline
  --help, -h                   Afficher cette aide

Variables d'environnement:
  HF_TOKEN                     Token Hugging Face write (requis)
  SYNC_TOKEN                   Secret admin facultatif à installer dans le Space
`);
      process.exitCode = 0;
    } else {
      throw new Error(`Option inconnue: ${argv[i]}`);
    }
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(options.spaceId)) {
    throw new Error(`Space ID invalide: ${options.spaceId}`);
  }
  return options;
}

function authHeaders() {
  return { Authorization: `Bearer ${process.env.HF_TOKEN}` };
}

async function checkedFetch(url, init, context) {
  let response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error(`Connexion à Hugging Face impossible (${context}).`);
  }
  if (response.status === 401) {
    throw new Error('Token HF_TOKEN invalide ou expiré.');
  }
  return response;
}

async function getUsername() {
  const response = await checkedFetch(
    `${HF_API}/whoami-v2`,
    { headers: authHeaders() },
    'identité',
  );
  if (!response.ok) {
    throw new Error(`Impossible de récupérer le compte Hugging Face (${response.status}).`);
  }
  return (await response.json()).name;
}

async function spaceExists(spaceId) {
  const response = await checkedFetch(
    `${HF_API}/spaces/${spaceId}`,
    { headers: authHeaders() },
    'vérification du Space',
  );
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`Impossible de vérifier le Space (${response.status}).`);
  }
  return true;
}

async function createSpace(spaceId, _username, isPrivate) {
  console.log(`\n🚀 Création du Space ${spaceId}`);
  const slash = spaceId.indexOf('/');
  const response = await checkedFetch(
    `${HF_API}/repos/create`,
    {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'space',
        name: spaceId.slice(slash + 1),
        organization: spaceId.slice(0, slash),
        sdk: SPACE_SDK,
        hardware: SPACE_HARDWARE,
        private: isPrivate,
      }),
    },
    'création du Space',
  );
  if (response.status === 409) return false;
  if (!response.ok) {
    throw new Error(`Création refusée (${response.status}): ${await response.text()}`);
  }
  return true;
}

/** Retourne uniquement les fichiers, jamais les pseudo-entrées de dossier. */
async function listRemoteSpaceFiles(spaceId) {
  const url = `${HF_API}/spaces/${spaceId}/tree/main?recursive=true&expand=false`;
  const response = await checkedFetch(
    url,
    { headers: authHeaders() },
    'inventaire des fichiers distants',
  );
  if (!response.ok) {
    throw new Error(`Inventaire distant impossible (${response.status}): ${await response.text()}`);
  }
  const tree = await response.json();
  if (!Array.isArray(tree)) throw new Error('Réponse d’inventaire Hugging Face invalide.');
  return tree
    .filter((entry) => entry && entry.type === 'file' && typeof entry.path === 'string')
    .map((entry) => entry.path);
}

/**
 * Construit l'ensemble déterministe des écritures et suppressions.
 * Exporté pour vérifier séparément la barrière destructive du déploiement.
 */
function buildSyncOperations(sourceDir, remoteFiles, { prune = true } = {}) {
  const operations = [];
  for (const file of SPACE_FILES) {
    const filePath = join(sourceDir, file);
    if (!existsSync(filePath)) throw new Error(`Fichier source manquant: ${filePath}`);
    operations.push({
      key: 'file',
      value: {
        content: readFileSync(filePath).toString('base64'),
        path: file,
        encoding: 'base64',
      },
    });
  }

  if (prune) {
    const allowed = new Set([...SPACE_FILES, ...PRESERVED_REMOTE_FILES]);
    const stale = [...new Set(remoteFiles)]
      .filter((path) => !allowed.has(path))
      .sort((left, right) => left.localeCompare(right));
    for (const path of stale) {
      operations.push({ key: 'deletedFile', value: { path } });
    }
  }
  return operations;
}

/** Un commit unique remplace l'application et retire tous les fichiers obsolètes. */
async function uploadSpaceFiles(spaceId, sourceDir, options = {}) {
  console.log(`\n📁 Synchronisation atomique depuis ${sourceDir}`);
  const remoteFiles = options.remoteFiles || await listRemoteSpaceFiles(spaceId);
  const operations = buildSyncOperations(sourceDir, remoteFiles, {
    prune: options.prune !== false,
  });
  const deleted = operations.filter((operation) => operation.key === 'deletedFile');
  for (const operation of operations) {
    const icon = operation.key === 'file' ? '📤' : '🗑️ ';
    console.log(`   ${icon} ${operation.value.path}`);
  }

  const lines = [
    {
      key: 'header',
      value: {
        summary: 'Replace legacy converters with Docling batch preprocessing',
        description: 'Atomic replacement; obsolete LibreOffice, FreeCAD, CAD and SolidWorks files are removed.',
      },
    },
    ...operations,
  ];
  const body = lines.map((line) => JSON.stringify(line)).join('\n');
  const response = await checkedFetch(
    `${HF_API}/spaces/${spaceId}/commit/main`,
    {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/x-ndjson' },
      body,
    },
    'commit du Space',
  );
  if (!response.ok) {
    throw new Error(`Commit refusé (${response.status}): ${await response.text()}`);
  }
  console.log(`✅ Commit poussé: ${SPACE_FILES.length} fichiers écrits, ${deleted.length} supprimés.`);
  return { uploaded: SPACE_FILES.length, deleted: deleted.length };
}

async function setSpaceSecret(spaceId, key, value, description) {
  if (!value) return false;
  const response = await checkedFetch(
    `${HF_API}/spaces/${spaceId}/secrets`,
    {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value, description }),
    },
    `configuration du secret ${key}`,
  );
  if (!response.ok) {
    throw new Error(`Secret ${key} refusé (${response.status}): ${await response.text()}`);
  }
  console.log(`   🔒 Secret ${key} configuré (valeur non affichée).`);
  return true;
}

async function setSpaceVariable(spaceId, key, value) {
  const response = await checkedFetch(
    `${HF_API}/spaces/${spaceId}/variables`,
    {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    },
    `configuration de la variable ${key}`,
  );
  if (!response.ok) {
    throw new Error(`Variable ${key} refusée (${response.status}): ${await response.text()}`);
  }
  console.log(`   ⚙️  ${key}=${value}`);
}

async function configureSpace(spaceId, options) {
  console.log('\n🔐 Configuration du runtime');
  if (options.configureHfToken) {
    await setSpaceSecret(
      spaceId,
      'HF_TOKEN',
      process.env.HF_TOKEN,
      'Lecture du bucket source et écriture des artefacts Docling',
    );
  }
  if (process.env.SYNC_TOKEN) {
    await setSpaceSecret(
      spaceId,
      'SYNC_TOKEN',
      process.env.SYNC_TOKEN,
      'Authentification des commandes administratives de synchronisation',
    );
  }
  if (options.configureVariables) {
    for (const [key, value] of Object.entries(SPACE_VARIABLES)) {
      await setSpaceVariable(spaceId, key, value);
    }
  }
}

async function waitForDeployment(spaceId, timeout = 600000) {
  console.log(`\n⏳ Construction du Space (timeout ${timeout / 60000} min)…`);
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const response = await checkedFetch(
      `${HF_API}/spaces/${spaceId}`,
      { headers: authHeaders() },
      'état du déploiement',
    );
    if (response.ok) {
      const runtime = (await response.json()).runtime || {};
      const stage = runtime.stage || 'NO_APP_FILE';
      console.log(`   ${stage}`);
      if (stage === 'RUNNING') return true;
      if (stage === 'RUNTIME_ERROR' || stage === 'BUILD_ERROR') return false;
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10000));
  }
  return false;
}

async function main() {
  const options = parseArgs();
  if (process.argv.includes('--help') || process.argv.includes('-h')) return;
  if (!process.env.HF_TOKEN) throw new Error('Variable HF_TOKEN manquante.');

  console.log('📚 Déploiement du préprocesseur documentaire ENISE');
  const sourceDir = join(__dirname, '..', 'space-huggingface');
  if (!existsSync(sourceDir)) throw new Error(`Dossier source introuvable: ${sourceDir}`);

  const username = await getUsername();
  if (await spaceExists(options.spaceId)) {
    console.log(`🎯 Mise à jour de ${options.spaceId}`);
  } else {
    await createSpace(options.spaceId, username, options.private);
  }

  await configureSpace(options.spaceId, options);
  if (!options.skipFiles) {
    await uploadSpaceFiles(options.spaceId, sourceDir, { prune: options.prune });
  }

  console.log(`\n🔎 Suivi: https://huggingface.co/spaces/${options.spaceId}`);
  const deployed = await waitForDeployment(options.spaceId);
  if (!deployed) throw new Error('Le Space n’a pas atteint l’état RUNNING; consultez ses logs.');
  const runtimeHost = `https://${options.spaceId.replace('/', '-').toLowerCase()}.hf.space`;
  console.log(`✅ Service prêt: ${runtimeHost}/api/status`);
  console.log('ℹ️  Le scan démarre automatiquement. Aucun visiteur ne lance de conversion.');
}

const invokedAsScript = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().catch((error) => {
    console.error(`\n❌ ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  DEFAULT_SPACE_ID,
  HF_API,
  PRESERVED_REMOTE_FILES,
  SPACE_FILES,
  SPACE_VARIABLES,
  buildSyncOperations,
  configureSpace,
  createSpace,
  listRemoteSpaceFiles,
  parseArgs,
  setSpaceSecret,
  setSpaceVariable,
  spaceExists,
  uploadSpaceFiles,
  waitForDeployment,
};
