#!/usr/bin/env node
/**
 * Comptage de référence des fichiers d’un bucket Hugging Face.
 *
 * Le script parcourt réellement l’API publique du bucket et recalcule
 * l’effectif de chaque dossier, indépendamment du site et de ses caches.
 * C’est l’outil de diagnostic lorsque l’interface affiche « 0 ressource »
 * pour tous les dossiers : dans ce cas, le document d’index servi par le
 * Worker date généralement de la création du bucket (comptage effectué
 * alors qu’aucun fichier n’était visible) et reste servi depuis le cache.
 *
 * Le script est volontairement autonome : aucune dépendance npm et aucune
 * importation du code de l’application, afin de rester une référence fiable
 * même si la logique du site ou du Worker venait à changer.
 *
 * Exemples :
 *   node scripts/count-bucket-files.mjs
 *   node scripts/count-bucket-files.mjs --prefix "GM/3A GM"
 *   node scripts/count-bucket-files.mjs --json index-reel.json
 *   node scripts/count-bucket-files.mjs --compare https://enise-docs.workers.dev
 *   node scripts/count-bucket-files.mjs --fixture echantillon.json
 */

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HF_ORIGIN = 'https://huggingface.co';
const DEFAULT_BUCKET_ID = 'ktongue/ENISE-SITE';
const PAGE_SIZE = 1000; // limite maximale acceptée par l’API tree
const MAX_PAGES = 250; // garde-fou : 250 × 1000 = 250 000 entrées
const MAX_ITEMS = 250_000;
const MAX_REPORT_MISMATCHES = 20;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = 'enise-docs-count-script/1.0';
const BUCKET_ID_PATTERN = /^[\w.-]+\/[\w.-]+$/u;

const CLI_OPTIONS = {
  bucket: { type: 'string' },
  prefix: { type: 'string', default: '' },
  json: { type: 'string' },
  compare: { type: 'string' },
  fixture: { type: 'string' },
  token: { type: 'string' },
  depth: { type: 'string' },
  quiet: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

/** Construit l’URL de listage récursif (mêmes conventions que le Worker). */
export function buildTreeUrl(bucketId, prefix = '') {
  const encodedBucket = bucketId.split('/').map(encodeURIComponent).join('/');
  const normalizedPrefix = normalizePrefix(prefix);
  const encodedPrefix = normalizedPrefix
    ? `/${normalizedPrefix.split('/').map(encodeURIComponent).join('/')}`
    : '';
  const url = new URL(`${HF_ORIGIN}/api/buckets/${encodedBucket}/tree${encodedPrefix}`);
  url.searchParams.set('recursive', 'true');
  url.searchParams.set('limit', String(PAGE_SIZE));
  return url.toString();
}

/** URL des métadonnées publiques du bucket (totalFiles, size officiels). */
export function buildBucketUrl(bucketId) {
  const encodedBucket = bucketId.split('/').map(encodeURIComponent).join('/');
  return `${HF_ORIGIN}/api/buckets/${encodedBucket}`;
}

/** Suit la pagination par en-tête Link (rel="next"), comme le Worker. */
export function parseNextLink(linkHeader, currentUrl) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel=(?:"next"|next)/i);
    if (match) return new URL(match[1], currentUrl).toString();
  }
  return null;
}

/** Valide/normalise le préfixe demandé, comme normalizePrefix côté Worker. */
export function normalizePrefix(value = '') {
  const prefix = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (prefix.split('/').some((segment) => segment === '..')) {
    throw new Error(`Préfixe invalide : « ${value} ».`);
  }
  return prefix;
}

/**
 * Compte les fichiers de chaque dossier à partir d’un listage récursif.
 *
 * Réécriture indépendante (mais équivalente) de countFilesByDirectory
 * (src/utils/files.js / worker/index.js) : les dossiers sont ignorés, chaque
 * fichier incrémente tous ses dossiers parents.
 */
export function countFilesInListing(items = []) {
  const counts = {};
  const sizes = {};
  let totalFiles = 0;
  let totalBytes = 0;
  let filesAtRoot = 0;
  let directoriesSeen = 0;

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const path = String(item.path || '').replace(/^\/+|\/+$/g, '');
    if (!path) continue;

    if (item.type === 'directory') {
      directoriesSeen += 1;
      continue;
    }

    const rawSize = Number(item.size);
    const bytes = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 0;
    totalFiles += 1;
    totalBytes += bytes;

    const parts = path.split('/').filter(Boolean);
    if (parts.length < 2) filesAtRoot += 1;
    for (let index = 1; index < parts.length; index += 1) {
      const directoryPath = parts.slice(0, index).join('/');
      counts[directoryPath] = (counts[directoryPath] || 0) + 1;
      sizes[directoryPath] = (sizes[directoryPath] || 0) + bytes;
    }
  }

  return { counts, sizes, totalFiles, totalBytes, filesAtRoot, directoriesSeen };
}

/** Document compact, même forme que la réponse du Worker (/api/index). */
export function buildIndexDocument({ bucketId, prefix, items, complete }) {
  const analysis = countFilesInListing(items);
  const generatedAt = new Date().toISOString();
  return {
    bucketId,
    prefix,
    generatedAt,
    fetchedAt: generatedAt,
    generatedBy: 'scripts/count-bucket-files.mjs',
    complete,
    totalFiles: analysis.totalFiles,
    totalBytes: analysis.totalBytes,
    counts: analysis.counts,
    sizes: analysis.sizes,
    items: (Array.isArray(items) ? items : []).map(compactItem).filter(Boolean),
  };
}

function compactItem(item) {
  if (!item || typeof item !== 'object') return null;
  const path = String(item.path || '').replace(/^\/+|\/+$/g, '');
  if (!path) return null;
  const compact = { type: item.type === 'directory' ? 'directory' : 'file', path };
  if (Number.isFinite(Number(item.size))) compact.size = Number(item.size);
  if (item.mtime || item.uploadedAt || item.uploaded_at) {
    compact.mtime = item.mtime || item.uploadedAt || item.uploaded_at;
  }
  return compact;
}

/**
 * Compare le comptage réel (référence) avec un document d’index (candidat),
 * typiquement la réponse /api/index du site. Repère en priorité les dossiers
 * « affichés à 0 » alors qu’ils contiennent des fichiers.
 */
export function diffWithIndexDocument(analysis, document) {
  const candidateCounts =
    document && typeof document === 'object' && typeof document.counts === 'object'
      ? document.counts
      : {};
  const reference = analysis.counts;

  const zeroOnSite = [];
  const mismatches = [];
  const missingOnSite = [];
  const extraOnSite = [];

  for (const [path, expected] of Object.entries(reference)) {
    const raw = candidateCounts[path];
    if (raw === undefined || raw === null) {
      const entry = { path, expected, actual: null };
      missingOnSite.push(entry);
      if (expected > 0) zeroOnSite.push(entry);
      continue;
    }
    const actual = Number(raw);
    if (!Number.isFinite(actual) || actual !== expected) {
      const entry = { path, expected, actual: Number.isFinite(actual) ? actual : null };
      mismatches.push(entry);
      if (expected > 0 && (!Number.isFinite(actual) || actual <= 0)) zeroOnSite.push(entry);
    }
  }

  for (const path of Object.keys(candidateCounts)) {
    if (!(path in reference)) {
      extraOnSite.push({ path, expected: 0, actual: Number(candidateCounts[path]) });
    }
  }

  const candidateTotal = Number(document?.totalFiles);

  return {
    zeroOnSite,
    mismatches,
    missingOnSite,
    extraOnSite,
    totalExpected: analysis.totalFiles,
    totalOnSite: Number.isFinite(candidateTotal) ? candidateTotal : null,
    get coherent() {
      return (
        this.zeroOnSite.length === 0 &&
        this.mismatches.length === 0 &&
        this.extraOnSite.length === 0 &&
        (this.totalOnSite === null || this.totalOnSite === this.totalExpected)
      );
    },
  };
}

/* ------------------------------ Présentation ------------------------------ */

// Copies volontaires de src/utils/files.js (indépendance du script).
function formatCount(value) {
  return new Intl.NumberFormat('fr-FR').format(Number(value) || 0);
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** exponent;
  return `${new Intl.NumberFormat('fr-FR', {
    maximumFractionDigits: amount >= 10 || exponent === 0 ? 0 : 1,
  }).format(amount)} ${units[exponent]}`;
}

/** Rapport en forme d’arborescence : effectif et taille par dossier. */
export function renderReport(analysis, { depth = Number.POSITIVE_INFINITY } = {}) {
  const lines = [];
  lines.push(
    `(racine) : ${formatCount(analysis.totalFiles)} fichier(s) · ${formatBytes(analysis.totalBytes)}` +
      (analysis.filesAtRoot > 0 ? ` — dont ${formatCount(analysis.filesAtRoot)} à la racine` : ''),
  );

  const directories = Object.keys(analysis.counts).sort((a, b) => {
    const segmentsA = a.split('/');
    const segmentsB = b.split('/');
    const commonLength = Math.min(segmentsA.length, segmentsB.length);
    for (let index = 0; index < commonLength; index += 1) {
      if (segmentsA[index] !== segmentsB[index]) {
        return segmentsA[index].localeCompare(segmentsB[index], 'fr', { numeric: true });
      }
    }
    return segmentsA.length - segmentsB.length;
  });

  for (const directory of directories) {
    const level = directory.split('/').length;
    if (level > depth) continue;
    const label = directory.split('/').pop();
    lines.push(
      `${'  '.repeat(level)}${label} : ${formatCount(analysis.counts[directory])} fichier(s) · ${formatBytes(analysis.sizes[directory])}`,
    );
  }

  return lines.join('\n');
}

/** Rendu texte de la comparaison entre le bucket réel et l’index du site. */
export function renderComparison(diff, source) {
  const lines = [];
  lines.push(
    `Comparaison avec « ${source} » — total réel : ${formatCount(diff.totalExpected)} · ` +
      `total dans le document : ${diff.totalOnSite === null ? 'inconnu' : formatCount(diff.totalOnSite)}`,
  );

  if (diff.coherent) {
    lines.push('OK : les effectifs du document correspondent au contenu réel du bucket.');
    return lines.join('\n');
  }

  if (diff.zeroOnSite.length > 0) {
    lines.push(
      `⚠ ${formatCount(diff.zeroOnSite.length)} dossier(s) affiché(s) « 0 » (ou absent du document) ` +
        'alors que le bucket contient des fichiers :',
    );
    for (const entry of diff.zeroOnSite.slice(0, MAX_REPORT_MISMATCHES)) {
      lines.push(
        `  - ${entry.path} : réel ${formatCount(entry.expected)} · document ${entry.actual === null ? 'absent' : formatCount(entry.actual)}`,
      );
    }
    if (diff.zeroOnSite.length > MAX_REPORT_MISMATCHES) {
      lines.push(`  … et ${formatCount(diff.zeroOnSite.length - MAX_REPORT_MISMATCHES)} autres.`);
    }
  }

  if (diff.mismatches.length > 0) {
    lines.push(`⚠ ${formatCount(diff.mismatches.length)} dossier(s) avec un effectif différent :`);
    for (const entry of diff.mismatches.slice(0, MAX_REPORT_MISMATCHES)) {
      lines.push(
        `  - ${entry.path} : réel ${formatCount(entry.expected)} · document ${entry.actual === null ? 'illisible' : formatCount(entry.actual)}`,
      );
    }
  }

  if (diff.extraOnSite.length > 0) {
    lines.push(
      `ℹ ${formatCount(diff.extraOnSite.length)} dossier(s) présent(s) dans le document mais absents du bucket (données obsolètes).`,
    );
  }

  lines.push(
    'Cause typique : document d’index calculé pendant la création du bucket puis servi depuis le cache. ' +
      'Purger le cache Cloudflare (Purge Everything ou les URL /api/index et /api/counts), ' +
      'ou attendre l’expiration du TTL (12 h Cache API, 24 h avec Workers KV).',
  );
  return lines.join('\n');
}

function usage() {
  return `Comptage de référence des fichiers du bucket Hugging Face.

Usage : node scripts/count-bucket-files.mjs [options]

Options :
  --bucket <org/nom>       Bucket à inspecter (défaut : HF_BUCKET_ID, sinon ${DEFAULT_BUCKET_ID})
  --prefix <chemin>        Limiter le parcours à un sous-dossier (ex. "GM/3A GM")
  --json <fichier>         Écrire un document d'index recalculé (forme /api/index)
  --compare <url|fichier>  Comparer avec l'index du site (URL du site ou de /api/index,
                           ou fichier JSON local) ; code de sortie 2 en cas d'écart
  --fixture <fichier>      Lire un listing JSON local au lieu d'appeler Hugging Face
  --depth <n>              Profondeur maximale du rapport (défaut : illimitée)
  --token <hf_...>         Token HF (défaut : HF_TOKEN) si le bucket devient privé
  --quiet                  N'afficher que les totaux et diagnostics
  --help, -h               Cette aide

Codes de sortie : 0 = OK · 1 = erreur (réseau, arguments, bucket inaccessible) · 2 = écart avec --compare.`;
}

/* -------------------------------- Réseau ---------------------------------- */

async function fetchJson(url, token) {
  const headers = new Headers({
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function describeHttpError(response) {
  if (response.status === 401 || response.status === 403) {
    return 'accès refusé par Hugging Face (bucket privé ? fournir un token avec --token ou HF_TOKEN)';
  }
  if (response.status === 404) return 'bucket ou dossier introuvable sur Hugging Face';
  return `Hugging Face a répondu avec le statut ${response.status}`;
}

/** Totaux officiels déclarés par l’API (1 requête, sans parcours). */
export async function fetchBucketStats({ bucketId, token }) {
  try {
    const response = await fetchJson(buildBucketUrl(bucketId), token);
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || typeof data !== 'object') return null;
    const totalFiles = Number(data.totalFiles);
    const size = Number(data.size);
    return {
      totalFiles: Number.isFinite(totalFiles) ? totalFiles : null,
      size: Number.isFinite(size) ? size : null,
    };
  } catch {
    return null;
  }
}

/** Parcours récursif paginé du bucket (identique au premier /api/index du Worker). */
export async function listBucketFiles({ bucketId, prefix = '', token = '', quiet = false }) {
  const items = [];
  let nextUrl = buildTreeUrl(bucketId, prefix);
  let pageCount = 0;
  let complete = true;

  while (nextUrl && pageCount < MAX_PAGES && items.length < MAX_ITEMS) {
    let response;
    try {
      response = await fetchJson(nextUrl, token);
    } catch {
      throw new Error('connexion au stockage Hugging Face impossible (réseau ou résolution DNS)');
    }
    if (!response.ok) throw new Error(await describeHttpError(response));

    const data = await response.json().catch(() => null);
    const pageItems = Array.isArray(data) ? data : data?.items;
    if (!Array.isArray(pageItems)) {
      throw new Error('réponse inattendue de l’API Hugging Face (listing non-tabulaire)');
    }
    items.push(...pageItems);
    pageCount += 1;
    if (!quiet) console.error(`  … page ${pageCount} (${formatCount(items.length)} entrées lues)`);

    nextUrl = parseNextLink(response.headers.get('Link'), nextUrl);
  }

  if (nextUrl || items.length > MAX_ITEMS) complete = false;
  return { items: items.slice(0, MAX_ITEMS), complete, pages: pageCount };
}

async function loadIndexCandidate(source, token) {
  if (/^https?:\/\//i.test(source)) {
    const url = source.includes('/api/index') ? source : `${source.replace(/\/+$/, '')}/api/index`;
    let response;
    try {
      response = await fetchJson(url, token);
    } catch {
      throw new Error(`impossible de joindre ${url}`);
    }
    if (!response.ok) {
      throw new Error(`${url} a répondu avec le statut ${response.status}`);
    }
    return { document: await response.json(), label: url };
  }
  const raw = await readFile(source, 'utf8').catch(() => {
    throw new Error(`fichier introuvable : ${source}`);
  });
  return { document: JSON.parse(raw), label: source };
}

/* --------------------------------- Main ----------------------------------- */

function parseCliOptions(argv) {
  let options;
  try {
    options = parseArgs({ args: argv, options: CLI_OPTIONS, allowPositionals: false }).values;
  } catch (error) {
    throw new Error(`${error.message}\n\n${usage()}`);
  }
  return options;
}

async function main(argv) {
  const options = parseCliOptions(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const bucketId = String(options.bucket || process.env.HF_BUCKET_ID || DEFAULT_BUCKET_ID).trim();
  if (!BUCKET_ID_PATTERN.test(bucketId)) {
    throw new Error(`Identifiant de bucket invalide : « ${bucketId} » (format attendu : org/nom).`);
  }
  const prefix = normalizePrefix(options.prefix);
  const token = options.token || process.env.HF_TOKEN || '';
  const depth =
    options.depth === undefined
      ? Number.POSITIVE_INFINITY
      : Number.parseInt(options.depth, 10);
  if (!(depth > 0) && depth !== Number.POSITIVE_INFINITY) {
    throw new Error(`Profondeur invalide : « ${options.depth} ».`);
  }

  console.error(`Bucket inspecté : ${bucketId}${prefix ? ` — préfixe « ${prefix} »` : ''}`);

  let listing;
  let stats = null;

  if (options.fixture) {
    const raw = await readFile(options.fixture, 'utf8').catch(() => {
      throw new Error(`fixture introuvable : ${options.fixture}`);
    });
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(items)) {
      throw new Error('fixture illisible : tableau JSON attendu (ou objet avec une clé « items »).');
    }
    listing = { items, complete: true, pages: 0 };
    console.error(`Fixture « ${options.fixture} » : ${formatCount(items.length)} entrées.`);
  } else {
    stats = await fetchBucketStats({ bucketId, token });
    if (stats && stats.totalFiles !== null) {
      console.error(
        `Déclaration officielle de l’API : ${formatCount(stats.totalFiles)} fichier(s) · ${formatBytes(stats.size)} (métadonnées du bucket).`,
      );
    }
    if (!options.quiet) console.error('Parcours récursif du bucket…');
    listing = await listBucketFiles({ bucketId, prefix, token, quiet: options.quiet });
  }

  const analysis = countFilesInListing(listing.items);
  const warnings = [];

  if (analysis.totalFiles === 0) {
    warnings.push(
      'le parcours ne retourne aucun fichier : bucket vide, préfixe inexistant, ou droits insuffisants.',
    );
  }
  if (!listing.complete) {
    warnings.push(
      `listing tronqué (garde-fous atteints : ${MAX_PAGES} pages / ${formatCount(MAX_ITEMS)} entrées) — les compteurs sont minorés.`,
    );
  }
  if (stats && stats.totalFiles !== null && stats.totalFiles !== analysis.totalFiles) {
    warnings.push(
      `l’API annonce ${formatCount(stats.totalFiles)} fichier(s) mais le listage n’en retourne que ${formatCount(analysis.totalFiles)}.`,
    );
  }

  if (!options.quiet) {
    console.log(renderReport(analysis, { depth }));
    console.log('');
  }
  console.log(
    `Total : ${formatCount(analysis.totalFiles)} fichier(s) · ${formatBytes(analysis.totalBytes)} · ` +
      `${formatCount(Object.keys(analysis.counts).length)} dossier(s) contenant des fichiers` +
      (listing.pages > 0 ? ` · ${formatCount(listing.pages)} page(s) d’API` : ''),
  );
  for (const warning of warnings) console.warn(`⚠ ${warning}`);

  if (options.json) {
    const document = buildIndexDocument({ bucketId, prefix, items: listing.items, complete: listing.complete });
    await writeFile(options.json, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    console.log(`Document d’index recalculé écrit dans ${options.json}.`);
  }

  if (options.compare) {
    const { document, label } = await loadIndexCandidate(options.compare, token);
    const diff = diffWithIndexDocument(analysis, document);
    console.log('');
    console.log(renderComparison(diff, label));
    return diff.coherent ? 0 : 2;
  }

  return 0;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(`Erreur : ${error.message}`);
      process.exitCode = 1;
    });
}
