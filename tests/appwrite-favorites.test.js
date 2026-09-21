import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Chemin d'écriture des favoris, avec le service de lignes simulé.
 *
 * Ces cas verrouillent trois défauts rencontrés en réel :
 * - `const rows = await listFavorites(...)` masquait le service importé, donc
 *   `rows.remove(...)` levait un TypeError et AUCUNE suppression n'aboutissait ;
 * - un 403 sur la table était confondu avec « table absente », l'état
 *   `unprovisioned` coupait le `push` sans message, et la table restait vide
 *   pendant que l'interface avait l'air synchronisée ;
 * - `pushFavorites` renvoyait des chemins sans la raison du refus.
 *
 * Le service est la source unique des favoris (plus de miroir `localStorage`) :
 * ce qui est testé ici, c'est que chaque refus remonte avec sa raison — une
 * écriture muette était le défaut d'origine.
 */
process.env.VITE_APPWRITE_DATABASE_ID = 'enise_docs';

const { rows } = await import('../src/services/appwrite.js');
const {
  addFavorite,
  favoritesBlockers,
  listFavorites,
  pushFavorites,
  removeFavorite,
} = await import('../src/services/favorites.js');
const { TABLES } = await import('../scripts/appwrite-spec.js');

const COLUMNS = TABLES.find((table) => table.id === 'favorites').columns.map((column) => column.key);
const calls = [];

function stubRows(behavior = {}) {
  const saved = { ...rows };
  const apply = (name, fallback) => {
    rows[name] = async (args) => {
      calls.push({ name, args });
      if (behavior[name]) return behavior[name](args);
      return fallback();
    };
  };
  apply('list', () => ({ rows: [], total: 0 }));
  apply('create', () => ({ $id: 'row-1', filePath: 'GM/x.pdf', title: 'x.pdf', kind: 'file', note: '' }));
  apply('remove', () => ({}));
  apply('update', () => ({ $id: 'row-1' }));
  return () => Object.assign(rows, saved);
}

const cloudRow = (path, id = 'row-1') => ({
  $id: id, filePath: path, title: path.split('/').pop(), kind: 'file', note: '',
});

test('la charge envoyée à Appwrite ne contient que des colonnes de la table', async () => {
  calls.length = 0;
  const restore = stubRows();
  try {
    await addFavorite('user-1', { path: 'GM/3A GM/méca.pdf', name: 'méca.pdf', type: 'file', note: 'cours' });
  } finally {
    restore();
  }
  const { args } = calls[0];
  assert.equal(args.tableId, 'favorites');
  const sent = Object.keys(args.data).sort();
  for (const key of sent) {
    assert.ok(COLUMNS.includes(key), `clé « ${key} » absente de la table : Appwrite répondrait « Unknown column »`);
  }
  assert.deepEqual(sent, [...COLUMNS].sort(), 'toutes les colonnes utiles doivent être écrites');
  assert.equal(args.data.userId, 'user-1', 'le propriétaire vient de la session, pas de la saisie');
  assert.equal(args.data.filePath, 'GM/3A GM/méca.pdf');
  assert.match(args.data.pathKey, /^[a-z0-9_-]{8,}$/, 'clé courte et stable pour l’index unique');
  assert.ok(args.permissions.every((permission) => permission.includes('user-1')),
    'une ligne ne doit être lisible/modifiable que par son propriétaire');
});

test('supprimer sans connaître le rowId passe par la liste puis deleteRow', async () => {
  calls.length = 0;
  const restore = stubRows({ list: () => ({ rows: [cloudRow('GM/a.pdf', 'row-7')], total: 1 }) });
  try {
    assert.equal(await removeFavorite('user-1', { path: 'GM/a.pdf' }), true);
  } finally {
    restore();
  }
  const names = calls.map((call) => call.name);
  assert.deepEqual(names, ['list', 'remove'], 'la liste doit précéder la suppression, puis le service de lignes — pas un array');
  assert.equal(calls[1].args.rowId, 'row-7');
});

test('un 403 sur la table est nommé, pas confondu avec une table absente', async () => {
  const restore = stubRows({
    list: () => { throw Object.assign(new Error('User is not allowed to perform the action'), { code: 403, type: 'user_unauthorized' }); },
  });
  try {
    const error = await listFavorites('user-1').catch((caught) => caught);
    assert.equal(error.forbidden, true, 'l’état doit permettre à l’UI de dire « permission refusée »');
    // Le message reste traduit (le type Appwrite a un équivalent français) ET
    // renvoie à la commande qui nomme la permission manquante.
    assert.match(error.message, /Permission refusée/);
    assert.match(error.message, /appwrite:status/);
  } finally {
    restore();
  }

  const missing = stubRows({
    list: () => { throw Object.assign(new Error('Table not found'), { code: 404, type: 'table_not_found' }); },
  });
  try {
    assert.equal(await listFavorites('user-1'), null, 'table absente = repli silencieux sur le miroir local');
  } finally {
    missing();
  }
});

test('pushFavorites rapporte la raison du refus pour chaque favori', async () => {
  calls.length = 0;
  let first = true;
  const restore = stubRows({
    create: () => {
      if (first) { first = false; return { $id: 'row-1', filePath: 'GM/a.pdf', kind: 'file', title: 'a.pdf' }; }
      throw Object.assign(new Error('Invalid document structure: Unknown column'), { code: 400, type: 'invalid_request' });
    },
  });
  try {
    const result = await pushFavorites('user-1', [{ path: 'GM/a.pdf' }, { path: 'GM/b.pdf' }]);
    assert.equal(result.pushed, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].path, 'GM/b.pdf');
    assert.match(result.failed[0].reason, /Invalid document structure|Unknown column/, 'la raison brute doit remonter');
    assert.deepEqual(result.blockers, [], 'tout est configuré : aucune cause de coupure');
    // Le rowId revient : sans lui, retirer le favori exige de relister la table.
    assert.equal(result.saved.length, 1);
    assert.equal(result.saved[0].rowId, 'row-1');
    assert.match(result.saved[0].kind, /pdf|office|text|image|model|audio|video|folder/,
      'une entrée poussée doit rester ouvrable depuis les favoris');
  } finally {
    restore();
  }
});

test('favoritesBlockers nomme la session manquante, pas une panne', () => {
  // Le message doit dire la vérité nouvelle : plus de miroir local où se réfugier.
  assert.match(favoritesBlockers(null)[0], /^aucune session : les favoris ne sont ni lus ni écrits/);
  assert.doesNotMatch(favoritesBlockers(null).join(' '), /restent locaux/,
    '« restent locaux » serait un mensonge depuis que le compte est la seule source');
  assert.deepEqual(favoritesBlockers('user-1'), []);
});
