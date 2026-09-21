#!/usr/bin/env node
/**
 * Provisioning Appwrite pour ENISE Docs : base TablesDB `enise_docs`, tables
 * `profiles` et `favorites`, colonnes, index et permissions.
 *
 * Idempotent : chaque création est précédée d'une lecture, un conflit (409) est
 * ignoré. Relançable après une interruption.
 *
 *   APPWRITE_API_KEY="clé serveur" node scripts/appwrite-setup.mjs
 *   APPWRITE_API_KEY="…" node scripts/appwrite-setup.mjs --dry-run   # affiche les appels
 *   node scripts/appwrite-setup.mjs --ping                            # réseau + projet
 *   node scripts/appwrite-setup.mjs --status                          # ce qui existe
 *   node scripts/appwrite-setup.mjs --drop                            # supprime les tables
 *
 * Scopes minimaux de la clé : databases:write (et users:read si tu ajoutes des
 * rôles plus tard). La clé ne doit JAMAIS être commitée ni porter un préfixe
 * VITE_ : elle atterrirait dans le bundle du navigateur.
 */
import { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID } from '../src/config.js';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const DROP = args.has('--drop');
const PING = args.has('--ping');
const STATUS = args.has('--status');

const ENDPOINT = (process.env.APPWRITE_ENDPOINT || APPWRITE_ENDPOINT).replace(/\/$/, '');
const PROJECT = process.env.APPWRITE_PROJECT_ID || APPWRITE_PROJECT_ID;
const API_KEY = process.env.APPWRITE_API_KEY || '';
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID || 'enise_docs';

/** Rôles Appwrite, au format littéral attendu par l'API. */
const ROLE_USERS = 'users';
const ROLE_USERS_VERIFIED = 'users/verified';

const TABLES = [
  {
    id: 'profiles',
    name: 'Profils étudiants',
    rowSecurity: true,
    permissions: [`create("${ROLE_USERS_VERIFIED}")`, `read("${ROLE_USERS}")`],
    columns: [
      { path: 'string', key: 'userId', size: 36, required: true },
      { path: 'string', key: 'displayName', size: 128, required: true, default: '' },
      { path: 'enum', key: 'promotion', elements: ['3A', '4A', '5A', 'Alumni', 'Staff'], required: true, default: '3A' },
      { path: 'enum', key: 'filiere', elements: ['GM', 'TOEIC', 'Autre'], required: true, default: 'GM' },
      { path: 'string', key: 'bio', size: 280, required: false, default: '' },
      { path: 'boolean', key: 'emailVerified', required: true, default: false },
      { path: 'datetime', key: 'lastSeenAt', required: false },
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
      { path: 'string', key: 'userId', size: 36, required: true },
      { path: 'string', key: 'filePath', size: 1024, required: true },
      { path: 'string', key: 'pathKey', size: 64, required: true },
      { path: 'enum', key: 'kind', elements: ['file', 'folder'], required: true, default: 'file' },
      { path: 'string', key: 'title', size: 240, required: false, default: '' },
      { path: 'string', key: 'note', size: 280, required: false, default: '' },
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

async function call(method, path, body) {
  const url = `${ENDPOINT}/v1${path}`;
  if (DRY_RUN) return { __dryRun: true };
  const response = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-appwrite-project': PROJECT,
      ...(API_KEY ? { 'x-appwrite-key': API_KEY } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { /* réponse non JSON (proxy, 502…) */ }
  if (!response.ok) {
    throw Object.assign(new Error(payload?.message || `${response.status} ${response.statusText}`), {
      status: response.status, type: payload?.type, method, path,
    });
  }
  return payload;
}

/** GET puis POST : renvoie 'created' | 'exists' | 'skipped' | 'planned'. */
async function ensure(getPath, postPath, body, label) {
  if (DRY_RUN) {
    console.log(`  · ${label} → POST ${postPath} ${JSON.stringify(body)}`);
    return 'planned';
  }
  try {
    await call('GET', getPath);
    console.log(`  ✓ ${label} — déjà en place`);
    return 'exists';
  } catch (error) {
    if (error.status !== 404 && error.status !== 403) throw error;
    if (error.status === 403 && !DRY_RUN) {
      console.warn(`  ! ${label} — illisible avec cette clé, création tentée`);
    }
  }
  try {
    await call('POST', postPath, body);
    console.log(`  + ${label} — créée`);
    return 'created';
  } catch (error) {
    if (error.status === 409 || error.type === 'duplicate_unique' || /already exists/i.test(error.message)) {
      console.log(`  ✓ ${label} — déjà en place (conflit ignoré)`);
      return 'exists';
    }
    // Un type d'index non supporté par le moteur ne doit pas bloquer le reste.
    if (/index/i.test(error.message) && /not support|invalid|unsupported/i.test(error.message)) {
      console.warn(`  ! ${label} — ignoré : ${error.message}`);
      return 'skipped';
    }
    throw error;
  }
}

async function ping() {
  const response = await fetch(`${ENDPOINT}/v1/ping`, { headers: { 'x-appwrite-project': PROJECT } });
  console.log(`ping ${ENDPOINT} → ${response.status} ${await response.text()}`);
  if (!response.ok) process.exitCode = 1;
}

async function status() {
  const database = await call('GET', `/tablesdb/${DATABASE_ID}`).catch((error) => {
    console.log(`base ${DATABASE_ID} : absente (${error.status ?? error.message})`);
    return null;
  });
  if (!database) return;
  console.log(`base ${DATABASE_ID} : ${database.name}`);
  for (const table of TABLES) {
    const row = await call('GET', `/tablesdb/${DATABASE_ID}/tables/${table.id}`).catch(() => null);
    console.log(`  table ${table.id} : ${row ? `${row.columns?.length ?? '?'} colonnes, rowSecurity=${row.rowSecurity}` : 'absente'}`);
  }
}

async function drop() {
  for (const table of [...TABLES].reverse()) {
    await call('DELETE', `/tablesdb/${DATABASE_ID}/tables/${table.id}`).catch((error) => {
      console.warn(`  − table ${table.id} : ${error.status === 404 ? 'absente' : error.message}`);
    });
  }
  console.log('tables supprimées (la base est conservée)');
}

async function main() {
  if (PING) return ping();

  if (!API_KEY && !DRY_RUN) {
    console.error(
      'APPWRITE_API_KEY manquante. Crée une clé serveur dans Console → API Keys\n'
      + '(scopes databases:write) puis relance :\n'
      + '  APPWRITE_API_KEY="…" node scripts/appwrite-setup.mjs\n'
      + 'Utilise --dry-run pour voir les appels sans clé, --ping pour tester le réseau.',
    );
    process.exitCode = 1;
    return;
  }

  if (STATUS) return status();
  if (DROP) return drop();

  console.log(`\nAppwrite ${ENDPOINT} · projet ${PROJECT}\n`);
  await ensure(`/tablesdb/${DATABASE_ID}`, '/tablesdb', { databaseId: DATABASE_ID, name: 'ENISE Docs' }, `base ${DATABASE_ID}`);

  for (const table of TABLES) {
    console.log(`\ntable ${table.id}`);
    await ensure(
      `/tablesdb/${DATABASE_ID}/tables/${table.id}`,
      `/tablesdb/${DATABASE_ID}/tables`,
      { tableId: table.id, name: table.name, rowSecurity: table.rowSecurity, enabled: true },
      table.id,
    );
    for (const column of table.columns) {
      const { path, ...body } = column;
      await ensure(
        `/tablesdb/${DATABASE_ID}/tables/${table.id}/columns/${body.key}`,
        `/tablesdb/${DATABASE_ID}/tables/${table.id}/columns/${path}`,
        { key: body.key, ...body },
        `colonne ${body.key}`,
      );
    }
    for (const index of table.indexes) {
      await ensure(
        `/tablesdb/${DATABASE_ID}/tables/${table.id}/indexes/${index.key}`,
        `/tablesdb/${DATABASE_ID}/tables/${table.id}/indexes`,
        { key: index.key, type: index.type, columns: index.columns },
        `index ${index.key}`,
      );
    }
    // Les permissions ne peuvent pas être lues par un GET simple : on les pose à chaque run.
    await call('PATCH', `/tablesdb/${DATABASE_ID}/tables/${table.id}`, { permissions: table.permissions })
      .then(() => {
        if (DRY_RUN) console.log(`  · permissions → PATCH /tablesdb/${DATABASE_ID}/tables/${table.id} ${JSON.stringify({ permissions: table.permissions })}`);
        else console.log('  ✓ permissions de table appliquées');
      })
      .catch((error) => console.warn(`  ! permissions : ${error.message}`));
  }

  console.log([
    '',
    'À faire ensuite',
    '---------------',
    `1. Variables publiques du build (déjà codées en dur dans src/config.js) :`,
    `   VITE_APPWRITE_DATABASE_ID="${DATABASE_ID}"`,
    '   VITE_APPWRITE_PROFILE_TABLE_ID="profiles"',
    '   VITE_APPWRITE_FAVORITES_TABLE_ID="favorites"',
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
  console.error(`\n✗ ${error.method ? `${error.method} ${error.path} → ` : ''}${error.message}`);
  if (error.status === 401) console.error('  La clé serveur est manquante, expirée ou sans scope suffisant.');
  process.exitCode = 1;
});
