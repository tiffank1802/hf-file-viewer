import test from 'node:test';
import assert from 'node:assert/strict';
import { canPreviewInGallery, changeExplorerSort, DEFAULT_PREFERENCES, explorerPreferences, selectExplorerItem, sortExplorerItems } from '../src/utils/explorer.js';
import { DEFAULT_FILTERS, EMPTY_PERSONAL, movePinnedFolder, normalizePersonal, orderPinnedFolders, recordExplorerRecent, searchExplorerCatalog, toggleExplorerTag } from '../src/utils/explorerPersonal.js';
import { normalizeBucketItem } from '../src/utils/files.js';

const item = (path, props = {}) => normalizeBucketItem({ path, ...props });

test('les options persistées sont validées indépendamment et le tri peut être inversé', () => {
  assert.deepEqual(explorerPreferences({ view: 'gallery', sort: 'not-a-sort', direction: 'desc', iconSize: null }), {
    ...DEFAULT_PREFERENCES, view: 'gallery', direction: 'desc',
  });
  const sizeSort = changeExplorerSort(DEFAULT_PREFERENCES, 'size');
  assert.equal(sizeSort.direction, 'desc');
  assert.equal(changeExplorerSort(sizeSort, 'size').direction, 'asc');
});

test('les dossiers restent en tête ; les tailles et dates inconnues restent en fin de groupe', () => {
  const entries = [item('TD 10.pdf', { size: 23 }), item('TD 2.pdf', { size: 5, mtime: '2025-01-20' }), item('Inconnu.pdf'), item('Dossier', { type: 'directory' })];
  const order = (sort, direction) => sortExplorerItems(entries, { sort, direction }).map((entry) => entry.name);
  assert.deepEqual(order('name', 'asc'), ['Dossier', 'Inconnu.pdf', 'TD 2.pdf', 'TD 10.pdf']);
  assert.deepEqual(order('size', 'asc'), ['Dossier', 'TD 2.pdf', 'TD 10.pdf', 'Inconnu.pdf']);
  assert.deepEqual(order('size', 'desc'), ['Dossier', 'TD 10.pdf', 'TD 2.pdf', 'Inconnu.pdf']);
  assert.equal(order('date', 'desc')[1], 'TD 2.pdf');
  assert.equal(entries[0].name, 'TD 10.pdf');
  assert.equal(entries[3].count, null);
});

test('la sélection par plage conserve son ancre ; un clic modifié ajoute ou enlève le chemin', () => {
  const entries = ['A', 'B', 'C', 'D'];
  const selected = selectExplorerItem({ paths: new Set(), anchor: null }, entries, 'B');
  const range = selectExplorerItem(selected, entries, 'D', { extend: true });
  assert.deepEqual([...range.paths], ['B', 'C', 'D']);
  assert.equal(range.anchor, 'B');
  assert.deepEqual([...selectExplorerItem(range, entries, 'D', { toggle: true }).paths], ['B', 'C']);
  assert.deepEqual([...selected.paths], ['B']);
});

test('la galerie ne charge ni SVG, ni documents, ni images lourdes ou de taille inconnue', () => {
  assert.equal(canPreviewInGallery(item('Plan.jpg', { size: 120000 })), true);
  for (const entry of [item('Plan.svg', { size: 8 }), item('Plan.jpg'), item('Plan.jpg', { size: 10 * 1024 * 1024 }), item('Plan.pdf', { size: 8 })]) {
    assert.equal(canPreviewInGallery(entry), false);
  }
});

test('la recherche combinée respecte le segment de dossier, les accents et les tags', () => {
  const items = [
    item('Cours/Intégration.pdf', { mtime: '2026-11-18', size: 40000 }),
    item('Cours/Intégration.docx', { mtime: '2026-11-18', size: 10000 }),
    item('Cours/Intégration 2.pdf', { mtime: '2026-10-18', size: 10000 }),
    item('Cours 2/Intégration.pdf', { mtime: '2026-11-18', size: 40000 }),
  ];
  const labels = new Map(items.map((entry) => [entry.path, ['review']]));
  const filters = { ...DEFAULT_FILTERS, folder: 'Cours', tag: 'review', kind: 'pdf', size: 'small', date: '7' };
  assert.deepEqual(searchExplorerCatalog(items, 'integration', filters, labels, Date.parse('2026-11-20')).map((entry) => entry.path), ['Cours/Intégration.pdf']);
});

test('les métadonnées personnelles restent bornées et les chemins ne sont pas des clés d’objet', () => {
  const recents = Array.from({ length: 30 }, (_, index) => item(`file-${index}.pdf`));
  const next = recordExplorerRecent(recents, item('file-3.pdf'));
  assert.equal(next[0].path, 'file-3.pdf');
  assert.equal(next.length, 30);
  assert.equal(new Set(next.map((entry) => entry.path)).size, 30);
  const labels = toggleExplorerTag([], '__proto__', 'important');
  assert.deepEqual(labels, [['__proto__', ['important']]]);
  assert.deepEqual(toggleExplorerTag(labels, '__proto__', 'important'), []);
  assert.deepEqual(normalizePersonal({ searches: null, labels: {}, recent: ['bad'] }), EMPTY_PERSONAL);
});


test('le réordonnancement des favoris de dossiers ne touche pas aux chemins sources', () => {
  const folders = ['GM', 'TOEIC', 'Autre'].map((path) => item(path, { type: 'directory' }));
  const order = movePinnedFolder(folders.map((folder) => folder.path), 'Autre', 'GM');
  assert.deepEqual(order, ['Autre', 'GM', 'TOEIC']);
  assert.deepEqual(orderPinnedFolders(folders, ['Absent', ...order]).map((folder) => folder.path), order);
  assert.deepEqual(folders.map((folder) => folder.path), ['GM', 'TOEIC', 'Autre']);
});
