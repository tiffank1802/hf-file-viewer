import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildApsObjectKey,
  buildHfFileUrl,
  buildHfTreeUrl,
  countFilesByDirectory,
  getNextLink,
  isApsConfigured,
  makeApsSourceKey,
  makeKvKey,
  normalizeFilePath,
  normalizePrefix,
  selectCountsForPrefix,
} from '../worker/index.js';

test('buildHfTreeUrl encode les préfixes sans perdre les caractères Unicode', () => {
  const url = new URL(buildHfTreeUrl('ktongue/ENISE-SITE', 'GM/3A GM/S5/Mécanique', false));
  assert.equal(url.pathname, '/api/buckets/ktongue/ENISE-SITE/tree/GM%2F3A%20GM%2FS5%2FM%C3%A9canique');
  assert.equal(url.searchParams.get('recursive'), 'false');
});

test('buildHfTreeUrl demande de grandes pages pour l’index récursif', () => {
  const url = new URL(buildHfTreeUrl('ktongue/ENISE-SITE', '', true));
  assert.equal(url.searchParams.get('recursive'), 'true');
  assert.equal(url.searchParams.get('limit'), '1000');
});

test('buildHfFileUrl produit une URL resolve sûre', () => {
  const url = buildHfFileUrl('ktongue/ENISE-SITE', 'GM/4A GM/Cours & TD/épreuve.pdf');
  assert.equal(
    url,
    'https://huggingface.co/buckets/ktongue/ENISE-SITE/resolve/GM/4A%20GM/Cours%20%26%20TD/%C3%A9preuve.pdf?download=false',
  );
});

test('getNextLink lit le lien de pagination relatif', () => {
  const next = getNextLink(
    '</api/buckets/u/b/tree?cursor=abc>; rel="next", </api/buckets/u/b/tree?cursor=xyz>; rel="last"',
    'https://huggingface.co/api/buckets/u/b/tree',
  );
  assert.equal(next, 'https://huggingface.co/api/buckets/u/b/tree?cursor=abc');
});

test('les clés Workers KV sont courtes, stables et spécifiques au chemin', () => {
  const first = makeKvKey('tree', 'ktongue/ENISE-SITE', 'GM/3A GM');
  assert.equal(first, makeKvKey('tree', 'ktongue/ENISE-SITE', 'GM/3A GM'));
  assert.notEqual(first, makeKvKey('tree', 'ktongue/ENISE-SITE', 'GM/4A GM'));
  assert.ok(first.length < 80);
});

test('le comptage récursif agrège tous les fichiers d’un dossier', () => {
  const { counts, totalFiles } = countFilesByDirectory([
    { type: 'directory', path: 'GM' },
    { type: 'file', path: 'GM/3A GM/S5/poly.pdf' },
    { type: 'file', path: 'GM/3A GM/S6/td.pdf' },
    { type: 'file', path: 'GM/readme.md' },
    { type: 'file', path: 'TOEIC/audio.mp3' },
  ], '');
  assert.equal(totalFiles, 4);
  assert.equal(counts.GM, 3);
  assert.equal(counts['GM/3A GM'], 2);
  assert.equal(counts['GM/3A GM/S5'], 1);
  assert.equal(counts.TOEIC, 1);
});

test('les effectifs sont extraits du JSON d’index, jamais recalculés en live', () => {
  const document = {
    counts: { GM: 3, 'GM/3A GM': 2, 'GM/4A GM': 1, TOEIC: 1 },
    totalFiles: 4,
  };

  const root = selectCountsForPrefix(document, '');
  assert.equal(root.totalFiles, 4);
  assert.equal(root.counts.TOEIC, 1);

  const scoped = selectCountsForPrefix(document, '/GM/');
  assert.equal(scoped.totalFiles, 3);
  assert.equal(scoped.counts['GM/3A GM'], 2);
  assert.equal(scoped.counts.TOEIC, undefined);

  assert.deepEqual(selectCountsForPrefix({}, 'GM'), { counts: {}, totalFiles: 0 });
});

test('les chemins sont normalisés et les traversées refusées', () => {
  assert.equal(normalizePrefix('/GM/3A GM/'), 'GM/3A GM');
  assert.equal(normalizeFilePath('/GM/poly.pdf'), 'GM/poly.pdf');
  assert.throws(() => normalizeFilePath('../secret'), /invalide/i);
  assert.throws(() => normalizeFilePath('a\u0000b'), /invalide/i);
  assert.throws(() => normalizeFilePath(''), /obligatoire/i);
});

test('la configuration Autodesk APS exige les deux secrets', () => {
  assert.equal(isApsConfigured({}), false);
  assert.equal(isApsConfigured({ APS_CLIENT_ID: 'id' }), false);
  assert.equal(
    isApsConfigured({ APS_CLIENT_ID: 'id', APS_CLIENT_SECRET: 'secret' }),
    true,
  );
});

test('les clés APS sont stables, courtes et sensibles au contenu', () => {
  const first = makeApsSourceKey('GM/3D/piece.sldprt', '1024', '2026-01-01');
  assert.equal(first.length, 32);
  assert.equal(first, makeApsSourceKey('GM/3D/piece.sldprt', '1024', '2026-01-01'));
  assert.notEqual(first, makeApsSourceKey('GM/3D/piece.sldprt', '2048', '2026-01-01'));
  assert.notEqual(first, makeApsSourceKey('GM/3D/piece.stl', '1024', '2026-01-01'));
});

test('les objets OSS APS gardent une partie lisible du nom', () => {
  const key = buildApsObjectKey('GM/3D/maquette_du$batiment.rvt', 'abc123');
  assert.equal(key, 'abc123-maquette_du_batiment.rvt');
});
