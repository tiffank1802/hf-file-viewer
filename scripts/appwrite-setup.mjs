#!/usr/bin/env node
/**
 * Provisioning Appwrite pour ENISE Docs : base `enise_docs`, tables `profiles`
 * et `favorites`, colonnes, index et permissions.
 *
 * Le modèle et les chemins vivent dans `scripts/appwrite-spec.js` (testé dans
 * `tests/appwrite-provisioning-plan.test.js`) : --dry-run, --status, --drop et
 * le run réel consomment le même plan, donc ils ne peuvent plus diverger.
 *
 * Les commandes de lecture et de simulation ne modifient rien. Toute écriture
 * exige --apply et une cible explicite ; --new-table-only refuse de modifier
 * une table existante. Consulter docs/DEPLOY_PDF_UNIFIED.md avant utilisation.
 * --drop reste destructif et exige aussi une confirmation par identifiant.
 *
 * La clé serveur ne doit JAMAIS être commitée ni porter un préfixe VITE_.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksLikeAppwriteResponse, normalizeAppwriteEndpoint } from '../src/utils/appwriteEndpoint.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDevVars(ROOT);

const APPWRITE_API_BASE = normalizeAppwriteEndpoint(process.env.APPWRITE_ENDPOINT || process.env.VITE_APPWRITE_ENDPOINT || 'https://fra.cloud.appwrite.io/v1');
const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID || process.env.VITE_APPWRITE_PROJECT_ID || '69cedb12002acdd498e0';

function loadDevVars(root) {
  for (const name of ['.dev.vars', '.env', '.env.local']) {
    let raw = '';
    try { raw = readFileSync(path.join(root, name), 'utf8'); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] == null) process.env[key] = value;
    }
  }
}

import { SPECS, configuredTables, buildPlan, columnDrift, enumColumns, permissionsDrift, summarizeRows, withPendingRetry } from './appwrite-spec.js';

const ALL_TABLES = configuredTables(process.env);
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
const option = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const DRY_RUN = flags.has('--dry-run');
const APPLY = flags.has('--apply');
const ALL = flags.has('--all-tables');
const NEW_TABLE_ONLY = flags.has('--new-table-only');
const TARGET_TABLE = option('table', null);
const TABLES = TARGET_TABLE ? ALL_TABLES.filter((table) => table.id === TARGET_TABLE) : ALL_TABLES;
const DROP = flags.has('--drop');
const PING = flags.has('--ping');
const STATUS = flags.has('--status');
const FIX_ENUMS = flags.has('--fix-enums');
const INSPECT = flags.has('--inspect');
const DIAGNOSE = flags.has('--diagnose');
const HELP = flags.has('--help') || argv.includes('-h');
const VERBOSE = flags.has('--verbose');
const TIMEOUT_MS = Number(process.env.APPWRITE_TIMEOUT_MS || 30_000);
/**
 * Appwrite crée les colonnes et les index hors ligne : poser un index sur une
 * colonne d'instant répond 400 « The requested column 'x' is not yet available.
 * Please try again later. » — exactement ce qui a arrêté le run sur
 * `uniq_favorite_user_path`. Ce n'est pas une erreur de modèle, c'est une
 * attente : on la respecte au lieu d'abandonner la table à moitié indexée.
 */
const RETRY_ATTEMPTS = Number(process.env.APPWRITE_RETRY_ATTEMPTS || 10);
const RETRY_DELAY_MS = Number(process.env.APPWRITE_RETRY_DELAY_MS || 1200);

// L'endpoint public contient déjà /v1 : normaliser évite le /v1/v1 qui valait
// à ce script un 404 HTML d'Appwrite pris pour un blocage réseau.
const API_BASE = normalizeAppwriteEndpoint(process.env.APPWRITE_ENDPOINT || APPWRITE_API_BASE);
const PROJECT = process.env.APPWRITE_PROJECT_ID || APPWRITE_PROJECT_ID;
const API_KEY = process.env.APPWRITE_API_KEY || '';
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID || 'enise_docs';
const FLAVOR_REQUEST = option('flavor', process.env.APPWRITE_FLAVOR || 'auto').toLowerCase();
const SPECIFICATION = option('specification', process.env.APPWRITE_SPECIFICATION || 'auto');

/** `/v1/ping` répond exactement « Pong! » en text/plain — pas un JSON. */
const PING_BODY = /^Pong!$/;

class ApiError extends Error {
  constructor(message, details) {
    super(message);
    Object.assign(this, details);
  }
}

/** Les modes de diagnostic doivent interroger le réseau réel, même en dry-run. */
const NETWORK_PROBE = DIAGNOSE || STATUS || INSPECT || FIX_ENUMS;

const retryOptions = { attempts: RETRY_ATTEMPTS, delayMs: RETRY_DELAY_MS };

function validateOptions() {
  const allowedFlags = new Set([
    '--dry-run', '--apply', '--all-tables', '--new-table-only', '--drop',
    '--ping', '--status', '--fix-enums', '--inspect', '--diagnose', '--verbose', '--help', '-h',
  ]);
  const allowedValues = new Set(['flavor', 'specification', 'limit', 'table', 'confirm-delete']);
  const seenValues = new Set();
  for (const arg of argv) {
    if (allowedFlags.has(arg)) continue;
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match || !allowedValues.has(match[1]) || seenValues.has(match[1])) {
      throw new Error(`Option inconnue, vide ou répétée : ${arg}. Utilise --help pour consulter les options.`);
    }
    seenValues.add(match[1]);
  }
  if (HELP) return;
  if (TARGET_TABLE !== null && !TABLES.length) throw new Error(`Table inconnue dans le modèle configuré : ${TARGET_TABLE}.`);
  if (TARGET_TABLE && ALL) throw new Error('--table et --all-tables ne peuvent pas être combinés.');
  const modeCount = [PING, STATUS, FIX_ENUMS, INSPECT, DIAGNOSE, DROP].filter(Boolean).length;
  if (modeCount > 1) throw new Error('Choisis un seul mode : ping, status, fix-enums, inspect, diagnose ou drop.');
  const readOnly = PING || STATUS || INSPECT || DIAGNOSE;
  if (NEW_TABLE_ONLY && (readOnly || DROP || FIX_ENUMS || !TARGET_TABLE)) {
    throw new Error('--new-table-only exige --table=<id> et ne se combine pas aux modes de diagnostic ou de suppression.');
  }
  if (APPLY && readOnly) throw new Error('--apply ne se combine pas aux modes de diagnostic en lecture seule.');
  if (!readOnly && !DRY_RUN && !APPLY) {
    throw new Error('Aucune écriture effectuée : --apply et une cible explicite sont nécessaires après sauvegarde et revue du plan.');
  }
  if (!readOnly && !TARGET_TABLE && !ALL && !DRY_RUN) {
    throw new Error('Aucune écriture effectuée : précise --table=<id> ou --all-tables après revue.');
  }
  if ((DROP || FIX_ENUMS) && !TARGET_TABLE) throw new Error('--drop et --fix-enums exigent une seule table avec --table=<id>.');
  if (DROP && !DRY_RUN && option('confirm-delete', null) !== TARGET_TABLE) {
    throw new Error('Suppression refusée : --confirm-delete=<même id que --table> est requis.');
  }
  if (!DROP && option('confirm-delete', null) !== null) throw new Error('--confirm-delete est réservé à --drop.');
}

function usage() {
  console.log([
    'Provisioning Appwrite — sauvegarder et examiner le plan avant toute écriture.',
    '  --dry-run                         plan statique, sans comparer la base',
    '  --status                          diagnostic en lecture seule',
    '  --table=<id>                      cibler une seule table configurée',
    '  --new-table-only --table=<id>     créer une table absente ; refuser toute table existante',
    '  --apply                           autoriser les écritures prévues',
    '  --all-tables                      cibler toutes les tables (permissions comprises)',
    '  --flavor=tablesdb|databases       choisir le dialecte Appwrite',
    '  --drop                            destructif ; voir docs/DEPLOY_PDF_UNIFIED.md',
  ].join('\n'));
}

async function request(method, path, body) {
  if (DRY_RUN && !NETWORK_PROBE) return { __dryRun: true };
  const url = `${API_BASE}${path}`;
  if (VERBOSE) console.log(`  → ${method} ${path}`);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-appwrite-project': PROJECT,
        ...(API_KEY ? { 'x-appwrite-key': API_KEY } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const cause = error?.cause?.code || error?.name || 'ERROR';
    throw new ApiError(String(cause), { transport: true, method, path, url, cause });
  }

  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    throw new ApiError(payload?.message || `${response.status} ${response.statusText}`, {
      status: response.status,
      type: payload?.type,
      method,
      path,
      url,
      isJson: payload !== null,
      contentType: response.headers.get('content-type'),
      server: response.headers.get('server'),
      rawBody: text.slice(0, 300).replace(/\s+/g, ' ').trim(),
    });
  }
  return payload ?? {};
}

function otherFlavor(flavor) {
  return flavor === 'tablesdb' ? 'databases' : flavor === 'databases' ? 'tablesdb' : null;
}

/** Message actionnable : distinguer le réseau, la route, le proxy et l'autorisation. */
function explain(error) {
  if (error.transport) {
    return [
      `aucune route réseau vers ${API_BASE} (${error.cause}).`,
      '  L’API Appwrite n’est pas joignable depuis ce poste : egress filtré (TLS coupé) ou proxy.',
      '  Avec un proxy :  HTTPS_PROXY="http://127.0.0.1:port" npm run appwrite:setup',
      '  Sinon : provisionne depuis la console (docs/APPWRITE_AUTH_PLAN.md §3.2) ou depuis',
      '  une machine qui joint Internet, puis relance ce script avec --status.',
    ].join('\n');
  }
  if (error.status === 404 && !error.isJson) {
    const { fromAppwrite } = looksLikeAppwriteResponse({ server: error.server, contentType: error.contentType });
    if (fromAppwrite) {
      return [
        `${error.method} ${error.url} → Appwrite a répondu (server = ${error.server}) mais ne connaît pas cette route.`,
        `  content-type = ${error.contentType} : page du Console, pas l’API. Le réseau est donc bon.`,
        `  Base utilisée = ${API_BASE} ; elle doit finir par un unique /v1.`,
      ].join('\n');
    }
    return [
      `${error.method} ${error.url} → 404 texte, pas du JSON : ce n’est pas l’API Appwrite qui répond.`,
      `  serveur = ${error.server || 'inconnu'}, content-type = ${error.contentType || 'aucun'}`,
      '  corps   = ' + (error.rawBody || '(vide)'),
      '  Egress filtré ou proxy. Un 404 Appwrite légitime est TOUJOURS en JSON avec',
      '  "type":"general_route_not_found" — vois --diagnose.',
    ].join('\n');
  }
  if (error.status === 404) {
    if (error.type && error.type !== 'general_route_not_found') {
      return `${error.method} ${error.path} → 404 (${error.type}) : ${error.message}`;
    }
    const hint = otherFlavor(FLAVOR) ? ` Si la route est absente de cette instance : --flavor=${otherFlavor(FLAVOR)}.` : '';
    return `${error.method} ${error.path} → 404 (${error.type || 'type inconnu'}) : ressource ou route inconnue.${hint}`;
  }
  if (error.status === 401) return `401 : APPWRITE_API_KEY absente, invalide ou expirée, ou projet incorrect (${error.method} ${error.path}).`;
  if (error.status === 403) return `403 : accès interdit ; vérifie les permissions et les scopes de la clé pour ${error.method} ${error.path}.`;
  if (error.status === 400) {
    return [
      `400 sur ${error.method} ${error.path} : ${error.message}`,
      '  Appwrite valide les UID (36 caractères, [a-zA-Z0-9_.-], pas de _ initial) et les',
      '  types d’index : si le message cite « specification », relance avec',
      '  --specification=<id> (liste : GET /v1/tablesdb/specifications).',
    ].join('\n');
  }
  if (error.status === 429) return '429 : limite de débit atteinte, réessaie dans une minute.';
  return `${error.method ?? ''} ${error.path ?? ''} → ${error.message}`.trim();
}

let FLAVOR = null;

const MISSING_TYPES = {
  database: ['database_not_found'],
  table: ['table_not_found', 'collection_not_found'],
  column: ['column_not_found', 'attribute_not_found'],
  index: ['column_index_not_found', 'index_not_found'],
};

function isResourceMissing(error, group) {
  return error?.status === 404 && (MISSING_TYPES[group] ?? []).includes(error.type);
}

/** Ne créer qu'après un 404 Appwrite identifiant précisément la ressource. */
async function ensure(getPath, postPath, body, label, group) {
  if (DRY_RUN) {
    console.log(`  · ${label} → POST ${postPath} ${JSON.stringify(body)}`);
    return 'planned';
  }
  try {
    await request('GET', getPath);
    console.log(`  ✓ ${label} — déjà en place`);
    return 'exists';
  } catch (error) {
    // 403 ne signifie pas absent. Un 404 de route ou de parent non plus.
    if (!isResourceMissing(error, group)) throw error;
  }
  // Un conflit peut révéler une création concurrente ou une définition
  // différente ; ne jamais l'ignorer et poursuivre comme si c'était la nôtre.
  await withPendingRetry(() => request('POST', postPath, body), label, retryOptions);
  console.log(`  + ${label} — créée`);
  return 'created';
}

/**
 * Spécification TablesDB : 'auto' lit /tablesdb/specifications et retient la
 * première offre serveurless. Une instance qui ne sert pas cette route, ou une
 * liste vide, omet le champ et laisse le serveur appliquer son défaut.
 */
async function pickSpecification(listPath) {
  if (!listPath || SPECIFICATION === 'none') return undefined;
  if (SPECIFICATION !== 'auto') return SPECIFICATION;
  const list = await request('GET', listPath)
    .then((payload) => (Array.isArray(payload?.specifications) ? payload.specifications : []))
    .catch(() => []);
  const serverless = list.find((item) => item?.serverless === true)
    ?? list.find((item) => /serverless/i.test(String(item?.slug ?? item?.id ?? '')));
  const chosen = serverless?.slug ?? serverless?.id;
  if (chosen) console.log(`  · spécification retenue : ${chosen}`);
  return chosen || undefined;
}

/** Sonde les deux dialectes et choisit celui que l'instance sert réellement. */
async function resolveFlavor() {
  if (FLAVOR_REQUEST !== 'auto') {
    if (!SPECS[FLAVOR_REQUEST]) throw new ApiError(`--flavor inconnu : ${FLAVOR_REQUEST} (attendu tablesdb ou databases)`);
    FLAVOR = FLAVOR_REQUEST;
    return FLAVOR_REQUEST;
  }
  for (const name of ['tablesdb', 'databases']) {
    try {
      await request('GET', SPECS[name].listDatabases);
      FLAVOR = name;
      return name;
    } catch (error) {
      if (error.transport) throw error;
      // 401/403 : la route existe, c'est l'authentification qui manque.
      if (error.status && error.status !== 404) { FLAVOR = name; return name; }
    }
  }
  console.warn('  ! ni /tablesdb ni /databases ne répondent en 401/200 : repli sur l’API héritée.');
  FLAVOR = 'databases';
  return 'databases';
}

async function pingOnly() {
  const url = `${API_BASE}/ping`;
  try {
    const response = await fetch(url, { headers: { 'x-appwrite-project': PROJECT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = (await response.text()).trim();
    const ok = response.status === 200 && PING_BODY.test(body);
    console.log(`ping ${url} → ${response.status} ${body.slice(0, 120)}${ok ? '  ✓ endpoint et réseau valides' : ''}`);
    if (!ok) {
      console.log(`  attendu : HTTP 200 et le corps exact « Pong! ». Toute autre réponse = route ou proxy.`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.log(explain(new ApiError(String(error?.cause?.code || error?.name), { transport: true, cause: error?.cause?.code || error?.name, method: 'GET', path: '/ping', url })));
    process.exitCode = 1;
  }
}

async function diagnose() {
  console.log(`base     : ${API_BASE}`);
  console.log(`projet   : ${PROJECT}`);
  console.log(`clé      : ${API_KEY ? 'présente' : 'absente'} (len ${API_KEY.length})`);
  console.log(`attendu  : HTTP 200 + corps exact « Pong! » sur ${API_BASE}/ping`);
  try {
    const response = await fetch(`${API_BASE}/ping`, { headers: { 'x-appwrite-project': PROJECT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = (await response.text()).slice(0, 120).replace(/\s+/g, ' ');
    const headers = { server: response.headers.get('server'), contentType: response.headers.get('content-type') };
    const { fromAppwrite, json } = looksLikeAppwriteResponse({ ...headers, contentType: headers.contentType });
    console.log(`ping     : HTTP ${response.status} · content-type=${headers.contentType} · server=${headers.server} · corps="${body}"`);
    if (response.status === 200 && PING_BODY.test(body.trim())) {
      console.log('           ✓ réseau, endpoint et route /ping corrects — le script peut travailler.');
    } else if (fromAppwrite) {
      console.log('           ↑ Appwrite a répondu (server = ' + headers.server + ') mais pas sur cette route.');
      console.log(`             Vérifie la base : un seul /v1, obtenu « ${API_BASE} ».`);
    } else if (!json) {
      console.log('           ↑ ni le statut ni l’en-tête server d’Appwrite : proxy ou egress filtré.');
    }
  } catch (error) {
    console.log(`ping     : ${error?.cause?.code || error?.name} — réseau sortant coupé vers cet hôte`);
  }
  for (const name of ['tablesdb', 'databases']) {
    const path = SPECS[name].listDatabases;
    try {
      await request('GET', path);
      console.log(`route    : ${API_BASE}${path} → 200 (API ${name} disponible)`);
    } catch (error) {
      const verdict = error.transport
        ? error.cause
        : `${error.status}${error.isJson ? ' json' : ' html'}${error.status && error.status !== 404 ? ' → route existante' : ''}`;
      console.log(`route    : ${API_BASE}${path} → ${verdict}`);
    }
  }
  console.log(`flavor   : ${await resolveFlavor().catch(() => 'indéterminé')} (à reporter dans VITE_APPWRITE_FLAVOR)`);
}

function reportStatusError(resource, error) {
  process.exitCode = 1;
  if (error.status === 401 || error.status === 403) {
    console.log(`  ! ${resource} : impossible à vérifier (${error.status}) — accès refusé ; l’existence de la ressource est inconnue.`);
    console.log(`    ${explain(error)}`);
  } else if (error.status === 404) {
    console.log(`  ! ${resource} : introuvable ou route incorrecte (404) — vérifier l’identifiant, l’API et les permissions.`);
  } else {
    console.log(`  ! ${resource} : vérification impossible — ${explain(error).split('\n')[0]}`);
  }
}

async function status() {
  const spec = SPECS[FLAVOR];
  const database = await request('GET', spec.database(DATABASE_ID)).catch((error) => {
    reportStatusError(`base ${DATABASE_ID}`, error);
    return null;
  });
  if (!database) return;
  console.log(`base ${DATABASE_ID} — ${database.name} (${spec.label})`);
  let blocked = 0;
  const rows = new Map();
  for (const table of TABLES) {
    const row = await request('GET', spec.tablePath(DATABASE_ID, table)).catch((error) => {
      reportStatusError(`table ${table.id}`, error);
      return null;
    });
    if (!row) {
      blocked += 1;
      continue;
    }
    rows.set(table.id, row);
    let invalid = false;
    const columns = Array.isArray(row.columns ?? row.attributes) ? (row.columns ?? row.attributes) : [];
    const indexes = Array.isArray(row.indexes) ? row.indexes : [];
    const security = row.rowSecurity ?? row.documentSecurity;
    console.log(`  ${table.id} : ${columns.length}/${table.columns.length} colonnes, ${indexes.length}/${table.indexes.length} index, sécurité par ligne=${security}`);
    if (Number.isFinite(row.bytesUsed) && Number.isFinite(row.bytesMax)) {
      console.log(`    largeur de ligne déclarée : ${row.bytesUsed}/${row.bytesMax} octets (0 = sans limite annoncée)`);
    }
    if (security !== table.rowSecurity) {
      console.log(`    ! sécurité par ligne différente ou inconnue : attendu ${table.rowSecurity}`);
      invalid = true;
    }
    if (row.enabled !== true) {
      console.log('    ! table désactivée ou état enabled inconnu');
      invalid = true;
    }
    for (const [label, expected, live] of [['colonne', table.columns, columns], ['index', table.indexes, indexes]]) {
      for (const item of expected) {
        const found = live.find((entry) => (entry.key ?? entry.$id) === item.key);
        if (!found) {
          console.log(`    ! ${label} absente : ${item.key}`);
          invalid = true;
          continue;
        }
        if (found.status !== 'available') {
          console.log(`    ! ${label} ${item.key} non disponible ou état inconnu : ${found.status ?? 'inconnu'}`);
          invalid = true;
        }
        if (label === 'index') {
          const actualColumns = found.columns ?? found.attributes;
          if (found.type !== item.type || !Array.isArray(actualColumns) || JSON.stringify(actualColumns) !== JSON.stringify(item.columns)) {
            console.log(`    ! définition de l’index ${item.key} différente ou incomplète`);
            invalid = true;
          }
        }
      }
    }
    const live = row.$permissions ?? row.permissions;
    const drift = permissionsDrift(table.permissions, live);
    if (!drift.known) {
      console.log('    ! permissions de table non renvoyées : impossible de les vérifier');
      invalid = true;
    } else if (!drift.aligned) {
      console.log(`    ! permissions de table en base [${live.join(', ')}], prévu [${(table.permissions ?? []).join(', ')}]`);
      if (drift.empty) console.log('      aucune permission au niveau table ; des permissions de ligne peuvent néanmoins autoriser l’accès.');
      if (drift.extra.length) console.log(`      accès supplémentaires à examiner : [${drift.extra.join(', ')}]`);
      invalid = true;
    } else {
      console.log(`    ✓ permissions de table conformes (${live.join(', ')})`);
    }
    if (invalid) blocked += 1;
  }
  const drifts = await modelDriftReport({ rows });
  if (drifts) {
    console.log(`  ${drifts} colonne(s) en décalage avec le modèle : ne rien modifier avant sauvegarde et revue.`);
    process.exitCode = 1;
  }
  if (blocked) {
    console.log(`\n  ${blocked} table(s) n’ont pas pu être validées : examiner les écarts avant tout déploiement.`);
    process.exitCode = 1;
  }
  console.log('  Ce diagnostic admin ne vérifie ni les données ni les permissions de chaque ligne ; tester séparément avec deux comptes.');
}

/**
 * Compare le modèle déclaré à ce que la base contient réellement.
 *
 * `ensure()` ne fait que créer ce qui manque : une colonne déjà présente garde sa
 * vieille définition. C'est exactement le piège du 400 « Cannot set default value
 * for required column » rencontré ici — la table était à moitié créée, et le
 * modèle avait changé entre-temps.
 */
async function modelDriftReport({ fix = false, rows = null } = {}) {
  const spec = SPECS[FLAVOR];
  let drifts = 0;
  for (const table of TABLES) {
    const row = rows ? rows.get(table.id) : await request('GET', spec.tablePath(DATABASE_ID, table)).catch((error) => {
      reportStatusError(`table ${table.id}`, error);
      return null;
    });
    if (!row) continue;
    const liveColumns = row.columns ?? row.attributes ?? [];
    for (const column of table.columns) {
      const live = liveColumns.find((item) => (item.key ?? item.$id) === column.key);
      if (!live) continue; // sera créé par le run
      const drift = columnDrift(column, live);
      if (!drift) continue;
      drifts += 1;
      const parts = [];
      if (drift.type) parts.push(`type=${drift.type.actual} prévu=${drift.type.expected}`);
      if (drift.required) parts.push(`requis=${drift.required.actual} prévu=${drift.required.expected}`);
      if (drift.size) parts.push(`taille=${drift.size.actual} prévue=${drift.size.expected}`);
      if (drift.default) parts.push(`défaut=${JSON.stringify(drift.default.actual)} prévu=${JSON.stringify(drift.default.expected)}`);
      if (drift.array) parts.push(`tableau=${drift.array.actual} prévu=${drift.array.expected}`);
      if (drift.encrypt) parts.push(`chiffrement=${drift.encrypt.actual} prévu=${drift.encrypt.expected}`);
      if (drift.elements) parts.push(`enum [${drift.elements.actual?.join(', ') ?? 'inconnu'}] prévu [${drift.elements.expected.join(', ')}]`);
      console.log(`  ! ${table.id}.${column.key} : ${parts.join(', ')}`);
      const enumFix = enumColumns([table]).find(({ column: c }) => c.key === column.key);
      if (!enumFix || !Array.isArray(drift.elements?.actual) || Object.keys(drift).some((key) => key !== 'elements')) {
        console.log('    → sauvegarder et examiner une migration non destructive ; aucune colonne ni table n’est supprimée.');
        if (fix) process.exitCode = 1;
        continue;
      }
      if (!fix || DRY_RUN) {
        console.log('    → vérifier manuellement les conséquences sur les données et sauvegardes avant toute modification.');
        continue;
      }
      const target = spec.enumElements(DATABASE_ID, table, column);
      await withPendingRetry(() => request(target.method ?? 'PATCH', target.path, target.body), `${table.id}.${column.key} enum`, retryOptions);
      console.log('    ✓ demande de réalignement envoyée ; revérifier l’état et les données.');
    }
  }
  return drifts;
}

/**
 * Rapport « qui a écrit quoi » : les tables ne portent pas d'email (l'identité
 * reste dans Auth), donc la jointure se fait ici par `userId` via
 * `GET /v1/users/{id}` — scope `users:read` sur la clé. Sans ce scope, le rapport
 * reste lisible : il affiche l'ID et dit quoi ajouter.
 */
async function inspect() {
  const spec = SPECS[FLAVOR];
  const limit = option('limit', '25');
  let usersById = [];
  let scopeMissing = false;

  for (const table of TABLES) {
    const listPath = `${spec.tablePath(DATABASE_ID, table)}/rows?limit=${encodeURIComponent(limit)}`;
    const result = await request('GET', listPath).catch((error) => {
      console.log(`\n${table.id} : lecture impossible (${explain(error).split('\n')[0]})`);
      return null;
    });
    if (!result) continue;
    const rowsList = result.rows ?? result.documents ?? [];
    console.log(`\n${table.id} — ${result.total ?? rowsList.length} ligne(s)`);
    if (!rowsList.length) {
      console.log('  (aucune ligne : écritures coupées, ou personne n’a encore épinglé/enregistré)');
      continue;
    }
    const ids = [...new Set(rowsList.map((row) => row.userId).filter(Boolean))];
    for (const id of ids) {
      if (usersById.some((user) => user.$id === id)) continue;
      const user = await request('GET', `/users/${id}`).catch((error) => {
        if (error.status === 401 || error.status === 403) scopeMissing = true;
        return null;
      });
      if (user) usersById.push(user);
    }
    for (const line of summarizeRows(rowsList, usersById, { max: Number(limit) })) {
      const owner = line.email ?? `compte ${line.userId ?? 'sans userId'}`;
      const verified = line.verified === null ? '' : line.verified ? ' · vérifié' : ' · NON vérifié';
      const seen = line.row?.lastSeenAt ? ` · vu ${String(line.row.lastSeenAt).slice(0, 16).replace('T', ' ')}` : '';
      const detail = table.id === 'profiles'
        ? `${line.row?.promotion ?? '?'} · ${line.row?.filiere ?? '?'}`
        : `${line.row?.kind === 'folder' ? 'dossier' : 'fichier'} · ${line.row?.filePath ?? ''}`;
      console.log(`  ${owner}${verified}${seen} — ${detail}  [row ${line.rowId}]`);
    }
  }
  if (scopeMissing) {
    console.log('\n  Les emails viennent du service Auth : ajoute le scope `users:read` à la clé');
    console.log('  d’API (Console → API Keys) pour que ce rapport les affiche.');
  }
}

async function drop() {
  const spec = SPECS[FLAVOR];
  for (const table of [...TABLES].reverse()) {
    const target = spec.tablePath(DATABASE_ID, table);
    if (DRY_RUN) {
      console.log(`  · ${table.id} → DELETE ${target} (simulation uniquement)`);
      continue;
    }
    await request('DELETE', target);
    console.log(`  − ${table.id} : demande de suppression envoyée`);
  }
  if (DRY_RUN) return;
  console.log(`Demandes de suppression envoyées (la base est conservée). Vérifier l'état dans Appwrite.`);
  // La suppression est asynchrone côté serveur : recréer la même table dans la
  // seconde qui suit peut retomber sur l'ancienne (409), que ensure() ignore
  // « déjà en place » — et la vieille liste de colonnes survivrait.
  await new Promise((done) => setTimeout(done, 1500));
}

async function main() {
  validateOptions();
  if (HELP) return usage();
  if (PING) return pingOnly();
  if (DIAGNOSE) return diagnose();

  if (!API_KEY && !DRY_RUN && !STATUS) {
    console.error(
      'APPWRITE_API_KEY manquante. Crée une clé serveur dans le bon projet Appwrite\n'
      + 'avec les scopes de lecture/écriture du schéma, puis ajoute-la localement\n'
      + 'à .dev.vars sous APPWRITE_API_KEY. Ne partage jamais cette clé.\n'
      + '--ping et --dry-run fonctionnent sans clé ; --status peut exiger une clé.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nAppwrite ${API_BASE} · projet ${PROJECT}`);
  const flavor = await resolveFlavor();
  const spec = SPECS[flavor];
  FLAVOR = flavor;
  console.log(`api      : ${spec.label}${FLAVOR_REQUEST === 'auto' ? ' (auto-détectée)' : ' (imposée par --flavor)'}\n`);

  if (STATUS) return status();
  if (INSPECT) return inspect();
  if (DROP) return drop();
  if (FIX_ENUMS) {
    const drifts = await modelDriftReport({ fix: true });
    console.log(drifts ? `${drifts} colonne(s) présentaient un décalage. Vérifier à nouveau l’état et les données.` : 'Aucun décalage de colonne détecté.');
    return;
  }

  const plan = buildPlan({ spec, databaseId: DATABASE_ID, tables: TABLES });
  const databaseOp = plan[0];
  if (spec.specifications && !TARGET_TABLE) {
    const specification = await pickSpecification(spec.specifications);
    if (specification) databaseOp.body = { ...databaseOp.body, specification };
  }
  if (DRY_RUN) {
    console.log('Simulation statique : aucune comparaison de la base réelle et aucune écriture.');
  } else if (!NEW_TABLE_ONLY) {
    console.warn('Attention : cette opération peut modifier le schéma et réappliquer les permissions des tables ciblées.');
  }

  for (const op of plan) {
    if (op.group === 'database' && TARGET_TABLE) {
      // Cibler une table ne doit jamais créer ou configurer la base par surprise.
      if (DRY_RUN) console.log(`  · base existante requise → GET ${op.get}`);
      else {
        await request('GET', op.get);
        console.log(`  ✓ base ${DATABASE_ID} — vérifiée sans modification`);
      }
      continue;
    }
    if (op.group === 'table') {
      console.log(`\n${spec.noun} ${op.label}`);
      if (NEW_TABLE_ONLY) {
        if (DRY_RUN) {
          console.log(`  · ${op.label} → GET ${op.get} puis POST ${op.post} uniquement si absence confirmée ${JSON.stringify(op.body)}`);
        } else {
          const exists = await request('GET', op.get).then(() => true).catch((error) => {
            if (isResourceMissing(error, 'table')) return false;
            throw error;
          });
          if (exists) throw new Error(`La table ${op.label} existe déjà : aucun changement de cette table en mode --new-table-only.`);
          // Ne pas ignorer un conflit entre le GET et le POST : quelqu'un peut
          // avoir créé une autre table entre-temps.
          await request('POST', op.post, op.body);
          console.log(`  + ${op.label} — création demandée`);
        }
        continue;
      }
    }
    if (op.group === 'permissions') {
      if (DRY_RUN) {
        console.log(`  · ${op.label} → ${op.method} ${op.patch} ${JSON.stringify(op.body)}`);
      } else {
        await withPendingRetry(() => request(op.method ?? 'PUT', op.patch, op.body), `${op.parent} permissions`, retryOptions);
        console.log(`  ✓ ${op.parent} — permissions appliquées`);
      }
      continue;
    }
    await ensure(op.get, op.post, op.body, op.label, op.group);
  }

  if (DRY_RUN) return;
  console.log('\nDemandes envoyées. Les colonnes/index peuvent encore être en cours de création ; ne pas relancer automatiquement.');
  await status();
}

await main().catch((error) => {
  console.error(`\n✗ ${explain(error)}`);
  if (VERBOSE && error?.stack) console.error(error.stack);
  process.exitCode = 1;
});
