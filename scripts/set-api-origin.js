#!/usr/bin/env node
/**
 * Relie le Worker à l’API Go hébergée ailleurs (Render, VPS…).
 *
 *   npm run api:origin -- https://enise-docs-api.onrender.com
 *
 * Vérifie que l’URL répond sur /api/health (en attendant la sortie de veille
 * du palier gratuit), puis écrit GO_API_ORIGIN dans wrangler.jsonc. Il reste
 * à lancer `npm run deploy`.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrigin } from './deploy-api.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Normalise l’origine : HTTPS obligatoire, sans chemin ni barre finale. */
export function normalizeOrigin(raw) {
  const value = String(raw || '').trim();
  if (!value) {
    throw new Error('URL manquante. Exemple : npm run api:origin -- https://enise-docs-api.onrender.com');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`URL invalide : ${value}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error('L’API doit être servie en HTTPS (le Worker refuse le HTTP simple).');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Donne seulement l’origine, sans chemin : https://enise-docs-api.onrender.com');
  }
  return url.origin;
}

/**
 * Interroge /api/health. Le palier gratuit de Render dort après 15 minutes :
 * le premier appel peut attendre une minute, d’où les tentatives répétées.
 */
export async function checkHealth(origin, { attempts = 6, delayMs = 15000, timeoutMs = 60000 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) {
        return await response.json().catch(() => ({}));
      }
      lastError = new Error(`/api/health a répondu ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      console.log(`   ⏳ pas encore prêt (${lastError.message}), nouvelle tentative…`);
      await new Promise((wake) => setTimeout(wake, delayMs));
    }
  }
  throw new Error(`L’API ne répond pas sur ${origin}/api/health : ${lastError?.message || 'erreur inconnue'}`);
}

async function main(argv) {
  const skipCheck = argv.includes('--no-check');
  const origin = normalizeOrigin(argv.find((arg) => !arg.startsWith('--')));
  if (!skipCheck) {
    console.log(`🔎 Vérification de ${origin}/api/health…`);
    await checkHealth(origin);
    console.log('   ✅ API joignable');
  }
  writeOrigin(root, origin);
  console.log(`📍 GO_API_ORIGIN écrit dans wrangler.jsonc : ${origin}`);
  console.log('   Étape suivante : npm run deploy');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  });
}
