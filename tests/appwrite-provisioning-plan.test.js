import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TABLES,
  SPECS,
  buildPlan,
  isValidAppwriteUid,
} from '../scripts/appwrite-spec.js';

const DB = 'enise_docs';
const planFor = (flavor) => buildPlan({ spec: SPECS[flavor], databaseId: DB });

test('aucun chemin généré ne porte un objet sérialisé (régression [object Object])', () => {
  for (const flavor of ['tablesdb', 'databases']) {
    for (const op of planFor(flavor)) {
      for (const path of [op.get, op.post, op.patch].filter(Boolean)) {
        assert.doesNotMatch(path, /\[object Object\]/, `${flavor} ${op.label} → ${path}`);
        assert.doesNotMatch(path, /undefined|NaN/, `${flavor} ${op.label} → ${path}`);
        // Toute route de l'API part de /tablesdb ou /databases ; la création de
        // base se fait sur la collection elle-même (/tablesdb), sans id de base.
        assert.match(path, /^\/(tablesdb|databases)(\/enise_docs)?(\/|$)/, `${flavor} ${op.label} → ${path}`);
      }
    }
  }
});

test('les identifiants soumis à Appwrite respectent la contrainte d’UID', () => {
  for (const table of TABLES) {
    assert.ok(isValidAppwriteUid(table.id), `table ${table.id}`);
    for (const column of table.columns) assert.ok(isValidAppwriteUid(column.key), `colonne ${column.key}`);
    for (const index of table.indexes) assert.ok(isValidAppwriteUid(index.key), `index ${index.key}`);
  }
  assert.ok(isValidAppwriteUid(DB));
  // Segments d'UID dans les chemins construits.
  for (const flavor of ['tablesdb', 'databases']) {
    for (const op of planFor(flavor)) {
      const segments = [op.get, op.post, op.patch]
        .filter(Boolean)
        .flatMap((path) => path.match(/\/(?:tables|collections|columns|attributes|indexes)\/([^/?]+)/g) || [])
        .map((match) => match.split('/').pop())
        // Les types d'attribut et d'index sont des littéraux d'API, pas des UID.
        .filter((segment) => !['string', 'integer', 'bigint', 'float', 'boolean', 'datetime', 'email', 'enum', 'ip', 'url', 'relationship', 'unique', 'key', 'fulltext', 'spatial'].includes(segment));
      for (const segment of segments) {
        assert.ok(isValidAppwriteUid(segment), `${flavor} ${op.label} : segment invalide « ${segment} »`);
      }
    }
  }
});

test('TablesDB : tables/colonnes/indexes dans le vocabulaire 2.x', () => {
  const plan = planFor('tablesdb');
  assert.deepEqual(plan[0], {
    label: `base ${DB}`,
    group: 'database',
    get: '/tablesdb/enise_docs',
    post: '/tablesdb',
    body: { databaseId: DB, name: 'ENISE Docs' },
  });

  const table = plan.find((op) => op.group === 'table');
  assert.equal(table.get, '/tablesdb/enise_docs/tables/profiles');
  assert.equal(table.post, '/tablesdb/enise_docs/tables');
  assert.deepEqual(table.body, { tableId: 'profiles', name: 'Profils étudiants', rowSecurity: true, enabled: true });

  const userId = plan.find((op) => op.group === 'column' && op.body.key === 'userId');
  assert.equal(userId.get, '/tablesdb/enise_docs/tables/profiles/columns/userId');
  assert.equal(userId.post, '/tablesdb/enise_docs/tables/profiles/columns/string');
  assert.deepEqual(userId.body, { key: 'userId', size: 36, required: true });

  const unique = plan.find((op) => op.group === 'index' && op.body.key === 'uniq_profile_user');
  assert.equal(unique.post, '/tablesdb/enise_docs/tables/profiles/indexes');
  assert.deepEqual(unique.body, { key: 'uniq_profile_user', type: 'unique', columns: ['userId'] });
});

test('API héritée : collections/attributs/documentSecurity dans le vocabulaire 1.x', () => {
  const plan = planFor('databases');
  const table = plan.find((op) => op.group === 'table');
  assert.equal(table.get, '/databases/enise_docs/collections/profiles');
  assert.equal(table.post, '/databases/enise_docs/collections');
  assert.equal(table.body.collectionId, 'profiles');
  assert.equal(table.body.documentSecurity, true, 'l’équivalent de rowSecurity doit être posé');
  assert.deepEqual(table.body.permissions, ['create("users/verified")', 'read("users")'],
    'l’API héritée ne lit pas les permissions par GET : elles sont au création');

  const column = plan.find((op) => op.group === 'column' && op.body.key === 'filePath');
  assert.equal(column.post, '/databases/enise_docs/collections/favorites/attributes/string');
  assert.doesNotMatch(column.post, /\/columns\//);

  const index = plan.find((op) => op.group === 'index' && op.body.key === 'uniq_favorite_user_path');
  assert.equal(index.post, '/databases/enise_docs/collections/favorites/indexes/unique');
  assert.deepEqual(index.body, { key: 'uniq_favorite_user_path', attributes: ['userId', 'pathKey'] });
});

test('aucun index unique ne porte une colonne longue', () => {
  // Un index unique sur 1024 caractères est refusé par le moteur : on passe
  // par la clé de empreinte `pathKey`.
  for (const table of TABLES) {
    const byKey = new Map(table.columns.map((column) => [column.key, column]));
    for (const index of table.indexes.filter((item) => item.type === 'unique')) {
      for (const key of index.columns) {
        const size = byKey.get(key)?.size ?? 0;
        assert.ok(size <= 64, `${table.id}.${index.key} repose sur ${key} (taille ${size})`);
      }
    }
  }
  assert.ok(TABLES.find((t) => t.id === 'favorites').columns.some((c) => c.key === 'pathKey'));
});

test('les permissions sont toujours la dernière opération de chaque table', () => {
  for (const flavor of ['tablesdb', 'databases']) {
    const plan = planFor(flavor);
    for (const table of TABLES) {
      const owned = plan.filter((op) => op.parent === table.id || (op.group === 'table' && op.label === table.id));
      assert.equal(owned.at(-1).group, 'permissions', `${flavor}/${table.id} : ordre des opérations`);
      assert.equal(owned.at(-1).method, 'PATCH');
    }
  }
});
