import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Ce que la table `profiles` sait du compte, et ce qu'elle ignore volontairement.
 *
 * Deux lacunes corrigées ici : `emailVerified` était provisionnée puis écrite par
 * personne (la colonne restait `false` même compte vérifié), et le filtre
 * `FILIERES.includes(…)` faisait disparaître une valeur en silence au lieu de
 * laisser l'`enum` de la table trancher. L'email, lui, ne doit JAMAIS atterrir
 * dans la table : une colonne écrite par le client serait du PII contresignable.
 */
process.env.VITE_APPWRITE_DATABASE_ID = 'enise_docs';

const { account, rows } = await import('../src/services/appwrite.js');
const { updateOwnProfile, upsertOwnProfile, verifyEmail } = await import('../src/services/appwriteAuth.js');

let captured = null;
const saved = { upsert: rows.upsert, get: rows.get, verification: account.updateVerification, accountGet: account.get, updateName: account.updateName };
test.beforeEach(() => {
  captured = null;
  rows.upsert = async (args) => { captured = args; return { $id: args.rowId, ...args.data }; };
  rows.get = async () => { throw Object.assign(new Error('Row not found'), { type: 'row_missing', code: 404 }); };
});
test.after(() => Object.assign(rows, { upsert: saved.upsert, get: saved.get }));

test('le drapeau de vérification vient de la session, jamais de la saisie', async () => {
  await upsertOwnProfile(
    { $id: 'user-1', email: 'camille@enise.fr', emailVerification: true },
    { displayName: 'Camille', promotion: '3A', filiere: 'GM', emailVerified: false, lastSeenAt: '1999-01-01T00:00:00Z' },
  );
  assert.equal(captured.data.emailVerified, true, 'la session a raison sur le payload du formulaire');
  assert.ok(!Number.isNaN(Date.parse(captured.data.lastSeenAt)), 'lastSeenAt doit rester une date ISO');
  assert.notEqual(captured.data.lastSeenAt, '1999-01-01T00:00:00Z');
  assert.equal(captured.data.displayName, 'Camille');
  assert.equal(captured.rowId, 'user-1', 'la ligne porte l’ID du compte : c’est la jointure avec Console → Users');
  assert.equal(captured.data.userId, 'user-1');
  assert.ok(!('email' in captured.data), 'aucune colonne email dans la table, par décision de conception');
});

test('une valeur hors liste est transmise à l’enum, pas écartée en silence', async () => {
  await upsertOwnProfile({ $id: 'user-2' }, { filiere: 'TOEIC', promotion: '4A' });
  assert.equal(captured.data.filiere, 'TOEIC', 'le serveur refuse (invalid_enum_value) et le message est traduit');
  assert.equal(captured.data.promotion, '4A');
});

test('la vérification d’email bascule le drapeau en base', async () => {
  account.updateVerification = async () => ({});
  account.get = async () => ({ $id: 'user-1', email: 'camille@enise.fr', emailVerification: true });
  assert.equal(await verifyEmail({ userId: 'user-1', secret: 'secret-verify' }), true);
  assert.equal(captured.data.emailVerified, true, 'sans cet écriture, la table affiche « non vérifié » pour un compte vérifié');

  captured = null;
  assert.equal(await verifyEmail({ userId: '', secret: '' }), null, 'lien incomplet = aucune écriture');
  assert.equal(captured, null);
});

test('updateOwnProfile conserve les drapeaux dérivés', async () => {
  account.get = async () => ({ $id: 'user-3', emailVerification: false, name: 'Léo' });
  account.updateName = async () => ({ name: 'Léo' });
  await updateOwnProfile({ bio: 'coucou', filiere: 'GP' });
  assert.equal(captured.data.emailVerified, false);
  assert.equal(captured.data.bio, 'coucou');
  assert.equal(captured.data.filiere, 'GP');
  assert.ok(captured.data.lastSeenAt);
});
