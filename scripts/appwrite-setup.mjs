#!/usr/bin/env node
/**
 * Provisioning Appwrite pour ENISE Docs : base `enise_docs`, tables `profiles`
 * et `favorites`, colonnes, index et permissions.
 *
 * Le modèle et les chemins vivent dans `scripts/appwrite-spec.js` (testé dans
 * `tests/appwrite-provisioning-plan.test.js`) : --dry-run, --status, --drop et
 * le run réel consomment le même plan, donc ils ne peuvent plus diverger.
 *
 *   npm run appwrite:ping                                  # réseau + endpoint
 *   node scripts/appwrite-setup.mjs --diagnose             # qui répond, où
 *   APPWRITE_API_KEY="***" npm run appwrite:setup          # provisioning
 *   npm run appwrite:status                                # contrôle après run
 *   node scripts/appwrite-setup.mjs --flavor=databases     # force l'API 1.x
 *   node scripts/appwrite-setup.mjs --fix-enums            # réaligne les colonnes enum
 *   node scripts/appwrite-setup.mjs --inspect              # lignes + email du propriétaire
 *   node scripts/appwrite-setup.mjs --drop                 # retire les tables
 *
 * La clé serveur ne doit JAMAIS être commitée ni porter un préfixe VITE_.
 */
import { APPWRITE_API_BASE, APPWRITE_PROJECT_ID } from '../src/config.js';
import { looksLikeAppwriteResponse, normalizeAppwriteEndpoint } from '../src/utils/appwriteEndpoint.js';
import { SPECS, TABLES, buildPlan, columnDrift, enumColumns, permissionsDrift, summarizeRows, withPendingRetry } from './appwrite-spec.js';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
const option = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const DRY_RUN = flags.has('--dry-run');
const DROP = flags.has('--drop');
const PING = flags.has('--ping');
const STATUS = flags.has('--status');
const FIX_ENUMS = flags.has('--fix-enums');
const INSPECT = flags.has('--inspect');
const DIAGNOSE = flags.has('--diagnose');
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

/** --diagnose et --status doivent interroger le réseau réel, même en dry-run. */
const NETWORK_PROBE = DIAGNOSE || STATUS || INSPECT;

const retryOptions = { attempts: RETRY_ATTEMPTS, delayMs: RETRY_DELAY_MS };

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
    const hint = otherFlavor(FLAVOR) ? ` Si la route est absente de cette instance : --flavor=${otherFlavor(FLAVOR)}.` : '';
    return `${error.method} ${error.path} → 404 (${error.type || 'general_route_not_found'}) : route inconnue de cette instance.${hint}`;
  }
  if (error.status === 401) return `401 : APPWRITE_API_KEY absente, expirée ou révoquée (${error.method} ${error.path}).`;
  if (error.status === 403) return `403 : la clé n’a pas le scope nécessaire (databases:write) pour ${error.method} ${error.path}.`;
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

/** GET puis POST : renvoie 'created' | 'exists' | 'skipped' | 'planned'. */
async function ensure(getPath, postPath, body, label) {
  if (DRY_RUN) {
    console.log(`  · ${label} → POST ${postPath} ${JSON.stringify(body)}`);
    return 'planned';
  }
  try {
    await request('GET', getPath);
    console.log(`  ✓ ${label} — déjà en place`);
    return 'exists';
  } catch (error) {
    if (error.transport) throw error;
    if (error.status !== 404 && error.status !== 403) throw error;
    if (error.status === 403) console.warn(`  ! ${label} — illisible avec cette clé, création tentée`);
  }
  try {
    await withPendingRetry(() => request('POST', postPath, body), label, retryOptions);
    console.log(`  + ${label} — créée`);
    return 'created';
  } catch (error) {
    if (error.status === 409 || error.type === 'duplicate_unique' || /already exists/i.test(error.message)) {
      console.log(`  ✓ ${label} — déjà en place (conflit ignoré)`);
      return 'exists';
    }
    if (/index/i.test(`${error.message} ${error.path}`) && /not support|invalid|unsupported/i.test(error.message)) {
      console.warn(`  ! ${label} — ignoré : ${error.message}`);
      return 'skipped';
    }
    throw error;
  }
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

async function status() {
  const spec = SPECS[FLAVOR];
  const database = await request('GET', spec.database(DATABASE_ID)).catch((error) => {
    console.log(`base ${DATABASE_ID} : ${error.status ? `absente (${error.status})` : error.cause}`);
    return null;
  });
  if (!database) return;
  console.log(`base ${DATABASE_ID} — ${database.name} (${spec.label})`);
  let blocked = 0;
  for (const table of TABLES) {
    const row = await request('GET', spec.tablePath(DATABASE_ID, table)).catch(() => null);
    if (!row) {
      console.log(`  ${table.id} : absente — npm run appwrite:setup`);
      blocked += 1;
      continue;
    }
    const columns = row.columns ?? row.attributes ?? [];
    const indexes = row.indexes ?? [];
    console.log(`  ${table.id} : ${columns.length}/${table.columns.length} colonnes, ${indexes.length}/${table.indexes.length} index, sécurité par ligne=${row.rowSecurity ?? row.documentSecurity}`);
    // Les permissions LUES sont la seule réponse à « le PUT est-il passé ? » :
    // afficher celles du modèle, comme le faisait ce rapport, ne prouvait rien.
    const live = row.$permissions ?? row.permissions ?? [];
    const drift = permissionsDrift(table.permissions, live);
    if (drift.empty) {
      console.log('    ! aucune permission sur la table : le client ne peut ni lire ni écrire — npm run appwrite:setup');
      blocked += 1;
    } else if (drift.missing.length) {
      console.log(`    ! permissions en base [${live.join(', ')}], prévu [${(table.permissions ?? []).join(', ')}] → npm run appwrite:setup`);
      blocked += 1;
    } else if (drift.noCreate) {
      console.log('    ! pas de create() : inscription possible, profil impossible à écrire');
      blocked += 1;
    } else {
      console.log(`    ✓ permissions conformes (${live.join(', ')})`);
    }
  }
  const drifts = await modelDriftReport();
  if (drifts) console.log(`  ${drifts} colonne(s) en décalage avec le modèle (${FIX_ENUMS ? 'corrigées' : '--fix-enums pour les enums, console pour le reste'}).`);
  if (blocked) console.log(`\n  ${blocked} table(s) empêchent l’écriture depuis le navigateur : un compte créé côté Auth n’aura aucune ligne en base.`);
}

/**
 * Compare le modèle déclaré à ce que la base contient réellement.
 *
 * `ensure()` ne fait que créer ce qui manque : une colonne déjà présente garde sa
 * vieille définition. C'est exactement le piège du 400 « Cannot set default value
 * for required column » rencontré ici — la table était à moitié créée, et le
 * modèle avait changé entre-temps.
 */
async function modelDriftReport({ fix = false } = {}) {
  const spec = SPECS[FLAVOR];
  let drifts = 0;
  for (const table of TABLES) {
    const row = await request('GET', spec.tablePath(DATABASE_ID, table)).catch(() => null);
    if (!row) continue;
    const liveColumns = row.columns ?? row.attributes ?? [];
    for (const column of table.columns) {
      const live = liveColumns.find((item) => (item.key ?? item.$id) === column.key);
      if (!live) continue; // sera créé par le run
      const drift = columnDrift(column, live);
      if (!drift) continue;
      drifts += 1;
      const parts = [];
      if (drift.required) parts.push(`requis=${drift.required.actual} prévu=${drift.required.expected}`);
      if (drift.size) parts.push(`taille=${drift.size.actual} prévue=${drift.size.expected}`);
      if (drift.default) parts.push(`défaut=${JSON.stringify(drift.default.actual)} prévu=${JSON.stringify(drift.default.expected)}`);
      if (drift.elements) parts.push(`enum [${drift.elements.actual?.join(', ')}] prévu [${drift.elements.expected.join(', ')}]`);
      console.log(`  ! ${table.id}.${column.key} : ${parts.join(', ')}`);
      const enumFix = enumColumns([table]).find(({ column: c }) => c.key === column.key);
      if (!enumFix) {
        console.log('    → non réparable en écriture : ajuste dans la console, ou retire la table avec --drop');
        continue;
      }
      if (!fix) { console.log('    → node scripts/appwrite-setup.mjs --fix-enums'); continue; }
      if (DRY_RUN) continue;
      const target = spec.enumElements(DATABASE_ID, table, column);
      await withPendingRetry(() => request(target.method ?? 'PATCH', target.path, target.body), `${table.id}.${column.key} enum`, retryOptions)
        .then(() => console.log('    ✓ éléments d’enum réalignés'))
        .catch((error) => console.warn(`    ✗ ${table.id}.${column.key} — ${explain(error).split('\n')[0]}`));
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
    await request('DELETE', spec.tablePath(DATABASE_ID, table)).catch((error) => {
      console.warn(`  − ${table.id} : ${error.status === 404 ? 'absente' : error.message}`);
    });
  }
  console.log(`${spec.noun}s supprimées (la base est conservée)`);
  // La suppression est asynchrone côté serveur : recréer la même table dans la
  // seconde qui suit peut retomber sur l'ancienne (409), que ensure() ignore
  // « déjà en place » — et la vieille liste de colonnes survivrait.
  await new Promise((done) => setTimeout(done, 1500));
}

async function main() {
  if (PING) return pingOnly();
  if (DIAGNOSE) return diagnose();

  if (!API_KEY && !DRY_RUN && !STATUS) {
    console.error(
      'APPWRITE_API_KEY manquante. Crée une clé serveur dans Console → API Keys\n'
      + '(scope databases:write) puis relance :\n'
      + '  export APPWRITE_API_KEY=$(read -s …) ; npm run appwrite:setup\n'
      + '--status, --diagnose, --ping et --dry-run fonctionnent sans clé.',
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
    console.log(drifts ? `${drifts} colonne(s) en décalage, enums réalignés.` : 'Aucun décalage : la base matche le modèle.');
    return;
  }

  const plan = buildPlan({ spec, databaseId: DATABASE_ID });
  const databaseOp = plan[0];
  if (spec.specifications) {
    const specification = await pickSpecification(spec.specifications);
    if (specification) databaseOp.body = { ...databaseOp.body, specification };
  }

  for (const op of plan) {
    if (op.group === 'table') console.log(`\n${spec.noun} ${op.label}`);
    if (op.group === 'permissions') {
      if (DRY_RUN) {
        console.log(`  · ${op.label} → ${op.method} ${op.patch} ${JSON.stringify(op.body)}`);
      } else {
        // Méthode imposée par le dialecte : TablesDB attend un PUT sur la table
        // (avec `name`), pas un PATCH — le PATCH répond une page 404 du Console.
        await withPendingRetry(() => request(op.method ?? 'PATCH', op.patch, op.body), `${op.parent} permissions`, retryOptions)
          .then(() => console.log(`  ✓ ${op.parent} — permissions appliquées`))
          .catch((error) => console.warn(`  ! ${op.parent} — permissions : ${explain(error).split('\n')[0]}`));
      }
      continue;
    }
    await ensure(op.get, op.post, op.body, op.label);
  }

  // Contrôle immédiat : une colonne déjà présente avant ce run n'a pas été
  // recréée, donc un modèle modifié entre deux exécutions se voit ici plutôt
  // qu'au premier écritage refusé par Appwrite.
  const drifts = await modelDriftReport();
  if (drifts) console.log(`\n${drifts} colonne(s) en décalage avec la base — relance avec --fix-enums pour les enums.`);

  console.log([
    '',
    'Contrôle',
    '--------',
    `   npm run appwrite:status      # colonnes et index attendus vs réels`,
    '',
    'À faire ensuite',
    '---------------',
    '1. Variables publiques du build :',
    `   VITE_APPWRITE_DATABASE_ID="${DATABASE_ID}"`,
    '   VITE_APPWRITE_PROFILE_TABLE_ID="profiles"',
    '   VITE_APPWRITE_FAVORITES_TABLE_ID="favorites"',
    `   VITE_APPWRITE_FLAVOR="${flavor}"`,
    '2. Console → Settings → Domains & Platforms : hostname du site + localhost,',
    '   sinon le navigateur bloque les appels en CORS.',
    '3. Console → Settings → Auth : 12 caractères minimum, vérification d’email',
    '   obligatoire, 5 sessions maximum.',
    '4. Rôles : pas de colonne « role » (éditable par le client) — label « admin »',
    '   via PUT /v1/users/{userId}/labels.',
    '',
  ].join('\n'));
}

await main().catch((error) => {
  console.error(`\n✗ ${explain(error)}`);
  if (VERBOSE && error?.stack) console.error(error.stack);
  process.exitCode = 1;
});
