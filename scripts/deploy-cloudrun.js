#!/usr/bin/env node
/**
 * Déploie l’API Go d’ENISE Docs sur Cloud Run, dans le projet Firebase.
 *
 *   npm run deploy:api:firebase -- --project <id-du-projet>
 *
 * Le site reste sur Cloudflare Workers : le Worker appelle directement l’URL
 * *.run.app (GO_API_ORIGIN). Passer par Firebase Hosting couperait les
 * réponses de l’assistant à 60 secondes.
 *
 * Étapes : active les API Google nécessaires, construit l’image depuis
 * backend/Dockerfile (Cloud Build), déploie le service, vérifie /api/health
 * puis écrit GO_API_ORIGIN dans wrangler.jsonc. Il reste `npm run deploy`.
 *
 * Prérequis : gcloud installé et connecté (gcloud auth login), projet
 * Firebase au plan Blaze (Cloud Run exige un compte de facturation).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrigin } from './deploy-api.js';
import { checkHealth, normalizeOrigin } from './set-api-origin.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = {
  service: 'enise-docs-api',
  // Belgique : palier tarifaire 1 de Cloud Run, proche de Paris.
  region: 'europe-west1',
};

/** Variables fixes : le service n’est joint que par le Worker. */
export const FIXED_ENV = {
  CHAT_TRUST_PROXY: '1',
  HF_BUCKET_ID: 'ktongue/ENISE-SITE',
  CACHE_DIR: '/tmp/enise-docs-cache',
};

/** Clés recopiées depuis .dev.vars (ou l’environnement) si elles sont remplies. */
export const FORWARDED_KEYS = [
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_AI_TOKEN',
  'CLOUDFLARE_MODEL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL',
  'NVIDIA_API_KEY',
  'NVIDIA_MODEL',
  'OPENCODE_API_KEY',
  'OPENCODE_MODEL',
  'CHAT_ANSWER_TIMEOUT',
  'CHAT_MAX_TOKENS',
  'CHAT_DEEP_MAX_TOKENS',
  'APPWRITE_ENDPOINT',
  'APPWRITE_PROJECT_ID',
  'APPWRITE_DATABASE_ID',
  'APPWRITE_PUBLIC_ORIGIN',
  'APPWRITE_FLAVOR',
];

const REQUIRED_APIS = ['run.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com'];

export function parseCloudRunArgs(argv = process.argv.slice(2)) {
  const options = {
    project: null,
    region: DEFAULTS.region,
    service: DEFAULTS.service,
    writeOrigin: true,
    withHfToken: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    const value = () => {
      if (inline !== null) return inline;
      i += 1;
      if (i >= argv.length) throw new Error(`Valeur manquante après ${flag}`);
      return argv[i];
    };
    switch (flag) {
      case '--project':
        options.project = value();
        break;
      case '--region':
        options.region = value();
        break;
      case '--service':
        options.service = value();
        break;
      case '--no-origin':
        options.writeOrigin = false;
        break;
      case '--with-hf-token':
        options.withHfToken = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Option inconnue : ${arg}`);
    }
  }
  return options;
}

/** Lit un fichier KEY="valeur" (format .dev.vars) sans toucher process.env. */
export function parseDevVars(raw) {
  const values = {};
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/** Valeurs d’exemple de .dev.vars.example : ne jamais les envoyer. */
export function isPlaceholder(value) {
  const text = String(value || '').trim();
  return !text || /^(your|votre)[-_]/i.test(text) || text.includes('...') || /your-key|your_key/i.test(text);
}

/** Projet : option, variable d’environnement, puis .firebaserc. */
export function resolveProject(option, env = process.env, root = ROOT) {
  if (option) return option;
  if (env.GOOGLE_CLOUD_PROJECT) return env.GOOGLE_CLOUD_PROJECT;
  if (env.FIREBASE_PROJECT) return env.FIREBASE_PROJECT;
  const rc = join(root, '.firebaserc');
  if (existsSync(rc)) {
    try {
      const parsed = JSON.parse(readFileSync(rc, 'utf8'));
      if (parsed?.projects?.default) return parsed.projects.default;
    } catch {
      throw new Error('.firebaserc illisible (JSON invalide).');
    }
  }
  return null;
}

/**
 * Variables du service Cloud Run : fixes + clés remplies. Les valeurs des
 * fichiers passent avant celles de l’environnement du terminal.
 */
export function buildServiceEnv(fileValues, env = process.env, { withHfToken = false } = {}) {
  const out = { ...FIXED_ENV };
  const keys = withHfToken ? [...FORWARDED_KEYS, 'HF_TOKEN'] : FORWARDED_KEYS;
  for (const key of keys) {
    const value = fileValues[key] ?? env[key];
    if (!isPlaceholder(value)) out[key] = String(value).trim();
  }
  return out;
}

/** Fichier --env-vars-file : chaînes JSON, valides en YAML, sans échappement à la main. */
export function envFileContent(values) {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}: ${JSON.stringify(String(value))}`)
    .join('\n')}\n`;
}

export function hasEngine(values) {
  return Boolean(
    (values.CLOUDFLARE_ACCOUNT_ID && (values.CLOUDFLARE_API_TOKEN || values.CLOUDFLARE_AI_TOKEN)) ||
      values.OPENROUTER_API_KEY ||
      values.NVIDIA_API_KEY ||
      values.OPENCODE_API_KEY,
  );
}

export function deployArgs({ service, region, project }, envFile, sourceDir) {
  return [
    'run',
    'deploy',
    service,
    '--source',
    sourceDir,
    '--region',
    region,
    '--project',
    project,
    '--allow-unauthenticated',
    '--port',
    '8080',
    // Une réponse de l’assistant peut durer jusqu’à 150 s.
    '--timeout',
    '300',
    '--memory',
    '512Mi',
    '--cpu',
    '1',
    '--min-instances',
    '0',
    '--max-instances',
    '3',
    '--concurrency',
    '40',
    '--env-vars-file',
    envFile,
    '--quiet',
  ];
}

function gcloud(args, { capture = false } = {}) {
  const windows = process.platform === 'win32';
  // Avec le shell Windows, un chemin contenant des espaces doit être cité.
  const argv = windows ? args.map((arg) => (/[\s&()^]/.test(arg) ? `"${arg}"` : arg)) : args;
  const result = spawnSync('gcloud', argv, {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    // Sous Windows, gcloud est un gcloud.cmd : il faut passer par le shell.
    shell: windows,
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error('gcloud introuvable. Installer le Google Cloud SDK : https://cloud.google.com/sdk/docs/install puis `gcloud auth login`.');
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`gcloud ${args.slice(0, 2).join(' ')} a échoué (code ${result.status}).`);
  }
  return capture ? String(result.stdout || '').trim() : '';
}

function usage() {
  console.log(`Usage : npm run deploy:api:firebase -- --project <id> [options]

  --project <id>     projet Firebase (sinon GOOGLE_CLOUD_PROJECT ou .firebaserc)
  --region <région>  défaut ${DEFAULTS.region}
  --service <nom>    défaut ${DEFAULTS.service}
  --no-origin        ne pas écrire GO_API_ORIGIN dans wrangler.jsonc
  --with-hf-token    transmettre HF_TOKEN (seulement si le bucket est privé)
  --dry-run          afficher la commande sans rien déployer`);
}

async function main() {
  const options = parseCloudRunArgs();
  if (options.help) {
    usage();
    return;
  }
  const project = resolveProject(options.project);
  if (!project) {
    usage();
    throw new Error('Projet Firebase manquant : --project <id> (visible dans la console Firebase → Paramètres du projet).');
  }

  const devVarsPath = join(ROOT, '.dev.vars');
  const fileValues = existsSync(devVarsPath) ? parseDevVars(readFileSync(devVarsPath, 'utf8')) : {};
  const serviceEnv = buildServiceEnv(fileValues, process.env, { withHfToken: options.withHfToken });
  const forwarded = Object.keys(serviceEnv).filter((key) => !(key in FIXED_ENV));

  console.log('🔥 Déploiement de l’API Go ENISE Docs sur Cloud Run (Firebase)\n');
  console.log(`   projet  : ${project}`);
  console.log(`   région  : ${options.region}`);
  console.log(`   service : ${options.service}`);
  console.log(`   clés    : ${forwarded.length ? forwarded.join(', ') : 'aucune'}`);
  if (!hasEngine(serviceEnv)) {
    console.log('\n⚠️  Aucun moteur de rédaction dans .dev.vars : l’assistant ne proposera que des documents.');
    console.log('   Renseigner CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (ou une autre clé), puis relancer.');
  }

  const workdir = mkdtempSync(join(tmpdir(), 'enise-cloudrun-'));
  const envFile = join(workdir, 'env.yaml');
  writeFileSync(envFile, envFileContent(serviceEnv), { mode: 0o600 });
  const args = deployArgs({ ...options, project }, envFile, join(ROOT, 'backend'));

  try {
    if (options.dryRun) {
      console.log(`\n🧪 Simulation :\n   gcloud ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`);
      return;
    }
    console.log('\n🔌 Activation des API Cloud Run, Cloud Build et Artifact Registry…');
    gcloud(['services', 'enable', ...REQUIRED_APIS, '--project', project]);

    console.log('\n🚀 Construction et déploiement (3 à 5 minutes la première fois)…');
    gcloud(args);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }

  const url = normalizeOrigin(
    gcloud(
      ['run', 'services', 'describe', options.service, '--region', options.region, '--project', project, '--format', 'value(status.url)'],
      { capture: true },
    ),
  );
  console.log(`\n🔎 Vérification de ${url}/api/health…`);
  await checkHealth(url, { attempts: 4, delayMs: 5000, timeoutMs: 30000 });
  console.log('   ✅ API joignable');

  if (options.writeOrigin) {
    writeOrigin(ROOT, url);
    console.log(`\n📍 GO_API_ORIGIN écrit dans wrangler.jsonc : ${url}`);
  }
  console.log('\n✅ API déployée. Étape suivante : npm run deploy (redéploie le Worker).');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\n❌ ${error.message}`);
    // L’activation des API est la première étape qui exige la facturation.
    if (/services enable|run deploy/.test(error.message)) {
      console.error('   Vérifier que le projet est au plan Blaze (console Firebase → Mettre à niveau)');
      console.error('   et que gcloud est connecté au bon compte : gcloud auth login');
    }
    process.exit(1);
  });
}
