/**
 * Garde-fou d'architecture : les favoris ne vivent que dans le compte.
 *
 * Le défaut d'origine n'était pas une panne réseau, c'était le dessin : un miroir
 * `localStorage` que la synchro laissait derrière lui quand la lecture du cloud
 * échouait. La règle « source = compte » ne tient que si personne ne réintroduit
 * d'écriture locale par-derrière — d'où ce test, dans l'esprit de
 * `tests/appwrite-config.test.js` (aucune clé serveur dans une variable `VITE_`).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/** Le commentaire explique l'architecture ; lui non plus ne doit pas être une
 preuve. On ne garde que le code. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

const files = [
  'src/hooks/useFavorites.js',
  'src/services/favorites.js',
  'src/utils/favoritesEntry.js',
  'src/App.jsx',
];

for (const file of files) {
  test(`${file} n'écrit jamais les favoris dans un stockage du navigateur`, () => {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /useLocalStorage\(/, 'le hook de stockage local est retiré des favoris');
    assert.doesNotMatch(source, /localStorage\.(setItem|removeItem)/, 'la seule écriture locale est le drainage de l\'ancien cache');
    assert.doesNotMatch(source, /sessionStorage/, 'ni sessionStorage, ni IndexedDB de secours');
  });
}

test('les modules de favoris restent sans dépendance navigateur', () => {
  // `favoritesEntry.js` est appelé par le Worker et par les tests Node : un
  // `window` ici le rendrait inutilisable hors navigateur.
  const utils = code(readFileSync('src/utils/favoritesEntry.js', 'utf8'));
  assert.doesNotMatch(utils, /window\.|document\.|localStorage|indexedDB/);
  assert.doesNotMatch(utils, /from 'appwrite'/, 'aucun import du SDK dans les règles pures');
});

test('le drainage de l\'ancien cache est la seule écriture locale tolérée', () => {
  const legacy = readFileSync('src/services/favoritesLegacy.js', 'utf8');
  assert.match(legacy, /removeItem\(LEGACY_FAVORITES_KEY\)/, 'la clé doit être supprimée, pas seulement vidée');
  assert.match(legacy, /removeItem\(LEGACY_TOMBSTONES_KEY\)/, 'la file de suppressions locales na plus de sens sans miroir');
  assert.match(legacy, /typeof window === 'undefined'/, 'les tests Node appellent ces fonctions sans DOM');
  // Les anciennes clés ne sont jamais réalimentées par l'app : rien ne réécrit
  // la liste courante, seulement le reliquat refusé.
  assert.match(legacy, /setItem\(LEGACY_FAVORITES_KEY, JSON\.stringify\(list\)\)/);
  assert.equal(legacy.match(/setItem/g, []).length, 1, 'une seule écriture, et elle est bornée au reliquat');
});
