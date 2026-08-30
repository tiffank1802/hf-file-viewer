import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFolderCounts,
  countFilesByDirectory,
  extractUrlFromShortcut,
  formatBytes,
  formatFolderCount,
  getBreadcrumbs,
  getFileKind,
  isModelExtension,
  isOfficeExtension,
  isOfficeWebViewerExtension,
  isOneNoteExtension,
  normalizeBucketItem,
  searchItems,
  sortItems,
} from '../src/utils/files.js';
import { getFallbackCatalog } from '../src/data/fallbackData.js';

test('les types de documents sont reconnus', () => {
  assert.equal(getFileKind('cours.pdf'), 'pdf');
  assert.equal(getFileKind('audio.m4a'), 'audio');
  assert.equal(getFileKind('notes.md'), 'text');
  assert.equal(getFileKind('GM', 'directory'), 'folder');
  assert.equal(getFileKind('document.doc'), 'office');
  assert.equal(getFileKind('tableur.xls'), 'office');
});

test('les fichiers 3D sont reconnus pour Autodesk', () => {
  assert.equal(getFileKind('modele.rvt'), 'model');
  assert.equal(getFileKind('piece.sldprt'), 'model');
  assert.equal(getFileKind('maquette.stp'), 'model');
  assert.equal(getFileKind('objet.stl'), 'model');
  assert.equal(getFileKind('plan.dwg'), 'model');
  assert.equal(isModelExtension('RVT'), true);
  assert.equal(isModelExtension('ifc'), true);
  assert.equal(isModelExtension('pdf'), false);
});

test('les documents Office et OneNote sont détectés pour le viewer Office', () => {
  assert.equal(isOfficeExtension('doc'), true);
  assert.equal(isOfficeExtension('xls'), true);
  assert.equal(isOfficeExtension('DOCX'), true);
  assert.equal(isOfficeExtension('pdf'), false);
  assert.equal(isOfficeExtension('url'), true);
  assert.equal(isOfficeExtension('one'), true);

  assert.equal(isOfficeWebViewerExtension('doc'), true);
  assert.equal(isOfficeWebViewerExtension('docx'), true);
  assert.equal(isOfficeWebViewerExtension('xls'), true);
  assert.equal(isOfficeWebViewerExtension('xlsx'), true);
  assert.equal(isOfficeWebViewerExtension('ppt'), true);
  assert.equal(isOfficeWebViewerExtension('pptx'), true);
  assert.equal(isOfficeWebViewerExtension('odt'), false);
  assert.equal(isOfficeWebViewerExtension('one'), false);

  assert.equal(isOneNoteExtension('url'), true);
  assert.equal(isOneNoteExtension('one'), true);
  assert.equal(isOneNoteExtension('onenote'), true);
  assert.equal(isOneNoteExtension('docx'), false);
});

test('les raccourcis .url exposent leur cible', () => {
  const shortcut = [
    '[InternetShortcut]',
    'URL=https://www.onenote.com/webapp',
    'IconFile=Microsoft OneNote.exe',
  ].join('\r\n');
  assert.equal(
    extractUrlFromShortcut(shortcut),
    'https://www.onenote.com/webapp',
  );
  assert.equal(extractUrlFromShortcut('aucune url ici'), '');
});

test('la recherche ignore les accents et favorise le nom', () => {
  const items = [
    { type: 'file', path: 'GM/Mécanique/solides.pdf', size: 10 },
    { type: 'directory', path: 'GM/Mecanique des fluides' },
    { type: 'file', path: 'TOEIC/mecanique.mp3', size: 10 },
  ];
  const results = searchItems(items, 'mecanique');
  assert.equal(results.length, 3);
  assert.deepEqual(
    new Set(results.slice(0, 2).map((item) => item.name)),
    new Set(['Mecanique des fluides', 'mecanique.mp3']),
  );
});

test('les dossiers restent avant les fichiers lors du tri', () => {
  const items = [
    normalizeBucketItem({ type: 'file', path: 'A.pdf', size: 100 }),
    normalizeBucketItem({ type: 'directory', path: 'Z' }),
  ];
  assert.equal(sortItems(items, 'name')[0].type, 'directory');
  assert.equal(sortItems(items, 'size')[0].type, 'directory');
});

test('le fil d’Ariane reconstruit chaque niveau', () => {
  assert.deepEqual(getBreadcrumbs('GM/3A GM/S5'), [
    { label: 'Bibliothèque', path: '' },
    { label: 'GM', path: 'GM' },
    { label: '3A GM', path: 'GM/3A GM' },
    { label: 'S5', path: 'GM/3A GM/S5' },
  ]);
});

test('formatBytes retourne une valeur française lisible', () => {
  assert.equal(formatBytes(1024), '1 Ko');
  assert.equal(formatBytes(0), '—');
});

test('les effectifs sont calculés une fois pour tous les dossiers parents', () => {
  const { counts, totalFiles } = countFilesByDirectory([
    { type: 'directory', path: 'GM' },
    { type: 'file', path: 'GM/3A GM/S5/poly.pdf' },
    { type: 'file', path: 'GM/3A GM/S6/td.pdf' },
    { type: 'file', path: 'TOEIC/audio.mp3' },
  ]);
  assert.equal(totalFiles, 3);
  assert.equal(counts.GM, 2);
  assert.equal(counts['GM/3A GM/S5'], 1);
  assert.equal(counts.TOEIC, 1);
});

test('applyFolderCounts complète les dossiers depuis le JSON d’index', () => {
  const items = [
    normalizeBucketItem({ type: 'directory', path: 'GM' }),
    normalizeBucketItem({ type: 'file', path: 'GM/poly.pdf', size: 10 }),
  ];
  const [folder, file] = applyFolderCounts(items, { GM: 128 });
  assert.equal(folder.count, 128);
  assert.equal(file.count, null);
  assert.equal(applyFolderCounts(items, {})[0].count, null);
});

test('formatFolderCount ne transforme pas un compteur manquant en 0', () => {
  const folder = normalizeBucketItem({ type: 'directory', path: 'GM' });
  assert.equal(folder.count, null);
  assert.equal(formatFolderCount(folder), 'Nombre indisponible');
  assert.equal(formatFolderCount(folder, true), 'Indexation…');
  assert.equal(formatFolderCount({ ...folder, count: 0 }), '0 ressource');
  assert.equal(formatFolderCount({ ...folder, count: 1 }), '1 ressource');
  assert.equal(formatFolderCount({ ...folder, count: 128 }), '128 ressources');
});

test('le catalogue d’aperçu local fournit des effectifs hors ligne', () => {
  const { counts, totalFiles, items } = getFallbackCatalog();
  assert.ok(items.length > 0);
  assert.ok(totalFiles > 0);
  assert.ok(Number.isFinite(counts.GM));
});
