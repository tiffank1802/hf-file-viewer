import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndexDocument,
  buildTreeUrl,
  countFilesInListing,
  diffWithIndexDocument,
  normalizePrefix,
  parseNextLink,
  renderComparison,
  renderReport,
} from '../scripts/count-bucket-files.mjs';

// Échantillon calqué sur la réponse réelle de l’API buckets Hugging Face.
const SAMPLE_LISTING = [
  { type: 'directory', path: 'GM' },
  { type: 'file', path: 'GM/3A GM/S5/Calcul Tensoriel/CahierExos.pdf', size: 337353 },
  { type: 'file', path: 'GM/3A GM/S5/Calcul Tensoriel/Poly.pdf', size: 786852 },
  { type: 'file', path: 'GM/3A GM/S5/Calculs Scientifiques/tp-1.pdf', size: 171618 },
  { type: 'file', path: 'TOEIC/COMPASS TOEIC/Analyst TOEIC/test.pdf', size: 1024 },
  { type: 'file', path: 'TOEIC/COMPASS TOEIC/Developing TOEIC/test2.pdf', size: 2048 },
  { type: 'file', path: 'lisez-moi.txt', size: 12 },
];

test('countFilesInListing compte chaque dossier parent et ignore les dossiers', () => {
  const analysis = countFilesInListing(SAMPLE_LISTING);
  assert.equal(analysis.totalFiles, 6);
  assert.equal(analysis.totalBytes, 337353 + 786852 + 171618 + 1024 + 2048 + 12);
  assert.equal(analysis.counts.GM, 3);
  assert.equal(analysis.counts['GM/3A GM'], 3);
  assert.equal(analysis.counts['GM/3A GM/S5'], 3);
  assert.equal(analysis.counts['GM/3A GM/S5/Calcul Tensoriel'], 2);
  assert.equal(analysis.counts['GM/3A GM/S5/Calculs Scientifiques'], 1);
  assert.equal(analysis.counts.TOEIC, 2);
  assert.equal(analysis.counts['TOEIC/COMPASS TOEIC/Analyst TOEIC'], 1);
  assert.equal(analysis.filesAtRoot, 1);
  assert.equal(analysis.directoriesSeen, 1);
  assert.equal(analysis.counts['lisez-moi.txt'], undefined);
});

test('countFilesInListing tolère les entrées vides et les tailles invalides', () => {
  const analysis = countFilesInListing([null, {}, { type: 'file', path: '/A/b.pdf', size: 'x' }]);
  assert.equal(analysis.totalFiles, 1);
  assert.equal(analysis.totalBytes, 0);
  assert.equal(analysis.counts.A, 1);
  assert.equal(countFilesInListing(undefined).totalFiles, 0);
});

test('buildTreeUrl encode le bucket et le préfixe', () => {
  assert.equal(
    buildTreeUrl('ktongue/ENISE-SITE'),
    'https://huggingface.co/api/buckets/ktongue/ENISE-SITE/tree?recursive=true&limit=1000',
  );
  assert.equal(
    buildTreeUrl('ktongue/ENISE-SITE', 'GM/3A GM'),
    'https://huggingface.co/api/buckets/ktongue/ENISE-SITE/tree/GM/3A%20GM?recursive=true&limit=1000',
  );
});

test('parseNextLink suit la pagination rel="next"', () => {
  assert.equal(
    parseNextLink(
      '</api/buckets/x/y/tree?cursor=abc>; rel="next"',
      'https://huggingface.co/api/buckets/x/y/tree?limit=1000',
    ),
    'https://huggingface.co/api/buckets/x/y/tree?cursor=abc',
  );
  assert.equal(parseNextLink(null, 'https://example.com'), null);
  assert.equal(parseNextLink('</other>; rel="prev"', 'https://example.com'), null);
});

test('normalizePrefix nettoie le chemin', () => {
  assert.equal(normalizePrefix(' /GM/3A GM/ '), 'GM/3A GM');
  assert.equal(normalizePrefix(''), '');
  assert.throws(() => normalizePrefix('GM/../TOEIC'));
});

test('diffWithIndexDocument repère les dossiers affichés à 0', () => {
  const analysis = countFilesInListing(SAMPLE_LISTING);
  const diff = diffWithIndexDocument(analysis, { counts: {}, totalFiles: 0 });
  assert.equal(diff.coherent, false);
  assert.ok(diff.zeroOnSite.length > 0);
  assert.ok(diff.zeroOnSite.some((entry) => entry.path === 'GM' && entry.expected === 3));
  assert.equal(diff.totalExpected, 6);
  assert.equal(diff.totalOnSite, 0);
  const text = renderComparison(diff, 'site');
  assert.match(text, /affiché\(s\) « 0 »/);
  assert.match(text, /Purger le cache/);
});

test('diffWithIndexDocument valide un document conforme', () => {
  const analysis = countFilesInListing(SAMPLE_LISTING);
  const document = buildIndexDocument({
    bucketId: 'ktongue/ENISE-SITE',
    prefix: '',
    items: SAMPLE_LISTING,
    complete: true,
  });
  const diff = diffWithIndexDocument(analysis, document);
  assert.equal(diff.coherent, true);
  assert.match(renderComparison(diff, 'site'), /OK :/);
});

test('diffWithIndexDocument repère les valeurs divergentes et obsolètes', () => {
  const analysis = countFilesInListing(SAMPLE_LISTING);
  const diff = diffWithIndexDocument(analysis, {
    counts: { GM: 3, 'GM/3A GM': 99, TOEIC: 2, ANCIEN: 12 },
    totalFiles: 5,
  });
  assert.equal(diff.coherent, false);
  assert.ok(diff.mismatches.some((entry) => entry.path === 'GM/3A GM' && entry.actual === 99));
  assert.ok(diff.extraOnSite.some((entry) => entry.path === 'ANCIEN'));
  assert.ok(diff.missingOnSite.some((entry) => entry.path === 'GM/3A GM/S5'));
});

test('buildIndexDocument produit un document compatible /api/index', () => {
  const document = buildIndexDocument({
    bucketId: 'ktongue/ENISE-SITE',
    prefix: 'GM',
    items: SAMPLE_LISTING,
    complete: true,
  });
  assert.equal(document.bucketId, 'ktongue/ENISE-SITE');
  assert.equal(document.prefix, 'GM');
  assert.equal(document.generatedBy, 'scripts/count-bucket-files.mjs');
  assert.equal(document.complete, true);
  assert.equal(document.totalFiles, 6);
  assert.equal(document.counts.TOEIC, 2);
  assert.ok(document.fetchedAt);
  assert.ok(document.items.every((item) => ['file', 'directory'].includes(item.type)));
});

test('renderReport affiche la hiérarchie et respecte la profondeur', () => {
  const analysis = countFilesInListing(SAMPLE_LISTING);
  const full = renderReport(analysis);
  assert.match(full, /\(racine\) : 6 fichier\(s\)/);
  assert.match(full, /dont 1 à la racine/);
  assert.match(full, /Calcul Tensoriel : 2 fichier\(s\)/);

  const shallow = renderReport(analysis, { depth: 1 });
  assert.match(shallow, /^\s{2}GM : 3 fichier\(s\)/m);
  assert.doesNotMatch(shallow, /Calcul Tensoriel/);
});
