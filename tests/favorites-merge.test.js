import assert from 'node:assert/strict';
import test from 'node:test';

import {
  favoriteFromRow,
  favoritePathHash,
  favoritePathHashSync,
  favoriteToRow,
  mergeFavorites,
  normalizeFavorite,
  normalizeFavoriteList,
  normalizeFavoritePath,
  planReconcile,
  pruneTombstones,
  withoutTombstones,
  MAX_TOMBSTONES,
} from '../src/utils/favoritesMerge.js';

test('normalizeFavoritePath unifie les séparateurs et retire les bords', () => {
  assert.equal(normalizeFavoritePath('/GM//3A GM/td1.pdf'), 'GM/3A GM/td1.pdf');
  assert.equal(normalizeFavoritePath('  GM/a.pdf  '), 'GM/a.pdf');
  assert.equal(normalizeFavoritePath('GM\\3A GM\\td1.pdf/'), 'GM/3A GM/td1.pdf');
  assert.equal(normalizeFavoritePath(null), '');
  assert.equal(normalizeFavoritePath(undefined), '');
});

test('normalizeFavorite borne les champs et ignore les entrées vides', () => {
  assert.equal(normalizeFavorite({ path: '  ' }), null);
  assert.equal(normalizeFavorite(null), null);
  const entry = normalizeFavorite({ path: 'a/b.pdf', name: 'x'.repeat(300), size: '12', note: 'n'.repeat(400) });
  assert.equal(entry.name.length, 240);
  assert.equal(entry.note.length, 280);
  assert.equal(entry.size, 12);
  assert.equal(entry.type, 'file');
});

test('la liste locale est dédupliquée par chemin, ordre conservé', () => {
  const list = normalizeFavoriteList([
    { path: 'a.pdf' }, { path: 'a.pdf', name: 'doublon' }, { path: '' }, { path: 'b.pdf' },
  ]);
  assert.deepEqual(list.map((item) => item.path), ['a.pdf', 'b.pdf']);
  assert.equal(list[0].name, 'a.pdf', 'le premier arrivé gagne');
});

test('mergeFavorites : le cloud gagne, le local non envoyé repart en pending', () => {
  const { items, pending, toDelete } = mergeFavorites({
    cloud: [{ path: 'a.pdf', name: 'A', note: 'nuage' }, { path: 'b.pdf' }],
    local: [{ path: 'b.pdf', name: 'B local' }, { path: 'c.pdf', name: 'C' }],
    tombstones: [],
  });
  assert.deepEqual(items.map((item) => item.path), ['a.pdf', 'b.pdf', 'c.pdf']);
  assert.equal(items.find((item) => item.path === 'a.pdf').note, 'nuage');
  assert.deepEqual(pending.map((item) => item.path), ['c.pdf']);
  assert.deepEqual(toDelete, []);
});

test('une suppression hors ligne est envoyée et empêche la résurrection', () => {
  const { items, toDelete } = mergeFavorites({
    cloud: [{ path: 'a.pdf' }, { path: 'b.pdf' }],
    local: [{ path: 'a.pdf' }],
    tombstones: ['b.pdf'],
  });
  assert.deepEqual(toDelete, ['b.pdf']);
  assert.deepEqual(items.map((item) => item.path), ['a.pdf']);
});

test('un favori supprimé localement et absent du cloud ne revient jamais', () => {
  const { items, pending } = mergeFavorites({
    cloud: [],
    local: [{ path: 'a.pdf' }, { path: 'gone.pdf' }],
    tombstones: ['gone.pdf'],
  });
  assert.deepEqual(items.map((item) => item.path), ['a.pdf']);
  assert.deepEqual(pending.map((item) => item.path), ['a.pdf']);
});

test('les tombstones sont bornés et nettoyés après application', () => {
  const many = Array.from({ length: MAX_TOMBSTONES + 25 }, (_, index) => `d/f${index}.pdf`);
  const pruned = pruneTombstones(many);
  assert.equal(pruned.length, MAX_TOMBSTONES);
  assert.equal(pruned.at(-1), many.at(-1), 'les plus récents restent');
  assert.deepEqual(withoutTombstones(['a.pdf', 'b.pdf'], ['a.pdf']), ['b.pdf']);
});

test('les lignes Appwrite et les entrées locales se traduisent dans les deux sens', () => {
  const row = favoriteToRow({ path: '/GM//td1.pdf', name: 'TD 1', type: 'directory', note: 'à relire' });
  assert.equal(row.filePath, 'GM/td1.pdf');
  assert.equal(row.kind, 'folder');
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
  // Même chemin, écritures différentes : même clé.
  assert.equal(favoritePathHashSync('GM/a.pdf'), favoritePathHashSync('/GM//a.pdf'));
});

test('favoritePathHash utilise WebCrypto quand il est disponible', async () => {
  const async1 = await favoritePathHash('GM/3A GM/td1.pdf');
  const async2 = await favoritePathHash('/GM/3A GM//td1.pdf');
  assert.equal(async1, async2);
  assert.match(async1, /^[0-9a-f]{32}$/);
});

/* ------------------------------------------------------ le renderer d'un favori */

test('une entrée locale porte le `kind` que PreviewModal sait rendre', () => {
  // Sans ce champ, ouvrir un favori retombait sur l’écran de téléchargement :
  // PreviewModal branche le rendu sur `file.kind`, et les favoris n’en portaient
  // aucun (la table, elle, stocke file/folder — un autre vocabulaire).
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
  // Une valeur stockée périmée ne doit pas empêcher l'aperçu : le chemin fait foi.
  assert.equal(normalizeFavorite({ path: 'GM/a.pdf', kind: 'file' }).kind, 'pdf');
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

/* -------------------------------------------- le miroir local comme file d'attente */

test('cloud illisible : les favoris locaux partent quand même, rien n’est supprimé', () => {
  // C'est le cœur du correctif : un 403 (ou une panne) sur le LIST ne doit pas
  // court-circuiter l'écriture, sinon le cache reste la seule copie pour toujours.
  const plan = planReconcile({
    cloud: null,
    cloudUnavailable: true,
    local: [{ path: 'GM/a.pdf' }, { path: 'GM/b.pdf' }],
    tombstones: ['GM/b.pdf'],
  });
  assert.equal(plan.degraded, true);
  assert.deepEqual(plan.pending.map((entry) => entry.path), ['GM/a.pdf']);
  assert.deepEqual(plan.toDelete, [], 'aucune vue du cloud = aucune suppression décrétée');
  assert.deepEqual(plan.items.map((entry) => entry.path), ['GM/a.pdf']);
});

test('cloud lisible : le plan reste celui de mergeFavorites', () => {
  const plan = planReconcile({
    cloud: [{ path: 'GM/deja-la.pdf', name: 'deja-la.pdf' }],
    local: [{ path: 'GM/nouveau.pdf' }, { path: 'GM/deja-la.pdf' }],
    tombstones: [],
  });
  assert.equal(plan.degraded, false);
  assert.deepEqual(plan.pending.map((entry) => entry.path), ['GM/nouveau.pdf']);
  assert.equal(plan.items.length, 2);
});

test('cloud absent (table non provisionnée) : plan dégradé aussi, pas d’exception', () => {
  const plan = planReconcile({ cloud: null, local: [{ path: 'GM/a.pdf' }], tombstones: [] });
  assert.equal(plan.degraded, true);
  assert.equal(plan.pending.length, 1);
});
