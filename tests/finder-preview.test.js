import test from 'node:test';
import assert from 'node:assert/strict';
import { canPreviewIcon, explorerPreferences, folderPresentation, sortExplorerItems } from '../src/utils/explorer.js';
import { readTextPreview } from '../src/utils/textPreview.js';

test('les options enregistrées ignorent les valeurs invalides, et ne mélangent pas les volets et les dossiers', () => {
  const prefs = explorerPreferences({ view: 'list', showPreview: true, showSidebar: false, listColumns: ['size', 'unknown', 'date', 'size'], gridSpacing: 'invalid', textSize: 'large' });
  assert.deepEqual(prefs.listColumns, ['date', 'size']);
  assert.equal(prefs.gridSpacing, 'normal');
  assert.equal(prefs.textSize, 'large');
  assert.equal(prefs.showPreview, true);
  assert.equal(prefs.showSidebar, false);
  assert.equal(Object.hasOwn(folderPresentation(prefs), 'showPreview'), false);
  assert.equal(folderPresentation(prefs).view, 'list');
  assert.deepEqual(explorerPreferences({ listColumns: [] }).listColumns, []);
});

test('l’option Dossiers en premier peut être désactivée', () => {
  const entries = [{ name: 'Z', path: 'Z', type: 'directory' }, { name: 'A.pdf', path: 'A.pdf', type: 'file' }];
  assert.equal(sortExplorerItems(entries, explorerPreferences({}))[0].name, 'Z');
  assert.equal(sortExplorerItems(entries, explorerPreferences({ foldersFirst: false }))[0].name, 'A.pdf');
  assert.equal(canPreviewIcon({ path: 'plan.png', kind: 'image', size: 80_000 }), true);
  assert.equal(canPreviewIcon({ path: 'plan.png', kind: 'image', size: 300_000 }), false);
});

test('prévisualiser un texte impose la limite même si le serveur ne respecte pas Range', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('12é34')); },
    cancel() { cancelled = true; },
  });
  assert.deepEqual(await readTextPreview(new Response(body), 3), { text: '12', truncated: true });
  assert.equal(cancelled, true);
});

test('prévisualiser un texte distingue la réponse partielle, la taille exacte et une erreur HTTP', async () => {
  assert.deepEqual(await readTextPreview(new Response('abc', { status: 206, headers: { 'Content-Range': 'bytes 0-2/5' } }), 3), { text: 'abc', truncated: true });
  assert.deepEqual(await readTextPreview(new Response('abc'), 3), { text: 'abc', truncated: false });
  await assert.rejects(() => readTextPreview(new Response(null, { status: 502 })), /Impossible/);
});
