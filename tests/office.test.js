import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isOfficeConvertibleExtension as isConvertibleFile,
  isOfficeWebViewerExtension,
  officeLocalKind,
} from '../src/utils/files.js';
import {
  getOfficeConvertUrl,
  isOfficeConvertibleExtension as isConvertibleWorker,
  makeOfficeSourceKey,
} from '../worker/index.js';

test('le type de rendu local est détecté par extension', () => {
  assert.equal(officeLocalKind('docx'), 'docx');
  assert.equal(officeLocalKind('DOCM'), 'docx');
  assert.equal(officeLocalKind('xlsx'), 'xlsx');
  assert.equal(officeLocalKind('xls'), 'xlsx');
  assert.equal(officeLocalKind('xlsm'), 'xlsx');
  assert.equal(officeLocalKind('pptx'), 'pptx');
  assert.equal(officeLocalKind('pptm'), 'pptx');
  assert.equal(officeLocalKind('doc'), null);
  assert.equal(officeLocalKind('ppt'), null);
  assert.equal(officeLocalKind('odt'), null);
  assert.equal(officeLocalKind('pdf'), null);
  assert.equal(officeLocalKind(''), null);
});

test('les extensions convertibles sont les mêmes côté front et Worker', () => {
  const convertible = ['doc', 'docx', 'docm', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'pptm', 'odt', 'ods', 'odp'];
  for (const extension of convertible) {
    assert.equal(isConvertibleFile(extension), true, extension);
    assert.equal(isConvertibleWorker(extension), true, extension);
    assert.equal(isConvertibleFile(extension.toUpperCase()), true, extension);
    assert.equal(isConvertibleWorker(extension.toUpperCase()), true, extension);
  }
  for (const extension of ['pdf', 'one', 'url', 'txt', 'potx', 'ppsx', 'zip', '']) {
    assert.equal(isConvertibleFile(extension), false, extension);
    assert.equal(isConvertibleWorker(extension), false, extension);
  }
});

test('l’URL de conversion est normalisée (espaces et slash final)', () => {
  assert.equal(getOfficeConvertUrl({}), '');
  assert.equal(getOfficeConvertUrl({ OFFICE_CONVERT_URL: '' }), '');
  assert.equal(
    getOfficeConvertUrl({ OFFICE_CONVERT_URL: 'https://demo.hf.space///' }),
    'https://demo.hf.space',
  );
  assert.equal(
    getOfficeConvertUrl({ OFFICE_CONVERT_URL: '  https://demo.hf.space  ' }),
    'https://demo.hf.space',
  );
});

test('les clés de conversion sont stables, courtes et sensibles au contenu', () => {
  const first = makeOfficeSourceKey('GM/cours.docx', '1024', '2026-01-01');
  assert.equal(first.length, 32);
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.equal(first, makeOfficeSourceKey('GM/cours.docx', '1024', '2026-01-01'));
  assert.notEqual(first, makeOfficeSourceKey('GM/cours.docx', '2048', '2026-01-01'));
  assert.notEqual(first, makeOfficeSourceKey('GM/autre.docx', '1024', '2026-01-01'));
  assert.notEqual(first, makeOfficeSourceKey('GM/cours.docx', '1024', '2026-02-01'));
});

test('le viewer Microsoft couvre les formats legacy et OpenDocument', () => {
  const viewer = [
    'doc', 'docx', 'docm', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'pptm',
    'potx', 'ppsx', 'odt', 'ods', 'odp',
  ];
  for (const extension of viewer) {
    assert.equal(isOfficeWebViewerExtension(extension), true, extension);
    assert.equal(isOfficeWebViewerExtension(extension.toUpperCase()), true, extension);
  }
  for (const extension of ['pdf', 'one', 'onenote', 'url', 'txt', 'rtf', 'zip', '']) {
    assert.equal(isOfficeWebViewerExtension(extension), false, extension);
  }
});
