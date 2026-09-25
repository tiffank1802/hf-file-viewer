/**
 * Entrées de favori : normalisation, pont avec la table `favorites`, et la seule
 * écriture locale qui reste — vider l'ancien miroir.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  favoriteFromRow,
  favoritePathHash,
  favoritePathHashSync,
  favoriteToRow,
  MAX_FAVORITE_NOTE,
  normalizeFavorite,
  normalizeFavoriteList,
  normalizeFavoritePath,
  planImport,
} from '../src/utils/favoritesEntry.js';
import {
  drainLegacyFavorites,
  hasLegacyFavorites,
  LEGACY_FAVORITES_KEY,
  LEGACY_TOMBSTONES_KEY,
  readLegacyFavorites,
} from '../src/services/favoritesLegacy.js';

/** Faux `localStorage` : les tests Node n'ont pas de `window`. */
function fakeStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    get size() { return data.size; },
    raw: data,
  };
}

test('normalizeFavoritePath unifie les séparateurs et retire les bords', () => {
  assert.equal(normalizeFavoritePath('/GM//3A GM/td1.pdf'), 'GM/3A GM/td1.pdf');
  assert.equal(normalizeFavoritePath(' /GM/a.pdf/  '), 'GM/a.pdf');
  // Une espace finale fait partie du nom du dossier dans le bucket.
  const folder = 'GM/Tutos SolidWorks/SolidProfessor/1-SOLIDWORKS Paths/1-CSWA/1) introduction to solidworks tutorials ';
  assert.equal(normalizeFavoritePath(folder), folder);
  assert.equal(normalizeFavoritePath(`${folder}/`), folder);
  assert.equal(normalizeFavoritePath('   '), '');
  assert.equal(normalizeFavoritePath('GM\\3A GM\\td1.pdf/'), 'GM/3A GM/td1.pdf');
  assert.equal(normalizeFavoritePath(null), '');
  assert.equal(normalizeFavoritePath(undefined), '');
});

test('normalizeFavorite borne les champs et ignore les entrées vides', () => {
  assert.equal(normalizeFavorite({ path: '  ' }), null);
  assert.equal(normalizeFavorite(null), null);
  const entry = normalizeFavorite({ path: 'a/b.pdf', name: 'x'.repeat(300), size: '12', note: 'n'.repeat(400) });
  assert.equal(entry.name.length, 240);
  assert.equal(entry.note.length, MAX_FAVORITE_NOTE);
  assert.equal(entry.size, 12);
  assert.equal(entry.type, 'file');
});

test('la liste est dédupliquée par chemin, ordre conservé', () => {
  const list = normalizeFavoriteList([
    { path: 'a.pdf' }, { path: 'a.pdf', name: 'doublon' }, { path: '' }, { path: 'b.pdf' },
  ]);
  assert.deepEqual(list.map((item) => item.path), ['a.pdf', 'b.pdf']);
  assert.equal(list[0].name, 'a.pdf', 'le premier arrivé gagne');
});

test('les lignes Appwrite et les entrées se traduisent dans les deux sens', () => {
  const row = favoriteToRow({ path: '/GM//td1.pdf', name: 'TD 1', type: 'directory', note: 'à relire' });
  assert.equal(row.filePath, 'GM/td1.pdf');
  assert.equal(row.kind, 'folder');
  assert.deepEqual(Object.keys(row).sort(), ['filePath', 'kind', 'note', 'title'],
    'aucune colonne hors modèle (sinon Appwrite répond 400)');
  const back = favoriteFromRow({ $id: 'row1', filePath: row.filePath, title: row.title, kind: row.kind, note: row.note, $createdAt: 'x' });
  assert.equal(back.rowId, 'row1');
  assert.equal(back.path, 'GM/td1.pdf');
  assert.equal(back.type, 'directory');
  assert.equal(back.note, 'à relire');
  assert.equal(favoriteFromRow(null), null);
});

test('la clé de chemin est stable, courte et sans collision sur l’arborescence du site', () => {
  const paths = ['GM/3A GM/td1.pdf', 'GM/3A GM/td2.pdf', 'TOEIC/listening/mp3-01.mp3'];
  const keys = paths.map((path) => favoritePathHashSync(path));
  assert.equal(new Set(keys).size, paths.length);
  for (const key of keys) {
    assert.match(key, /^[0-9a-f]{16,}$/);
    assert.ok(key.length <= 64, 'la clé tient dans une colonne string(64)');
  }
  assert.deepEqual(keys, paths.map((path) => favoritePathHashSync(path)), 'aucun état partagé entre deux appels');
  assert.equal(favoritePathHashSync('GM/a.pdf'), favoritePathHashSync('/GM//a.pdf'));
});

test('favoritePathHash utilise WebCrypto quand il est disponible', async () => {
  const async1 = await favoritePathHash('GM/3A GM/td1.pdf');
  const async2 = await favoritePathHash('/GM/3A GM//td1.pdf');
  assert.equal(async1, async2);
  assert.match(async1, /^[0-9a-f]{32}$/);
});

/* ------------------------------------------------------ le renderer d'un favori */

test('une entrée porte le `kind` que PreviewModal sait rendre', () => {
  // Sans ce champ, ouvrir un favori retombait sur l'écran de téléchargement :
  // PreviewModal branche le rendu sur `file.kind`, alors que la table, elle,
  // stocke file/folder — un autre vocabulaire.
  const kinds = {
    'GM/3A GM/cours.pdf': 'pdf',
    'GM/a.docx': 'office',
    'GM/piece.step': 'model',
    'TOEIC/track.mp3': 'audio',
    'GM/photo.png': 'image',
    'GM/notes.md': 'text',
  };
  for (const [path, expected] of Object.entries(kinds)) {
    assert.equal(normalizeFavorite({ path }).kind, expected, path);
  }
  assert.equal(normalizeFavorite({ path: 'GM/4A GM', type: 'directory' }).kind, 'folder');
  // Une valeur transportée périmée ne doit pas empêcher l'aperçu : le chemin fait foi.
  assert.equal(normalizeFavorite({ path: 'GM/a.pdf', kind: 'file' }).kind, 'pdf');
  assert.equal(favoriteToRow({ path: 'GM/a.pdf' }).kind, 'file',
    'le kind dérivé ne part pas en base : la colonne ne connaît que file/folder');
});

test('favoriteFromRow rend une entrée ouvrable, pas seulement listable', () => {
  const entry = favoriteFromRow({ $id: 'row-1', filePath: 'GM/a.xlsx', kind: 'file', title: 'a.xlsx' });
  assert.equal(entry.kind, 'office');
  assert.equal(entry.type, 'file');
  assert.equal(entry.rowId, 'row-1', 'le rowId évite de relister la table pour supprimer');
  const folder = favoriteFromRow({ $id: 'row-2', filePath: 'GM/3A GM', kind: 'folder', title: '3A GM' });
  assert.equal(folder.type, 'directory');
  assert.equal(folder.kind, 'folder');
});

/* ----------------------------------------- la reprise à sens unique de l'ancien cache */

test('planImport : ce que le compte a déjà ne repart pas', () => {
  const plan = planImport({
    cloud: [{ path: 'GM/deja-la.pdf' }, { path: 'GM/aussi-la.pdf' }],
    legacy: [{ path: 'GM/deja-la.pdf' }, { path: 'GM/nouveau.pdf' }],
  });
  assert.deepEqual(plan.pending.map((entry) => entry.path), ['GM/nouveau.pdf']);
  assert.deepEqual(plan.known.map((entry) => entry.path), ['GM/deja-la.pdf'],
    'déjà là : à purger du navigateur, pas à renvoyer');
});

test('planImport : cloud illisible = on retente quand même (index unique)', () => {
  const plan = planImport({ cloud: null, legacy: [{ path: 'GM/a.pdf' }] });
  assert.equal(plan.pending.length, 1);
  assert.deepEqual(plan.known, []);
});

test('planImport : rien de local = rien à faire', () => {
  assert.deepEqual(planImport({ cloud: [{ path: 'GM/a.pdf' }], legacy: [] }), { pending: [], known: [] });
});

test('la reprise est bilingue avec les chemins du compte', () => {
  // Le cache stockait `GM//a.pdf` ; le compte, `GM/a.pdf`. Sans normalisation
  // commune, chaque sync renverrait un doublon.
  const plan = planImport({ cloud: [{ path: 'GM/a.pdf' }], legacy: [{ path: '/GM//a.pdf' }] });
  assert.deepEqual(plan.pending, []);
  assert.equal(plan.known.length, 1);
});

test('readLegacyFavorites nettoie et encaisse un stockage illisible', () => {
  const storage = fakeStorage({
    [LEGACY_FAVORITES_KEY]: JSON.stringify([{ path: 'GM/a.pdf' }, { path: 'GM/a.pdf' }, null, 'pas un objet']),
  });
  assert.deepEqual(readLegacyFavorites(storage).map((entry) => entry.path), ['GM/a.pdf']);
  assert.deepEqual(readLegacyFavorites(fakeStorage({ [LEGACY_FAVORITES_KEY]: '{oops' })), []);
  assert.deepEqual(readLegacyFavorites(fakeStorage()), []);
  assert.deepEqual(readLegacyFavorites(null), [], 'pas de `window` en test Node : rien, pas une exception');
});

test('drainLegacyFavorites vide les deux clés locales quand tout est parti', () => {
  const storage = fakeStorage({
    [LEGACY_FAVORITES_KEY]: JSON.stringify([{ path: 'GM/a.pdf' }, { path: 'GM/b.pdf' }]),
    [LEGACY_TOMBSTONES_KEY]: JSON.stringify(['GM/z.pdf']),
  });
  assert.equal(hasLegacyFavorites(storage), true);
  const left = drainLegacyFavorites([], storage);
  assert.equal(left, 0);
  assert.equal(storage.size, 0, 'le miroir local doit disparaître, pas se vider à moitié');
  assert.equal(hasLegacyFavorites(storage), false);
  assert.deepEqual(readLegacyFavorites(storage), []);
});

test('drainLegacyFavorites ne garde que ce qui a été refusé', () => {
  const storage = fakeStorage({ [LEGACY_FAVORITES_KEY]: JSON.stringify([{ path: 'GM/a.pdf' }, { path: 'GM/b.pdf' }]) });
  const left = drainLegacyFavorites([{ path: 'GM/b.pdf', note: 'refusé' }], storage);
  assert.equal(left, 1);
  assert.deepEqual(readLegacyFavorites(storage).map((entry) => entry.path), ['GM/b.pdf']);
  assert.equal(storage.raw.get(LEGACY_TOMBSTONES_KEY), undefined, 'la file de suppressions locales na plus de sens');
});
