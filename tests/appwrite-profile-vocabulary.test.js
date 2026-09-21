import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PROFILE_FILIERES, PROFILE_PROMOTIONS } from '../src/config.js';
import { FILIERES, PROMOTIONS } from '../src/services/appwriteAuth.js';
import { TABLES, enumColumns, enumDrift } from '../scripts/appwrite-spec.js';

/**
 * Le formulaire et la table doivent parler le même vocabulaire.
 *
 * Une option de <select> absente de l'`enum` Appwrite se traduit par un refus
 * `invalid_enum_value` côté serveur — et l'inverse (une valeur dans l'enum mais
 * pas dans l'UI) est une filière invisible. Les deux listes ne sont donc pas
 * deux détails de configuration : c'est un seul contrat, vérifié ici.
 */
const here = dirname(fileURLToPath(import.meta.url));
const profiles = TABLES.find((table) => table.id === 'profiles');
const enumOf = (key) => profiles.columns.find((column) => column.key === key);

test('l’UI et le provisioning partagent exactement les mêmes listes', () => {
  assert.deepEqual([...FILIERES], [...PROFILE_FILIERES]);
  assert.deepEqual([...PROMOTIONS], [...PROFILE_PROMOTIONS]);
  assert.deepEqual([...enumOf('filiere').elements], [...PROFILE_FILIERES],
    'l’enum `filiere` de la table doit être le vocabulaire de src/config.js');
  assert.deepEqual([...enumOf('promotion').elements], [...PROFILE_PROMOTIONS]);
});

test('les valeurs par défaut des colonnes existent dans leur enum', () => {
  for (const { column } of enumColumns(TABLES)) {
    assert.ok(column.elements.includes(column.default), `${column.key} : défaut « ${column.default} » absent de l'enum`);
  }
});

test('chaque valeur d’enum reste un nom de chemin utilisable', () => {
  // Par convention, une filière porte le nom du dossier correspondant dans le
  // bucket (GM/, GC/, GP/). Un accent ou un espace dans la liste produirait une
  // URL d'aperçu invalide dès qu'on brancherait le filtrage sur le profil.
  for (const value of PROFILE_FILIERES) {
    assert.match(value, /^[A-Za-z0-9]+$/, `filière « ${value} » : que des lettres/chiffres, sinon chemin invalide`);
  }
  assert.ok(PROFILE_FILIERES.includes('Autre'), 'une valeur de repli doit exister');
});

test('AuthPanel consomme les listes partagées, pas une copie littérale', () => {
  const panel = readFileSync(resolve(here, '../src/components/AuthPanel.jsx'), 'utf8');
  assert.match(panel, /import \{[\s\S]*FILIERES[\s\S]*PROMOTIONS[\s\S]*\} from '\.\.\/services\/appwriteAuth\.js'/,
    'le panneau doit consommer les listes exportées, pas les redéclarer');
  assert.doesNotMatch(panel, /const (FILIERES|PROMOTIONS) = \[/, 'aucune liste en dur dans le composant');
});

test('enumDrift signale une colonne restée sur l’ancienne liste', () => {
  const filiere = enumOf('filiere');
  assert.deepEqual(enumDrift(filiere, { elements: ['GM', 'TOEIC', 'Autre'] }), {
    missing: ['GC', 'GP'],
    extra: ['TOEIC'],
  });
  assert.equal(enumDrift(filiere, { elements: [...PROFILE_FILIERES] }), null);
  // Colonne absente ou réponse sans éléments : pas de rapport fantôme.
  assert.equal(enumDrift(filiere, undefined), null);
  assert.equal(enumDrift(filiere, { type: 'string' }), null);
});
