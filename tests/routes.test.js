import test from 'node:test';
import assert from 'node:assert/strict';
import { hashFromPath, pathFromHash } from '../src/utils/routes.js';

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
