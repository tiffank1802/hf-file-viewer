#!/usr/bin/env node
/**
 * Provisioning Appwrite pour ENISE Docs : base `enise_docs`, tables
 * `profiles` et `favorites`, colonnes, index et permissions.
 *
 * Idempotent : chaque création est précédée d'une lecture, un conflit (409) est
 * ignoré. Relançable après une interruption.
 *
 *   APPWRITE_API_KEY="***" node scripts/appwrite-setup.mjs
 *   node scripts/appwrite-setup.mjs --diagnose        # qui répond, et sur quelles routes
 *   node scripts/appwrite-setup.mjs --ping
 *   node scripts/appwrite-setup.mjs --status
 *   node scripts/appwrite-setup.mjs --dry-run
 *   node scripts/appwrite-setup.mjs --drop
 *   node scripts/appwrite-setup.mjs --flavor=databases   # force l'API héritée
 *
 * Scopes minimaux de la clé : databases:write. Elle ne doit JAMAIS être commitée
 * ni porter un préfixe VITE_ : elle atterrirait dans le bundle du navigateur.
 */
import { APPWRITE_API_BASE, APPWRITE_PROJECT_ID } from '../src/config.js';
import { looksLikeAppwriteResponse, normalizeAppwriteEndpoint } from '../src/utils/appwriteEndpoint.js';

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
const DIAGNOSE = flags.has('--diagnose');
const VERBOSE = flags.has('--verbose');
const TIMEOUT_MS = Number(process.env.APPWRITE_TIMEOUT_MS || 30_000);

// Base normalisée : l'endpoint public contient déjà /v1, coller nos chemins
// derrière sans normaliser produisait /v1/v1/… (404 HTML d'Appwrite).
const API_BASE = normalizeAppwriteEndpoint(process.env.APPWRITE_ENDPOINT || APPWRITE_API_BASE);
const PROJECT = process.env.APPWRITE_PROJECT_ID || APPWRITE_PROJECT_ID;
const API_KEY = process.env.APPWRITE_API_KEY || '';
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID || 'enise_docs';
const FLAVOR_REQUEST = option('flavor', process.env.APPWRITE_FLAVOR || 'auto').toLowerCase();
const SPECIFICATION = option('specification', process.env.APPWRITE_SPECIFICATION || 'auto');

/** Rôles Appwrite, au format littéral attendu par l'API. */
const ROLE_USERS = 'users';
const ROLE_USERS_VERIFIED = 'users/verified';

/**
 * Modèle de données commun aux deux API. Seule la traduction change (spec plus
 * bas) : `columns`/`attributes`, `rowSecurity`/`documentSecurity`, etc.
 */
const TABLES = [
  {
    id: 'profiles',
    name: 'Profils étudiants',
    rowSecurity: true,
    permissions: [`create("${ROLE_USERS_VERIFIED}")`, `read("${ROLE_USERS}")`],
    columns: [
      { type: 'string', key: 'userId', size: 36, required: true },
      { type: 'string', key: 'displayName', size: 128, required: true, default: '' },
      { type: 'enum', key: 'promotion', elements: ['3A', '4A', '5A', 'Alumni', 'Staff'], required: true, default: '3A' },
      { type: 'enum', key: 'filiere', elements: ['GM', 'TOEIC', 'Autre'], required: true, default: 'GM' },
      { type: 'string', key: 'bio', size: 280, required: false, default: '' },
      { type: 'boolean', key: 'emailVerified', required: true, default: false },
      { type: 'datetime', key: 'lastSeenAt', required: false },
    ],
    indexes: [
      { key: 'uniq_profile_user', type: 'unique', columns: ['userId'] },
      { key: 'idx_profile_promotion', type: 'key', columns: ['promotion'] },
    ],
  },
  {
    id: 'favorites',
    name: 'Favoris synchronisés',
    rowSecurity: true,
    permissions: [`create("${ROLE_USERS_VERIFIED}")`],
    columns: [
      { type: 'string', key: 'userId', size: 36, required: true },
      { type: 'string', key: 'filePath', size: 1024, required: true },
      { type: 'string', key: 'pathKey', size: 64, required: true },
      { type: 'enum', key: 'kind', elements: ['file', 'folder'], required: true, default: 'file' },
      { type: 'string', key: 'title', size: 240, required: false, default: '' },
      { type: 'string', key: 'note', size: 280, required: false, default: '' },
    ],
    indexes: [
      // L'index unique porte sur la clé courte : une colonne de 1024 caractères
      // dépasse la taille maximale acceptée pour une clé d'index par le moteur.
      { key: 'uniq_favorite_user_path', type: 'unique', columns: ['userId', 'pathKey'] },
      { key: 'idx_favorite_user_created', type: 'key', columns: ['userId', '$createdAt'] },
      { key: 'fulltext_favorite', type: 'fulltext', columns: ['title', 'note'] },
    ],
  },
];

/** Deux dialectes REST pour la même intention. */
const SPECS = {
  tablesdb: {
    label: 'TablesDB (API 2.x)',
    listDatabases: '/tablesdb?limit=1',
    database: (db) => `/tablesdb/${db}`,
    createDatabase: (extra) => ({ path: '/tablesdb', body: { databaseId: DATABASE_ID, name: 'ENISE Docs', ...extra } }),
    table: (db, table) => `/tablesdb/${db}/tables/${table}`,
    createTable: (db, table) => ({
      path: `/tablesdb/${db}/tables`,
      body: { tableId: table.id, name: table.name, rowSecurity: table.rowSecurity, enabled: true },
    }),
    updatePermissions: (db, table) => ({ path: `/tablesdb/${db}/tables/${table.id}`, body: { permissions: table.permissions } }),
    column: (db, table, column) => ({
      path: `/tablesdb/${db}/tables/${table.id}/columns/${column.type}`,
      body: { key: column.key, ...strip(column, 'type') },
    }),
    columnPath: (db, table, column) => `/tablesdb/${db}/tables/${table.id}/columns/${column.key}`,
    index: (db, table, index) => ({
      path: `/tablesdb/${db}/tables/${table.id}/indexes`,
      body: { key: index.key, type: index.type, columns: index.columns },
    }),
    indexPath: (db, table, index) => `/tablesdb/${db}/tables/${table.id}/indexes/${index.key}`,
    flavor: 'tablesdb',
    // Les plans Cloud récents demandent une spécification (serveurless ou
    // dédiée). Sur une instance qui n'expose pas cette route, on omet le champ.
    specifications: '/tablesdb/specifications',
  },
  databases: {
    label: 'Databases (API héritée 1.x)',
    listDatabases: '/databases?limit=1',
    database: (db) => `/databases/${db}`,
    createDatabase: () => ({ path: '/databases', body: { databaseId: DATABASE_ID, name: 'ENISE Docs' } }),
    specifications: null,
    table: (db, table) => `/databases/${db}/collections/${table.id}`,
    createTable: (db, table) => ({
      path: `/databases/${db}/collections`,
      body: {
        collectionId: table.id,
        name: table.name,
        permissions: table.permissions,
        documentSecurity: table.rowSecurity,
        enabled: true,
      },
    }),
    updatePermissions: (db, table) => ({
      path: `/databases/${db}/collections/${table.id}`,
      body: { permissions: table.permissions },
    }),
    column: (db, table, column) => ({
      path: `/databases/${db}/collections/${table.id}/attributes/${column.type}`,
      body: { key: column.key, ...strip(column, 'type') },
    }),
    columnPath: (db, table, column) => `/databases/${db}/collections/${table.id}/attributes/${column.key}`,
    index: (db, table, index) => ({
      path: `/databases/${db}/collections/${table.id}/indexes/${index.type}`,
      body: { key: index.key, attributes: index.columns },
    }),
    indexPath: (db, table, index) => `/databases/${db}/collections/${table.id}/indexes/${index.key}`,
    flavor: 'databases',
  },
};

function strip(object, ...keys) {
  const copy = { ...object };
  for (const key of keys) delete copy[key];
  return copy;
}

class ApiError extends Error {
  constructor(message, details) {
    super(message);
    Object.assign(this, details);
  }
}

/** --diagnose et --status doivent interroger le réseau réel, même en dry-run. */
const NETWORK_PROBE = DIAGNOSE || STATUS;

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
    throw new ApiError(`${cause}`, { transport: true, method, path, url, cause });
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

/** Message actionnable : distinguer le réseau, le proxy, la route et l'autorisation. */
function explain(error) {
  if (error.transport) {
    return [
      `aucune route réseau vers ${API_BASE} (${error.cause}).`,
      `  L’API Appwrite n’est pas joignable depuis ce poste : egress filtré (TLS coupé) ou proxy d’entreprise.`,
      `  Vérifie avec :  curl -i ${API_BASE}/ping`,
      '  Si un proxy est requis :  HTTPS_PROXY="http://127.0.0.1:port" npm run appwrite:setup',
      '  Sinon, provisionne depuis la console (checklist docs/APPWRITE_AUTH_PLAN.md §3.2) ou',
      '  depuis une machine qui joint Internet, puis relance ce script avec --status.',
    ].join('\n');
  }
  if (error.status === 404 && !error.isJson) {
    const { fromAppwrite } = looksLikeAppwriteResponse({ server: error.server, contentType: error.contentType });
    if (fromAppwrite) {
      return [
        `${error.method} ${error.url} → Appwrite a répondu (en-tête server = ${error.server}) mais ne connaît pas cette route.`,
        `  content-type = ${error.contentType} (page HTML du Console, pas l’API).`,
        '  L’accès sortant fonctionne donc : c’est la ROUTE qui est fausse.',
        `  Base utilisée = ${API_BASE} ; elle doit finir par un unique /v1`,
        '  (ex. https://fra.cloud.appwrite.io/v1). Un …/v1/v1 est le cas classique.',
      ].join('\n');
    }
    return [
      `${error.method} ${error.url} → 404 texte, pas du JSON : ce n’est pas l’API Appwrite qui répond.`,
      `  serveur = ${error.server || 'inconnu'}, content-type = ${error.contentType || 'aucun'}`,
      '  corps   = ' + (error.rawBody || '(vide)'),
      '  Causes classiques : egress du sandbox qui renvoie son propre 404, ou proxy.',
      '  Un 404 Appwrite légitime est TOUJOURS en JSON avec',
      '  "type":"general_route_not_found". Utilise --diagnose pour trancher.',
    ].join('\n');
  }
  if (error.status === 404) {
    return `${error.method} ${error.path} → 404 (${error.type || 'general_route_not_found'}) : cette route n’existe pas sur cette instance. Bascule avec --flavor=${otherFlavor(FLAVOR) || 'databases'}.`;
  }
  if (error.status === 401) return `401 : APPWRITE_API_KEY absente, expirée ou révoquée (${error.method} ${error.path}).`;
  if (error.status === 403) return `403 : la clé n’a pas le scope nécessaire (databases:write) pour ${error.method} ${error.path}.`;
  if (error.status === 429) return '429 : limite de débit atteinte, réessaie dans une minute.';
  return `${error.method ?? ''} ${error.path ?? ''} → ${error.message}`.trim();
}

function otherFlavor(flavor) {
  return flavor === 'tablesdb' ? 'databases' : flavor === 'databases' ? 'tablesdb' : null;
}

let FLAVOR = null;

/**
 * Spécification à demander pour créer une base TablesDB.
 *
 * 'auto' lit /v1/tablesdb/specifications et retient la première offre serveurless
 * ; une instance qui ne sert pas cette route (ou une liste vide) donne `undefined`,
 * donc le champ est omis et le serveur applique son défaut.
 */
async function pickSpecification(listPath) {
  if (SPECIFICATION === 'none') return undefined;
  if (SPECIFICATION !== 'auto') return SPECIFICATION;
  const list = await request('GET', listPath)
    .then((payload) => (Array.isArray(payload?.specifications) ? payload.specifications : []))
    .catch(() => []);
  const serverless = list.find((item) => item?.serverless === true) ?? list.find((item) => /serverless/i.test(String(item?.slug ?? item?.id ?? '')));
  const chosen = serverless?.slug ?? serverless?.id;
  if (chosen) console.log(`  · spécification retenue : ${chosen}`);
  return chosen || undefined;
}

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
    await request('POST', postPath, body);
    console.log(`  + ${label} — créée`);
    return 'created';
  } catch (error) {
    if (error.status === 409 || error.type === 'duplicate_unique' || /already exists/i.test(error.message)) {
      console.log(`  ✓ ${label} — déjà en place (conflit ignoré)`);
      return 'exists';
    }
    // Un type d'index non supporté par le moteur ne doit pas bloquer le reste.
    if (/index/i.test(`${error.message} ${error.path}`) && /not support|invalid|unsupported/i.test(error.message)) {
      console.warn(`  ! ${label} — ignoré : ${error.message}`);
      return 'skipped';
    }
    throw error;
  }
}

/** Sonde les deux dialectes et choisit celui que l'instance sert réellement. */
async function resolveFlavor() {
  if (FLAVOR_REQUEST !== 'auto') return FLAVOR_REQUEST;
  const report = [];
  for (const name of ['tablesdb', 'databases']) {
    const spec = SPECS[name];
    try {
      await request('GET', spec.listDatabases);
      report.push([name, 'ok']);
      FLAVOR = name;
      return name;
    } catch (error) {
      if (error.transport) { report.push([name, error.cause]); throw error; }
      // 401/403 prouve que la route existe (sinon Appwrite répond 404 JSON).
      report.push([name, error.status === 404 ? `404 ${error.isJson ? 'json' : 'non-json'}` : `${error.status} (route existante)`]);
      if (error.status && error.status !== 404) { FLAVOR = name; return name; }
    }
  }
  console.warn('  ! ni /v1/tablesdb ni /v1/databases ne répondent : tablesDB indisponible,',
    'j’essaie quand même l’API héritée.');
  FLAVOR = 'databases';
  return 'databases';
}

async function diagnose() {
  console.log(`base     : ${API_BASE}`);
  console.log(`projet   : ${PROJECT}`);
  console.log(`clé      : ${API_KEY ? 'présente' : 'absente'} (len ${API_KEY.length})`);
  let ping;
  try {
    const response = await fetch(`${API_BASE}/ping`, { headers: { 'x-appwrite-project': PROJECT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = (await response.text()).slice(0, 120).replace(/\s+/g, ' ');
    ping = { status: response.status, contentType: response.headers.get('content-type'), server: response.headers.get('server'), body };
    console.log(`ping     : HTTP ${response.status} · content-type=${ping.contentType} · server=${ping.server} · corps="${body}"`);
    const { fromAppwrite } = looksLikeAppwriteResponse(ping);
    if (response.status === 200 && /^Welcome to the Appwrite REST API/.test(ping.body)) {
      console.log('           ✓ réseau et endpoint corrects (corps attendu de /ping).');
    } else if (fromAppwrite) {
      console.log('           ↑ Appwrite a répondu mais ne connaît pas cette route : la base est');
      console.log(`             suspecte (attendu ${'`'}…/v1${'`'} simple, obtenu ${'`'}${API_BASE}${'`'}).`);
    } else {
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
        : `${error.status}${error.isJson ? ' json' : ' html'}${error.status !== 404 ? ' → route existante' : ''}`;
      console.log(`route    : ${API_BASE}${path} → ${verdict}`);
    }
  }
}

async function status() {
  const spec = SPECS[FLAVOR];
  const database = await request('GET', spec.database(DATABASE_ID)).catch((error) => {
    console.log(`base ${DATABASE_ID} : ${error.status ? `absente (${error.status})` : error.cause}`);
    return null;
  });
  if (!database) return;
  console.log(`base ${DATABASE_ID} — ${database.name} (${FLAVOR})`);
  for (const table of TABLES) {
    const row = await request('GET', spec.table(DATABASE_ID, table)).catch(() => null);
    const columns = row?.columns ?? row?.attributes ?? [];
    console.log(`  ${table.id} : ${row ? `${columns.length} colonnes, sécurité par ligne=${row.rowSecurity ?? row.documentSecurity}` : 'absente'}`);
  }
}

async function drop() {
  const spec = SPECS[FLAVOR];
  for (const table of [...TABLES].reverse()) {
    await request('DELETE', spec.table(DATABASE_ID, table)).catch((error) => {
      console.warn(`  − table ${table.id} : ${error.status === 404 ? 'absente' : error.message}`);
    });
  }
  console.log('tables supprimées (la base est conservée)');
}

async function main() {
  if (PING || DIAGNOSE) {
    if (DIAGNOSE) return diagnose();
    try {
      const response = await fetch(`${API_BASE}/ping`, { headers: { 'x-appwrite-project': PROJECT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      console.log(`ping ${API_BASE} → ${response.status} ${(await response.text()).slice(0, 120)}`);
      if (!response.ok) process.exitCode = 1;
    } catch (error) {
      console.log(explain(new ApiError(String(error?.cause?.code || error?.name), { transport: true, cause: error?.cause?.code || error?.name })));
      process.exitCode = 1;
    }
    return;
  }

  if (!API_KEY && !DRY_RUN && !STATUS && !PING && !DIAGNOSE) {
    console.error(
      'APPWRITE_API_KEY manquante. Crée une clé serveur dans Console → API Keys\n'
      + '(scope databases:write) puis relance :\n'
      + '  APPWRITE_API_KEY="***" npm run appwrite:setup\n'
      + '--diagnose, --ping et --dry-run fonctionnent sans clé.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nAppwrite ${API_BASE} · projet ${PROJECT}`);
  const flavor = await resolveFlavor();
  const spec = SPECS[flavor];
  console.log(`api      : ${spec.label}${FLAVOR_REQUEST === 'auto' ? ' (auto-détectée)' : ' (imposée par --flavor)'}\n`);

  if (STATUS) return status();
  if (DROP) return drop();

  const extra = spec.specifications ? { specification: await pickSpecification(spec.specifications) } : {};
  const database = spec.createDatabase(extra);
  await ensure(spec.database(DATABASE_ID), database.path, database.body, `base ${DATABASE_ID}`);

  for (const table of TABLES) {
    console.log(`\n${spec.flavor === 'tablesdb' ? 'table' : 'collection'} ${table.id}`);
    await ensure(spec.table(DATABASE_ID, table), spec.createTable(DATABASE_ID, table).path, spec.createTable(DATABASE_ID, table).body, table.id);
    for (const column of table.columns) {
      await ensure(
        spec.columnPath(DATABASE_ID, table, column),
        spec.column(DATABASE_ID, table, column).path,
        spec.column(DATABASE_ID, table, column).body,
        `${spec.flavor === 'tablesdb' ? 'colonne' : 'attribut'} ${column.key}`,
      );
    }
    for (const index of table.indexes) {
      await ensure(
        spec.indexPath(DATABASE_ID, table, index),
        spec.index(DATABASE_ID, table, index).path,
        spec.index(DATABASE_ID, table, index).body,
        `index ${index.key}`,
      );
    }
    // Les permissions ne sont pas lisibles par un GET simple : on les pose à chaque run.
    const permissions = spec.updatePermissions(DATABASE_ID, table);
    if (DRY_RUN) {
      console.log(`  · permissions → PATCH ${permissions.path} ${JSON.stringify(permissions.body)}`);
    } else {
      await request('PATCH', permissions.path, permissions.body)
        .then(() => console.log('  ✓ permissions appliquées'))
        .catch((error) => console.warn(`  ! permissions : ${explain(error).split('\n')[0]}`));
    }
  }

  console.log([
    '',
    'À faire ensuite',
    '---------------',
    '1. Variables publiques du build :',
    `   VITE_APPWRITE_DATABASE_ID="${DATABASE_ID}"`,
    '   VITE_APPWRITE_PROFILE_TABLE_ID="profiles"',
    '   VITE_APPWRITE_FAVORITES_TABLE_ID="favorites"',
    `   VITE_APPWRITE_FLAVOR="${flavor}"`,
    '2. Console → Settings → Domains & Platforms : ajouter le hostname du site et',
    '   localhost, sinon le navigateur bloque les appels en CORS.',
    '3. Console → Settings → Auth : mot de passe minimum 12 caractères, vérification',
    '   d’email obligatoire, sessions limitées à 5.',
    '4. Rôles : pas de colonne « role » (éditable par le client) — attribuer le label',
    '   « admin » aux comptes concernés via PUT /v1/users/{userId}/labels.',
    '',
  ].join('\n'));
}

await main().catch((error) => {
  console.error(`\n✗ ${explain(error)}`);
  if (VERBOSE && error?.stack) console.error(error.stack);
  process.exitCode = 1;
});
