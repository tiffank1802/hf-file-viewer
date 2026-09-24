/**
 * Modèle et traductions REST du provisioning Appwrite.
 *
 * Séparé de `appwrite-setup.mjs` pour être testable sans réseau : chaque chemin
 * et chaque corps généré est vérifié en unit test. Un `tableId` passé comme
 * objet plutôt que comme chaîne produisait en effet `/tables/[object Object]`,
 * rejeté par Appwrite comme UID invalide — exactement le plantage rencontré.
 */

const PROFILE_PROMOTIONS = ['3A', '4A', '5A', 'Alumni', 'Staff'];
const PROFILE_FILIERES = ['GM', 'GC', 'GP', 'Autre'];

/**
 * Rôles Appwrite, au format littéral attendu par l'API.
 *
 * Les `enum` de `profiles` viennent de `src/config.js` (PROFILE_PROMOTIONS,
 * PROFILE_FILIERES) : le formulaire et la table partagent une seule liste.
 */
export const ROLE_USERS = 'users';
export const ROLE_USERS_VERIFIED = 'users/verified';

/**
 * `create` est ouvert à `users`, pas à `users/verified`.
 *
 * Un compte qui vient de s'inscrire n'est PAS encore vérifié — l'email l'attend.
 * Avec `users/verified`, sa première écriture (sa propre ligne de profil) reçoit
 * un refus, et l'inscription laisse donc un compte dans Auth sans ligne en base :
 * exactement le « je ne vois pas mon compte dans la base de données » rencontré.
 * Ce n'est pas une ouverture de sécurité : les permissions de LIGNE ne donnent
 * lecture/écriture qu'au propriétaire (`Role.user(userId)`), et `userId` est pris
 * sur la session, jamais sur la saisie.
 */
export const ROLE_CREATE = ROLE_USERS;

/** Colonnes et index communs aux deux dialectes ; seule la traduction change. */
export const TABLES = [
  {
    id: 'profiles',
    name: 'Profils étudiants',
    rowSecurity: true,
    permissions: [`create("${ROLE_CREATE}")`, `read("${ROLE_USERS}")`],
    columns: [
      // Seules les colonnes que le code écrit toujours restent obligatoires :
      // `required: true` exclut tout `default` côté Appwrite.
      { type: 'string', key: 'userId', size: 36, required: true },
      { type: 'string', key: 'displayName', size: 128, required: false, default: '' },
      { type: 'enum', key: 'promotion', elements: [...PROFILE_PROMOTIONS], required: false, default: PROFILE_PROMOTIONS[0] },
      { type: 'enum', key: 'filiere', elements: [...PROFILE_FILIERES], required: false, default: PROFILE_FILIERES[0] },
      { type: 'string', key: 'bio', size: 280, required: false, default: '' },
      { type: 'boolean', key: 'emailVerified', required: false, default: false },
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
    permissions: [`create("${ROLE_CREATE}")`],
    columns: [
      // Seules les colonnes que le code écrit toujours restent obligatoires :
      // `required: true` exclut tout `default` côté Appwrite.
      { type: 'string', key: 'userId', size: 36, required: true },
      { type: 'string', key: 'filePath', size: 1024, required: true },
      { type: 'string', key: 'pathKey', size: 64, required: true },
      { type: 'enum', key: 'kind', elements: ['file', 'folder'], required: false, default: 'file' },
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
    // updateTable est un PUT, et `name` y est obligatoire : un PATCH sur ce
    // chemin répond 404 (page du Console), ce qui avait été lu à tort comme un
    // problème de route. rowSecurity/enabled sont renvoyés avec les valeurs du
    // modèle pour que l'appel reste idempotent et n'assouplisse rien.
    updatePermissions: (db, table) => ({
      method: 'PUT',
      path: `/tablesdb/${db}/tables/${table.id}`,
      body: {
        name: table.name,
        permissions: table.permissions,
        rowSecurity: table.rowSecurity,
        enabled: true,
      },
    }),
    column: (db, table, column) => ({
      path: `/tablesdb/${db}/tables/${table.id}/columns/${column.type}`,
      body: { key: column.key, ...omit(column, 'type') },
    }),
    columnPath: (db, table, column) => `/tablesdb/${db}/tables/${table.id}/columns/${column.key}`,
    // updateEnumColumn : elements, required et default sont tous trois requis.
    // La doc rappelle « Cannot be set when column is required » pour default —
    // la règle qui a fait échouer la création des colonnes.
    enumElements: (db, table, column) => ({
      method: 'PATCH',
      path: `/tablesdb/${db}/tables/${table.id}/columns/enum/${column.key}`,
      body: {
        elements: [...column.elements],
        required: column.required ?? false,
        default: column.default ?? '',
      },
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
      method: 'PUT',
      path: `/databases/${db}/collections/${table.id}`,
      body: {
        name: table.name,
        permissions: table.permissions,
        documentSecurity: table.rowSecurity,
        enabled: true,
      },
    }),
    column: (db, table, column) => ({
      path: `/databases/${db}/collections/${table.id}/attributes/${column.type}`,
      body: { key: column.key, ...omit(column, 'type') },
    }),
    columnPath: (db, table, column) => `/databases/${db}/collections/${table.id}/attributes/${column.key}`,
    enumElements: (db, table, column) => ({
      method: 'PATCH',
      path: `/databases/${db}/collections/${table.id}/attributes/enum/${column.key}`,
      body: {
        elements: [...column.elements],
        required: column.required ?? false,
        default: column.default ?? '',
      },
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
  validateModel(tables);
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
    const permissions = spec.updatePermissions(databaseId, table);
    operations.push({
      label: 'permissions',
      group: 'permissions',
      parent: table.id,
      method: permissions.method ?? 'PATCH',
      patch: permissions.path,
      body: permissions.body,
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

/**
 * Vérifie le modèle contre les règles qu'Appwrite applique au serveur.
 *
 * Chacune de ces erreurs a été rencontrée en réel : un `default` sur une colonne
 * `required` (400 « Cannot set default value for required column »), un `enum`
 * dont la valeur par défaut n'est pas dans la liste, un index unique posé sur une
 * colonne trop longue. Échouer ici coûte une ligne de log ; échouer après la
 * troisième colonne créée laisse le projet à moitié provisionné.
 */
export function validateModel(tables = TABLES) {
  const problems = [];
  for (const table of tables) {
    const byKey = new Map();
    for (const column of table.columns) {
      if (!isValidAppwriteUid(column.key)) problems.push(`${table.id}.${column.key} : clé d'UID invalide`);
      if (byKey.has(column.key)) problems.push(`${table.id}.${column.key} : colonne déclarée deux fois`);
      byKey.set(column.key, column);
      if (column.required && column.default !== undefined) {
        problems.push(`${table.id}.${column.key} : colonne requise avec une valeur par défaut — Appwrite répond « Cannot set default value for required column »`);
      }
      if (column.type === 'enum') {
        if (!Array.isArray(column.elements) || column.elements.length < 1) problems.push(`${table.id}.${column.key} : enum sans éléments`);
        if (column.default !== undefined && !column.elements.includes(column.default)) {
          problems.push(`${table.id}.${column.key} : défaut « ${column.default} » absent de l'enum`);
        }
      }
      if (['string', 'email', 'url'].includes(column.type) && column.required && !column.size && column.type === 'string') {
        problems.push(`${table.id}.${column.key} : colonne string requise sans taille`);
      }
    }
    for (const index of table.indexes) {
      if (!['key', 'fulltext', 'unique', 'spatial'].includes(index.type)) {
        problems.push(`${table.id}.${index.key} : type d'index « ${index.type} » inconnu (attendu key, fulltext, unique, spatial)`);
      }
      for (const key of index.columns) {
        if (key.startsWith('$')) continue; // colonne système : $createdAt, $updatedAt, $id
        const column = byKey.get(key);
        if (!column) { problems.push(`${table.id}.${index.key} : colonne inconnue « ${key} »`); continue; }
        if (index.type === 'unique' && (column.size ?? 0) > 64) {
          problems.push(`${table.id}.${index.key} : index unique sur ${key} (${column.size} caractères), trop long pour une clé d'index`);
        }
      }
    }
  }
  if (problems.length) throw new Error(`Modèle de provisioning invalide :\n  - ${problems.join('\n  - ')}`);
  return true;
}

/**
 * Compare les permissions d'une table lues dans la base à celles du modèle.
 *
 * Trois états méritent d'être distingués, parce qu'ils n'ont pas le même
 * symptôme côté application :
 * - `empty` : aucune permission ⇒ ni lecture ni écriture depuis le navigateur —
 *   l'inscription réussit, la ligne `profiles` n'arrive jamais ;
 * - `missing` : le modèle a changé depuis la dernière application ⇒ relancer le
 *   script (le PUT est idempotent) ;
 * - `noCreate` : des permissions existent mais aucune `create()` ⇒ lecture seule
 *   pour tous, donc profil et favoris muets.
 */
export function permissionsDrift(expected = [], live) {
  const current = Array.isArray(live) ? live : [];
  const missing = expected.filter((entry) => !current.includes(entry));
  return {
    empty: current.length === 0,
    noCreate: current.length > 0 && !current.some((entry) => entry.startsWith('create(')),
    missing,
    aligned: current.length > 0 && missing.length === 0 && current.some((entry) => entry.startsWith('create(')),
  };
}

/** Écarts entre colonne déclarée et colonne réellement stockée (hors enum). */
export function columnDrift(declared, live) {
  if (!live) return null;
  const drift = {};
  const is = (key, expected, actual) => {
    if (actual === undefined || actual === null) return;
    if (expected !== actual) drift[key] = { expected, actual };
  };
  is('required', declared.required ?? false, live.required);
  is('size', declared.size, live.size);
  if (declared.default !== undefined || live.default !== undefined) is('default', declared.default ?? null, live.default ?? null);
  const enumIssue = enumDrift(declared, live);
  if (enumIssue) drift.elements = { expected: declared.elements, actual: liveEnumElements(live) };
  return Object.keys(drift).length ? drift : null;
}

/**
 * Erreurs « pas encore prêt » d'Appwrite : la création d'une colonne ou d'un
 * index est hors ligne, donc la ressource dépendante est refusée dans la foulée
 * (« The requested column 'x' is not yet available. Please try again later. »,
 * rencontré sur `uniq_favorite_user_path`). Ce n'est pas une erreur de modèle :
 * c'est une attente.
 */
export const PENDING_ERRORS = /not yet available|try again later|is being (?:created|modified|updated)|operation in progress/i;

export const isPendingResourceError = (error) => (error?.status === 400 || error?.status === 409)
  && PENDING_ERRORS.test(`${error?.message ?? ''} ${error?.rawBody ?? ''}`);

/**
 * Retente une opération refusée parce qu'une ressource vient de naître, et
 * jamais une erreur de modèle (un 400 « Cannot set default value » répété dix
 * fois ne devient pas vrai).
 */
export async function withPendingRetry(action, label = 'opération', {
  attempts = 10,
  delayMs = 1200,
  log = (line) => console.log(line),
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (!isPendingResourceError(error) || attempt >= attempts) throw error;
      log(`  … ${label} — pas encore disponible (essai ${attempt}/${attempts}), nouvelle tentative dans ${delayMs} ms`);
      await new Promise((done) => setTimeout(done, delayMs));
    }
  }
}

/**
 * Ligne par ligne, qui est le propriétaire ?
 *
 * Une table `profiles`/`favorites` ne contient volontairement **aucun** email :
 * l'identité vit dans le service Auth, et une colonne email écrite par le client
 * serait du PII dupliqué et contresignable. Dans la console, le lien se fait par
 * l'ID : pour `profiles`, `$id` de la ligne = ID de l'utilisateur. `summarizeRows`
 * fait cette jointure hors ligne pour le rapport `--inspect`.
 */
export function summarizeRows(rows = [], users = [], { max = 25 } = {}) {
  const byId = new Map(users.filter((user) => user?.$id).map((user) => [user.$id, user]));
  return rows.slice(0, max).map((row) => {
    const userId = row?.userId ?? null;
    const user = userId ? byId.get(userId) : null;
    return {
      rowId: row?.$id ?? null,
      userId,
      email: user?.email ?? null,
      name: user?.name ?? null,
      verified: user ? Boolean(user.emailVerification ?? user.verification ?? false) : null,
      orphan: Boolean(userId) && !user,
      row,
    };
  });
}

/** UID Appwrite : 36 caractères max, sans underscore initial, [a-zA-Z0-9_.-]. */
export function isValidAppwriteUid(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 36
    && !value.startsWith('_')
    && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value);
}
