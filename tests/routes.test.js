import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashFromPath,
  hrefFromLibraryPath,
  pathFromHash,
  pathFromLocation,
  pathFromPathname,
} from '../src/utils/routes.js';

test('les routes de dossiers conservent espaces et accents', () => {
  const hash = hashFromPath('GM/3A GM/Mécanique');
  assert.equal(hash, '#/GM/3A%20GM/M%C3%A9canique');
  assert.equal(pathFromHash(hash), 'GM/3A GM/Mécanique');
});

test('les ancres de page ne sont pas interprétées comme des dossiers', () => {
  assert.equal(pathFromHash('#main-content'), null);
  assert.equal(pathFromHash('#about'), null);
  assert.equal(pathFromHash('#/'), '');
});

test('les liens profonds History API sous /bibliotheque sont reconstruits', () => {
  assert.equal(hrefFromLibraryPath('GM/3A GM/Mécanique'), '/bibliotheque/GM/3A%20GM/M%C3%A9canique');
  assert.equal(pathFromPathname('/bibliotheque/GM/3A%20GM/M%C3%A9canique'), 'GM/3A GM/Mécanique');
  assert.equal(pathFromPathname('/'), '');
  assert.equal(
    pathFromLocation({ pathname: '/bibliotheque/TOEIC', hash: '' }),
    'TOEIC',
  );
});
