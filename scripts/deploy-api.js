#!/usr/bin/env node
/**
 * Déploie l’API Go comme Space Docker Hugging Face.
 *
 * Le Worker Cloudflare continue de servir le site : il appelle simplement
 * l’API sur l’URL du Space (GO_API_ORIGIN). Aucun serveur à louer.
 *
 * Utilisation :
 *   HF_TOKEN=... npm run deploy:api
 *   HF_TOKEN=... npm run deploy:api -- --space-id <user>/<space> --private
 *
 * Le Space est créé s’il n’existe pas, puis les sources sont poussées dans un
 * commit atomique unique (format NDJSON du Hub).
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { HF_API, createSpace, spaceExists, waitForDeployment } from './deploy-space.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const API_SPACE_NAME = 'enise-docs-api';
const API_PORT = 8788;
const GO_EXTENSIONS = ['.go', '.mod', '.sum'];
// « enise-api » est le binaire compilé : il n’a pas d’extension .go, le
// filtre par extension suffit à l’écarter (et le dossier cmd/enise-api doit
// rester traversé).
const EXCLUDED_DIRS = new Set(['.git', '.cache', 'bin', 'dist', 'node_modules']);

/**
 * Arguments de la ligne de commande.
 */
export function parseApiArgs(argv = process.argv.slice(2)) {
  const options = { spaceId: null, private: false, skipFiles: false, writeOrigin: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--space-id' && argv[i + 1]) {
      options.spaceId = argv[++i];
    } else if (argv[i] === '--private') {
      options.private = true;
    } else if (argv[i] === '--skip-files') {
      options.skipFiles = true;
    } else if (argv[i] === '--write-origin') {
      options.writeOrigin = true;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(`
Usage: node deploy-api.js [options]

Options:
  --space-id <id>     Space ID (défaut: <username>/${API_SPACE_NAME})
  --private           Créer un Space privé
  --skip-files        Ne pas uploader les fichiers
  --write-origin      Écrire GO_API_ORIGIN dans wrangler.jsonc
  --help, -h          Afficher cette aide

Variables d'environnement:
  HF_TOKEN            Token Hugging Face (requis, droits "write")
`);
      options.help = true;
      return options;
    }
  }
  return options;
}

/**
 * Rassemble les fichiers à pousser : l’enveloppe Docker (space-api/) puis
 * les sources Go (backend/), sans les tests ni les binaires.
 */
export function collectApiFiles(root) {
  const files = [];
  const spaceDir = join(root, 'space-api');
  for (const name of ['Dockerfile', 'README.md']) {
    const source = join(spaceDir, name);
    if (!existsSync(source)) {
      throw new Error(`Fichier source manquant: ${source}`);
    }
    files.push({ path: name, source });
  }

  const backendDir = join(root, 'backend');
  if (!existsSync(backendDir)) {
    throw new Error(`Dossier backend/ introuvable: ${backendDir}`);
  }
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const source = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(source);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('_test.go')) continue;
      if (!GO_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
      files.push({ path: relative(backendDir, source).split(sep).join('/'), source });
    }
  };
  walk(backendDir);
  return files;
}

/**
 * Pousse tous les fichiers en un seul commit atomique.
 */
export async function uploadApiFiles(spaceId, files) {
  const lines = [
    { key: 'header', value: { summary: 'Deploy ENISE Docs API (Go)', description: '' } },
    ...files.map((file) => ({
      key: 'file',
      value: {
        content: readFileSync(file.source).toString('base64'),
        path: file.path,
        encoding: 'base64',
      },
    })),
  ];
  const body = lines.map((line) => JSON.stringify(line)).join('\n');

  let response;
  try {
    response = await fetch(`${HF_API}/spaces/${spaceId}/commit/main`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
        'Content-Type': 'application/x-ndjson',
      },
      body,
    });
  } catch {
    throw new Error('Connexion à Hugging Face impossible pendant l’upload.');
  }
  if (!response.ok) {
    throw new Error(`Erreur upload: ${response.status} - ${await response.text()}`);
  }
  return files.length;
}

/**
 * Écrit l’URL de l’API dans wrangler.jsonc pour que le Worker l’appelle.
 */
export function writeOrigin(root, origin) {
  const file = join(root, 'wrangler.jsonc');
  if (!existsSync(file)) {
    throw new Error(`Configuration absente: ${file}`);
  }
  const content = readFileSync(file, 'utf8');
  const updated = content.replace(/("GO_API_ORIGIN"\s*:\s*)"[^"]*"/, `$1"${origin}"`);
  if (updated === content) {
    throw new Error('GO_API_ORIGIN introuvable dans wrangler.jsonc');
  }
  writeFileSync(file, updated);
  return origin;
}

/** URL publique d’exécution du Space. */
export function apiSpaceUrl(spaceId) {
  return `https://${spaceId.replace('/', '-').toLowerCase()}.hf.space`;
}

/**
 * Récupère le username depuis l’API Hugging Face.
 */
export async function getUsername() {
  let response;
  try {
    response = await fetch(`${HF_API}/whoami-v2`, {
      headers: { Authorization: `Bearer ${process.env.HF_TOKEN}` },
    });
  } catch {
    throw new Error('Connexion à Hugging Face impossible.');
  }
  if (response.status === 401) throw new Error('Token HF_TOKEN invalide.');
  if (!response.ok) throw new Error('Impossible de récupérer les informations utilisateur');
  const data = await response.json();
  return data.name;
}

async function main() {
  const options = parseApiArgs();
  if (options.help) return;

  console.log('🔧 Déploiement de l’API Go ENISE Docs sur Hugging Face\n');
  if (!process.env.HF_TOKEN) {
    console.error('❌ Variable HF_TOKEN manquante');
    console.error('   Usage: HF_TOKEN=your_token npm run deploy:api');
    process.exit(1);
  }

  const root = join(__dirname, '..');
  let files;
  try {
    files = collectApiFiles(root);
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }

  try {
    console.log('📋 Récupération des informations utilisateur...');
    const username = await getUsername();
    const spaceId = options.spaceId || `${username}/${API_SPACE_NAME}`;
    console.log(`🎯 Space ID cible: ${spaceId}`);
    console.log(`   ${files.length} fichiers à pousser`);

    if (await spaceExists(spaceId)) {
      console.log(`⚠️  Le Space ${spaceId} existe déjà — mise à jour des fichiers.`);
    } else {
      await createSpace(spaceId, username, options.private);
    }

    if (!options.skipFiles) {
      console.log('\n📁 Upload des sources');
      const count = await uploadApiFiles(spaceId, files);
      console.log(`✅ Commit poussé (${count} fichiers)`);
    }

    console.log('\n🔄 Le build Docker prend quelques minutes...');
    const origin = apiSpaceUrl(spaceId);
    const deployed = await waitForDeployment(spaceId);

    if (deployed) {
      console.log('\n✅ API déployée et opérationnelle!');
      if (options.writeOrigin) {
        writeOrigin(root, origin);
        console.log(`\n📍 GO_API_ORIGIN écrit dans wrangler.jsonc : ${origin}`);
        console.log('   Il reste à déployer le Worker : npm run deploy');
      } else {
        console.log(`\n📍 À reporter dans wrangler.jsonc :`);
        console.log(`   "GO_API_ORIGIN": "${origin}"`);
        console.log(`\n   puis : npm run deploy`);
      }
      console.log(`\n💡 Secrets à ajouter dans le Space (Settings → Repository secrets) :`);
      console.log(`   OPENROUTER_API_KEY, NVIDIA_API_KEY, OPENCODE_API_KEY, CHAT_TRUST_PROXY=1`);
      console.log(`\n⚠️  Le gratuit se met en veille après inactivité : la première question`);
      console.log(`   après une pause peut attendre 30 à 60 secondes (port ${API_PORT}).`);
    } else {
      console.log(`\n⚠️  Déploiement en cours ou échoué — logs :`);
      console.log(`   https://huggingface.co/spaces/${spaceId}/logs`);
    }
  } catch (error) {
    console.error(`\n❌ ERREUR CRITIQUE: ${error.message}`);
    if (/\b402\b|PRO subscription/i.test(error.message)) {
      console.error('\n💡 Hugging Face réserve les Spaces Docker aux comptes PRO.');
      console.error('   Alternative gratuite : Render (render.yaml), puis');
      console.error('   npm run api:origin -- https://enise-docs-api.onrender.com && npm run deploy');
    }
    process.exit(1);
  }
}

const invokedAsScript = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().catch(console.error);
}
