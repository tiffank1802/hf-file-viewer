/**
 * Modèle et traductions REST du provisioning Appwrite.
 *
 * Séparé de `appwrite-setup.mjs` pour être testable sans réseau : chaque chemin
 * et chaque corps généré est vérifié en unit test. Un `tableId` passé comme
 * objet plutôt que comme chaîne produisait en effet `/tables/[object Object]`,
 * rejeté par Appwrite comme UID invalide — exactement le plantage rencontré.
 */

import { PROFILE_FILIERES, PROFILE_PROMOTIONS } from '../src/config.js';

/**
 * Rôles Appwrite, au format littéral attendu par l'API.
 *
 * Les `enum` de `profiles` viennent de `src/config.js` (PROFILE_PROMOTIONS,
 * PROFILE_FILIERES) : le formulaire et la table partagent une seule liste.
 */
export const ROLE_USERS = 'users';
export const ROLE_USERS_VERIFIED = 'users/verified';

/** Colonnes et index communs aux deux dialectes ; seule la traduction change. */
export const TABLES = [
  {
    id: 'profiles',
    name: 'Profils étudiants',
    rowSecurity: true,
    permissions: [`create("${ROLE_USERS_VERIFIED}")`, `read("${ROLE_USERS}")`],
    columns: [
      { type: 'string', key: 'userId', size: 36, required: true },
      { type: 'string', key: 'displayName', size: 128, required: true, default: '' },
      { type: 'enum', key: 'promotion', elements: [...PROFILE_PROMOTIONS], required: true, default: PROFILE_PROMOTIONS[0] },
      { type: 'enum', key: 'filiere', elements: [...PROFILE_FILIERES], required: true, default: PROFILE_FILIERES[0] },
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

/**
 * Une « table » (2.x) et une « collection » (1.x) sont le même objet.
 *
 * `ensure()` ne fait que créer ce qui manque : une colonne déjà présente avec un
 * `enum` périmé (filière ajoutée après coup, par exemple) resterait fausse, et
 * le serveur refuserait la valeur du formulaire. `enumDrift()` compare la
 * déclaration aux éléments réellement stockés, `--fix-enums` les réaligne.
 */
export const SPECS = {
  tablesdb: {
    label: 'TablesDB (API 2.x)',
    flavor: 'tablesdb',
    noun: 'table',
    listDatabases: '/tablesdb?limit=1',
    specifications: '/tablesdb/specifications',
    database: (db) => `/tablesdb/${db}`,
    createDatabase: (db, extra) => ({ path: '/tablesdb', body: { databaseId: db, name: 'ENISE Docs', ...extra } }),
    tablePath: (db, table) => `/tablesdb/${db}/tables/${table.id}`,
    createTable: (db, table) => ({
      path: `/tablesdb/${db}/tables`,
      body: { tableId: table.id, name: table.name, rowSecurity: table.rowSecurity, enabled: true },
    }),
    updatePermissions: (db, table) => ({ path: `/tablesdb/${db}/tables/${table.id}`, body: { permissions: table.permissions } }),
    column: (db, table, column) => ({
      path: `/tablesdb/${db}/tables/${table.id}/columns/${column.type}`,
      body: { key: column.key, ...omit(column, 'type') },
    }),
    columnPath: (db, table, column) => `/tablesdb/${db}/tables/${table.id}/columns/${column.key}`,
    enumElements: (db, table, column) => ({
      path: `/tablesdb/${db}/tables/${table.id}/columns/enum/${column.key}/elements`,
      body: { elements: [...column.elements] },
    }),
    index: (db, table, index) => ({
      path: `/tablesdb/${db}/tables/${table.id}/indexes`,
      body: { key: index.key, type: index.type, columns: index.columns },
    }),
    indexPath: (db, table, index) => `/tablesdb/${db}/tables/${table.id}/indexes/${index.key}`,
  },
  databases: {
    label: 'Databases (API héritée 1.x)',
    flavor: 'databases',
    noun: 'collection',
    listDatabases: '/databases?limit=1',
    specifications: null,
    database: (db) => `/databases/${db}`,
    createDatabase: (db) => ({ path: '/databases', body: { databaseId: db, name: 'ENISE Docs' } }),
    tablePath: (db, table) => `/databases/${db}/collections/${table.id}`,
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
      body: { key: column.key, ...omit(column, 'type') },
    }),
    columnPath: (db, table, column) => `/databases/${db}/collections/${table.id}/attributes/${column.key}`,
    enumElements: (db, table, column) => ({
      path: `/databases/${db}/collections/${table.id}/attributes/enum/${column.key}/elements`,
      body: { elements: [...column.elements] },
    }),
    index: (db, table, index) => ({
      path: `/databases/${db}/collections/${table.id}/indexes/${index.type}`,
      body: { key: index.key, attributes: index.columns },
    }),
    indexPath: (db, table, index) => `/databases/${db}/collections/${table.id}/indexes/${index.key}`,
  },
};

export function omit(object, ...keys) {
  const copy = { ...object };
  for (const key of keys) delete copy[key];
  return copy;
}

/**
 * Plan d'exécution complet : une entrée par opération, dans l'ordre.
 *
 * Le script consomme ce plan pour `--dry-run`, `--status`, `--drop` et le run
 * réel : les quatre chemins ne peuvent plus diverger, et un chemin faux est
 * visible en test plutôt qu'au premier appel réseau.
 */
export function buildPlan({ spec, databaseId, tables = TABLES }) {
  const operations = [{
    label: `base ${databaseId}`,
    group: 'database',
    get: spec.database(databaseId),
    post: spec.createDatabase(databaseId).path,
    body: spec.createDatabase(databaseId).body,
  }];

  for (const table of tables) {
    operations.push({
      label: table.id,
      group: 'table',
      get: spec.tablePath(databaseId, table),
      post: spec.createTable(databaseId, table).path,
      body: spec.createTable(databaseId, table).body,
    });
    for (const column of table.columns) {
      operations.push({
        label: `${spec.noun === 'collection' ? 'attribut' : 'colonne'} ${column.key}`,
        group: 'column',
        parent: table.id,
        get: spec.columnPath(databaseId, table, column),
        post: spec.column(databaseId, table, column).path,
        body: spec.column(databaseId, table, column).body,
      });
    }
    for (const index of table.indexes) {
      operations.push({
        label: `index ${index.key}`,
        group: 'index',
        parent: table.id,
        get: spec.indexPath(databaseId, table, index),
        post: spec.index(databaseId, table, index).path,
        body: spec.index(databaseId, table, index).body,
      });
    }
    operations.push({
      label: 'permissions',
      group: 'permissions',
      parent: table.id,
      method: 'PATCH',
      patch: spec.updatePermissions(databaseId, table).path,
      body: spec.updatePermissions(databaseId, table).body,
    });
  }

  return operations;
}

/** Toutes les colonnes `enum` du modèle, avec leur table. */
export function enumColumns(tables = TABLES) {
  const out = [];
  for (const table of tables) {
    for (const column of table.columns.filter((item) => item.type === 'enum')) out.push({ table, column });
  }
  return out;
}

/** Éléments d'enum renvoyés par l'API (formes 2.x `elements`, 1.x `enum`). */
export function liveEnumElements(column) {
  const found = column?.elements ?? column?.enum ?? column?.data?.elements;
  return Array.isArray(found) ? found : null;
}

/** `{ missing: [...], extra: [...] }` entre la déclaration et la base. */
export function enumDrift(declared, live) {
  const actual = liveEnumElements(live);
  if (!actual) return null;
  const missing = declared.elements.filter((element) => !actual.includes(element));
  const extra = actual.filter((element) => !declared.elements.includes(element));
  return missing.length || extra.length ? { missing, extra } : null;
}

/** UID Appwrite : 36 caractères max, sans underscore initial, [a-zA-Z0-9_.-]. */
export function isValidAppwriteUid(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 36
    && !value.startsWith('_')
    && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value);
}
