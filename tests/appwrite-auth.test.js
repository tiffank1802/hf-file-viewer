import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

import { describeAppwriteError, hasDatabase, isMissingRow, isMissingSession, rows } from '../src/services/appwrite.js';
import {
  MIN_PASSWORD_LENGTH,
  getCurrentUser,
  normalizeEmail,
  upsertOwnProfile,
  readOwnProfile,
  validateEmail,
  validatePassword,
} from '../src/services/appwriteAuth.js';
import {
  addFavorite,
  favoritesEnabled,
  listFavorites,
  pushFavorites,
} from '../src/services/favorites.js';

test('les erreurs Appwrite sont traduites par type, pas par statut HTTP', () => {
  assert.equal(
    describeAppwriteError({ type: 'user_already_exists', code: 409 }),
    'Un compte existe déjà avec cette adresse email.',
  );
  assert.equal(
    describeAppwriteError({ type: 'invalid_credentials', code: 401 }),
    'Email ou mot de passe incorrect.',
  );
  assert.equal(
    describeAppwriteError({ type: 'rate_limit_exceeded', code: 429 }),
    'Trop de tentatives. Réessaie dans quelques minutes.',
  );
  // 401 sans type connu : message de session, jamais le texte brut du serveur.
  assert.match(describeAppwriteError({ code: 401, response: 'Unauthorized' }), /Session expirée/);
  // Réponse inconnue : on capitalise le texte renvoyé, on ne casse pas l'UI.
  assert.equal(describeAppwriteError({ response: 'champ trop long' }), 'Champ trop long');
  assert.equal(describeAppwriteError(null, 'Rien à signaler.'), 'Rien à signaler.');
});

test('isMissingSession distingue « pas connecté » d’un vrai échec', () => {
  assert.equal(isMissingSession({ type: 'user_missing' }), true);
  assert.equal(isMissingSession({ code: 401 }), true);
  assert.equal(isMissingSession({ code: 500, type: 'general_unknown' }), false);
  assert.equal(isMissingSession(undefined), false);
});

test('la politique de mot de passe est appliquée avant l’appel réseau', () => {
  assert.equal(MIN_PASSWORD_LENGTH, 12);
  assert.match(validatePassword('court'), /12 caractères minimum/);
  assert.equal(validatePassword('un-mot-de-passe-solide'), null);
  assert.match(validatePassword('un-mot-de-passe-solide', { confirm: 'autre' }), /diffèrent/);
  assert.match(validatePassword('x'.repeat(300)), /trop long/);
});

test('l’email est normalisé et validé côté client', () => {
  assert.equal(normalizeEmail('  Aicha.BELL@ENISE.fr '), 'aicha.bell@enise.fr');
  assert.match(validateEmail('pas-un-email'), /incomplète/);
  assert.match(validateEmail(''), /Indique une adresse email/);
  assert.equal(validateEmail('a@b.fr'), null);
});

test('sans base provisionnée, aucune requête réseau n’est tentée', async () => {
  // C'est ce qui rend le drapeau de fonctionnalité inoffensif avant le provisioning.
  assert.equal(hasDatabase(), false);
  assert.equal(favoritesEnabled(), false);
  assert.deepEqual(await listFavorites('user-1'), []);
  assert.equal(await addFavorite('user-1', { path: 'a.pdf' }), null);
  assert.deepEqual(await pushFavorites('user-1', [{ path: 'a.pdf' }]), { pushed: 0, failed: [] });
  assert.equal(await readOwnProfile({ $id: 'user-1' }), null);
  assert.equal(await upsertOwnProfile({ $id: 'user-1' }, { promotion: '3A' }), null);
});

test('la façade de lignes expose un contrat unique aux deux dialectes', () => {
  for (const method of ['get', 'list', 'create', 'update', 'remove', 'upsert']) {
    assert.equal(typeof rows[method], 'function', `rows.${method} doit exister`);
  }
  // Les deux API ne parlent pas le même vocabulaire : le reste de l'app ne doit
  // jamais le connaître (sinon la bascule --flavor=databases casserait).
  for (const file of ['src/services/favorites.js', 'src/services/appwriteAuth.js']) {
    const source = readFileSync(resolve(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /tables\.\w+Row\(/, `${file} doit passer par rows.*, pas tables.*Row`);
    assert.doesNotMatch(source, /databases\.\w+Document\(/, `${file} doit passer par rows.*, pas databases.*Document`);
  }
});

test('isMissingRow couvre les deux vocabulaires d’erreur', () => {
  assert.equal(isMissingRow({ type: 'row_missing' }), true);
  assert.equal(isMissingRow({ type: 'document_missing' }), true);
  assert.equal(isMissingRow({ code: 404 }), true);
  assert.equal(isMissingRow({ code: 403, type: 'user_unauthorized' }), false);
  // Et le message reste français pour un utilisateur non autorisé.
  assert.equal(
    describeAppwriteError({ type: 'user_unauthorized', code: 403 }),
    'Permission refusée par Appwrite : ce compte n’a pas accès à cette donnée.',
  );
  assert.equal(describeAppwriteError({ type: 'table_not_found', code: 404 }), 'Table absente du projet : relance npm run appwrite:setup.');
});

test('une panne réseau remonte un message français, jamais « Fetch failed »', async () => {
  await assert.rejects(() => getCurrentUser(), /Appwrite est injoignable/);
  assert.equal(
    describeAppwriteError(new Error('fetch failed')),
    'Appwrite est injoignable : réseau coupé, ou ce domaine n’est pas déclaré dans Settings → Domains & Platforms.',
  );
  assert.equal(describeAppwriteError(new TypeError('Failed to fetch')), 'Appwrite est injoignable : réseau coupé, ou ce domaine n’est pas déclaré dans Settings → Domains & Platforms.');
});
