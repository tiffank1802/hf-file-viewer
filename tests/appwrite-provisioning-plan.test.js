import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ROLE_CREATE,
  ROLE_USERS,
  SPECS,
  TABLES,
  buildPlan,
  columnDrift,
  enumColumns,
  isPendingResourceError,
  permissionsDrift,
  isValidAppwriteUid,
  validateModel,
  withPendingRetry,
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
  assert.deepEqual(table.body.permissions, ['create("users")', 'read("users")'],
    'l’API héritée ne lit pas les permissions par GET : elles sont à la création');
  assert.equal(ROLE_CREATE, ROLE_USERS, 'create doit rester ouvert aux non-vérifiés : un compte neuf écrit sa propre ligne avant de vérifier son email');

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

test('routes d’écriture : PUT sur la table (PATCH répond 404), PATCH sur la colonne enum', () => {
  // `updateTable` n'existe qu'en PUT et exige `name` ; un PATCH sur ce chemin
  // renvoie la page 404 du Console, ce qui ressemble à s'y méprendre à un
  // problème de route ou de réseau. `updateEnumColumn`, lui, est un PATCH sur
  // `columns/enum/{key}` — il n'y a PAS de sous-route `/elements` en TablesDB.
  const table = TABLES[0];
  const column = table.columns.find((c) => c.key === 'filiere');
  for (const [flavor, root, noun, security] of [
    ['tablesdb', '/tablesdb', 'tables', 'rowSecurity'],
    ['databases', '/databases', 'collections', 'documentSecurity'],
  ]) {
    const spec = SPECS[flavor];
    const permissions = spec.updatePermissions('db', table);
    assert.equal(permissions.method, 'PUT', `${flavor} : updateTable est un PUT`);
    assert.equal(permissions.path, `${root}/db/${noun}/profiles`);
    assert.equal(permissions.body.name, table.name, `${flavor} : name est obligatoire`);
    assert.equal(permissions.body[security], true, `${flavor} : la sécurité par ligne doit être renvoyée, pas effacée`);
    assert.ok(Array.isArray(permissions.body.permissions) && permissions.body.permissions.length);

    const enumFix = spec.enumElements('db', table, column);
    assert.equal(enumFix.method, 'PATCH');
    assert.doesNotMatch(enumFix.path, /\/elements$/, `${flavor} : pas de sous-route /elements`);
    assert.deepEqual(Object.keys(enumFix.body).sort(), ['default', 'elements', 'required'],
      `${flavor} : les trois paramètres requis de updateEnumColumn`);
    assert.equal(enumFix.body.default, 'GM');
  }
});

test('permissionsDrift distingue table muette, modèle non appliqué et lecture seule', () => {
  const model = ['create("users")', 'read("users")'];
  assert.deepEqual(permissionsDrift(model, []), { empty: true, noCreate: false, missing: model, aligned: false });
  assert.equal(permissionsDrift(model, model).aligned, true);
  // Le PUT n'est jamais passé : la table reste sans create, le profil ne s'écrit pas.
  assert.equal(permissionsDrift(model, ['read("users")']).noCreate, true);
  // Le modèle a changé depuis l'application (users/verified → users).
  const stale = permissionsDrift(model, ['create("users/verified")', 'read("users")']);
  assert.deepEqual(stale.missing, ['create("users")']);
  assert.equal(stale.empty, false);
});

test('une ressource « pas encore disponible » est retentée, un modèle faux ne l’est jamais', async () => {
  // De vraies `Error` : c'est ce que le script propage (AppwriteException et
  // ApiError héritent d'Error), et `assert.rejects(fn, /re/)` teste String(erreur).
  const pending = Object.assign(new Error("The requested column 'pathKey' is not yet available. Please try again later."), { status: 400 });
  const model = Object.assign(new Error('Cannot set default value for required column'), { status: 400 });
  assert.equal(isPendingResourceError(pending), true);
  assert.equal(isPendingResourceError(model), false);
  assert.equal(isPendingResourceError(Object.assign(new Error('index is being created'), { status: 409 })), true);
  assert.equal(isPendingResourceError(undefined), false);

  let calls = 0;
  const log = [];
  const outcome = await withPendingRetry(async () => {
    calls += 1;
    if (calls < 3) throw pending;
    return 'créé';
  }, 'index uniq_favorite_user_path', { attempts: 5, delayMs: 1, log: (line) => log.push(line) });
  assert.equal(outcome, 'créé');
  assert.equal(calls, 3);
  assert.equal(log.length, 2, 'une ligne de log par attente');

  let stubborn = 0;
  await assert.rejects(
    () => withPendingRetry(async () => {
      stubborn += 1;
      throw model;
    }, 'colonne', { attempts: 4, delayMs: 1, log: () => {} }),
    /Cannot set default value/,
  );
  assert.equal(stubborn, 1, 'une erreur de modèle n’est pas une raison de réessayer');

  let exhausted = 0;
  await assert.rejects(() => withPendingRetry(async () => {
    exhausted += 1;
    throw pending;
  }, 'index', { attempts: 3, delayMs: 1, log: () => {} }));
  assert.equal(exhausted, 3, 'on borne le nombre de tentatives');
});

test('les permissions sont toujours la dernière opération de chaque table', () => {
  for (const flavor of ['tablesdb', 'databases']) {
    const plan = planFor(flavor);
    for (const table of TABLES) {
      const owned = plan.filter((op) => op.parent === table.id || (op.group === 'table' && op.label === table.id));
      assert.equal(owned.at(-1).group, 'permissions', `${flavor}/${table.id} : ordre des opérations`);
      assert.equal(owned.at(-1).method, 'PUT');
    }
  }
});

test('le modèle respecte les règles que le serveur applique', () => {
  // 400 « Cannot set default value for required column » : confluence exacte du
  // plantage rencontré, où quatre colonnes portaient un défaut tout en étant
  // obligatoires. Le validateur local doit le refuser avant tout appel réseau.
  assert.deepEqual(
    TABLES.flatMap((table) => table.columns.filter((c) => c.required && c.default !== undefined).map((c) => `${table.id}.${c.key}`)),
    [],
  );
  // Seules les invariants écrites par le code restent obligatoires.
  assert.deepEqual(
    TABLES.flatMap((table) => table.columns.filter((c) => c.required).map((c) => `${table.id}.${c.key}`)).sort(),
    ['favorites.filePath', 'favorites.pathKey', 'favorites.userId', 'profiles.userId'],
  );
  for (const { table, column } of enumColumns(TABLES)) {
    assert.ok(column.elements.includes(column.default), `${table.id}.${column.key} : défaut hors enum`);
  }

  const invalide = [{ id: 't', name: 'T', columns: [{ type: 'string', key: 'a', size: 8, required: true, default: '' }], indexes: [] }];
  assert.throws(() => validateModel(invalide), /Cannot set default value for required column/);
  // Colonne système autorisée dans un index sans être déclarée.
  assert.doesNotThrow(() => validateModel([{
    id: 't', name: 'T',
    columns: [{ type: 'string', key: 'a', size: 8, required: true }],
    indexes: [{ key: 'idx_a_created', type: 'key', columns: ['a', '$createdAt'] }],
  }]));
  assert.throws(() => validateModel([{
    id: 't', name: 'T',
    columns: [{ type: 'string', key: 'a', size: 8, required: true }],
    indexes: [{ key: 'idx_bad', type: 'hash', columns: ['a'] }],
  }]), /type d'index « hash » inconnu/);
  // buildPlan appelle le validateur : pas de plan partiel sur un modèle faux.
  assert.throws(() => buildPlan({ spec: SPECS.tablesdb, databaseId: DB, tables: invalide }), /Modèle de provisioning invalide/);
});

test('columnDrift voit une définition modifiée après création', () => {
  const profiles = TABLES.find((t) => t.id === 'profiles');
  const displayName = profiles.columns.find((c) => c.key === 'displayName');
  assert.deepEqual(columnDrift(displayName, { key: 'displayName', required: true, size: 128, default: '' }), {
    required: { expected: false, actual: true },
  });
  assert.equal(columnDrift(displayName, { key: 'displayName', required: false, size: 128, default: '' }), null);
  // Une colonne absente de la base n'est pas une dérive : le run la créera.
  assert.equal(columnDrift(displayName, undefined), null);
});
