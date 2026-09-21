import { ID, Permission, Role } from 'appwrite';
import { APPWRITE_OAUTH_PROVIDER } from '../config.js';
import {
  DATABASE_ID,
  PROFILE_TABLE_ID,
  account,
  describeAppwriteError,
  hasDatabase,
  isMissingSession,
  tables,
} from './appwrite.js';

/**
 * Flux de compte et de profil au-dessus d'Appwrite.
 *
 * Deux services, deux responsabilités :
 * - `Account` (Auth) porte l'identité : email, mot de passe haché,
 *   vérification, récupération, sessions. C'est LA base de comptes — on ne
 *   duplique jamais le mot de passe dans une table ;
 * - la table `profiles` (TablesDB) ne porte que les champs métier (promotion,
 *   filière, bio), avec des permissions par ligne limitées au propriétaire.
 *
 * Toute erreur Appwrite est traduite en message français porté par un `Error`
 * : les composants n'affichent jamais `error.message` brut.
 */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_DISPLAY_NAME = 128;
export const MAX_BIO = 280;
export const PROMOTIONS = ['3A', '4A', '5A', 'Alumni', 'Staff'];
export const FILIERES = ['GM', 'TOEIC', 'Autre'];

function authError(error, fallback) {
  return new Error(describeAppwriteError(error, fallback));
}

function redirectUrl(params) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

/** Validation locale : on n'appelle Appwrite qu'avec des chances de succès. */
export function validatePassword(password, { confirm } = {}) {
  const value = String(password ?? '');
  if (value.length < MIN_PASSWORD_LENGTH) return `Mot de passe trop court : ${MIN_PASSWORD_LENGTH} caractères minimum.`;
  if (value.length > 256) return 'Mot de passe trop long : 256 caractères maximum.';
  if (confirm !== undefined && value !== String(confirm ?? '')) return 'Les deux mots de passe diffèrent.';
  return null;
}

export function validateEmail(email) {
  const value = normalizeEmail(email);
  if (!value) return 'Indique une adresse email.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return 'Adresse email incomplète.';
  return null;
}

/* -------------------------------------------------------------------- compte */

export async function getCurrentUser() {
  try {
    return await account.get();
  } catch (error) {
    if (isMissingSession(error)) return null;
    throw authError(error, 'Le compte n’a pas pu être vérifié.');
  }
}

export async function signInWithPassword({ email, password }) {
  const cleanEmail = normalizeEmail(email);
  const emailIssue = validateEmail(cleanEmail);
  if (emailIssue) throw new Error(emailIssue);
  try {
    await account.createEmailPasswordSession({ email: cleanEmail, password });
    return await account.get();
  } catch (error) {
    throw authError(error, 'Connexion impossible.');
  }
}

export async function signUpWithPassword({ email, password, confirm, name, promotion, filiere }) {
  const cleanEmail = normalizeEmail(email);
  const emailIssue = validateEmail(cleanEmail);
  if (emailIssue) throw new Error(emailIssue);
  const passwordIssue = validatePassword(password, { confirm });
  if (passwordIssue) throw new Error(passwordIssue);

  const displayName = String(name ?? '').trim().slice(0, MAX_DISPLAY_NAME) || cleanEmail.split('@')[0];

  let user;
  try {
    user = await account.create({ userId: ID.unique(), email: cleanEmail, password, name: displayName });
  } catch (error) {
    throw authError(error, 'Inscription impossible.');
  }

  // Session immédiate : l'email de vérification part une fois connecté et
  // l'étudiant atteint la bibliothèque sans étape intermédiaire.
  try {
    await account.createEmailPasswordSession({ email: cleanEmail, password });
  } catch {
    throw authError(null, 'Compte créé, mais la connexion automatique a échoué. Connecte-toi à la main.');
  }

  await requestEmailVerification().catch(() => null);
  await upsertOwnProfile(user, { promotion, filiere, displayName }).catch(() => null);
  return user;
}

export async function signOut() {
  try {
    await account.deleteSessions();
  } catch (error) {
    if (!isMissingSession(error)) throw authError(error, 'Déconnexion impossible.');
  }
  return null;
}

export async function listActiveSessions() {
  try {
    const result = await account.listSessions();
    return Array.isArray(result?.sessions) ? result.sessions : [];
  } catch (error) {
    throw authError(error, 'Liste des sessions indisponible.');
  }
}

/** Déconnecte les autres appareils, garde l'onglet courant. */
export async function signOutOtherSessions() {
  const sessions = await listActiveSessions().catch(() => []);
  await Promise.all(
    sessions
      .filter((session) => !session?.current)
      .map((session) => account.deleteSession({ sessionId: session.$id }).catch(() => null)),
  );
  return listActiveSessions().catch(() => []);
}

/* ------------------------------------------------------- vérification d'email */

export async function requestEmailVerification() {
  try {
    return await account.createVerification({ url: redirectUrl({ verify: '1' }) });
  } catch (error) {
    throw authError(error, 'Envoi de l’email de vérification impossible.');
  }
}

/** Le lien d'email atterrit sur `?verify=1&userId=…&secret=…`. */
export function readVerificationParams(search = window.location.search) {
  const params = new URLSearchParams(search);
  const userId = params.get('userId');
  const secret = params.get('secret');
  if (!params.get('verify') || !userId || !secret) return null;
  return { userId, secret };
}

/**
 * `PUT /account/verification` exige une session : si l'étudiant ouvre le lien
 * hors connexion, l'appelant garde les paramètres et rejoue après la connexion.
 */
export async function verifyEmail({ userId, secret }) {
  if (!userId || !secret) return null;
  try {
    await account.updateVerification({ userId, secret });
  } catch (error) {
    if (isMissingSession(error)) return false;
    throw authError(error, 'Lien de vérification expiré. Relance l’envoi depuis ton profil.');
  }
  cleanUrlParams();
  return true;
}

/* --------------------------------------------------------- mot de passe oublié */

export async function requestPasswordRecovery(email) {
  const cleanEmail = normalizeEmail(email);
  const emailIssue = validateEmail(cleanEmail);
  if (emailIssue) throw new Error(emailIssue);
  try {
    await account.createRecovery({ email: cleanEmail, url: redirectUrl({ recover: '1' }) });
  } catch (error) {
    throw authError(error, 'Envoi du lien de récupération impossible.');
  }
  return cleanEmail;
}

/** Le lien d'email atterrit sur `?recover=1&userId=…&secret=…` : on ne lit que ça. */
export function readRecoveryParams(search = window.location.search) {
  const params = new URLSearchParams(search);
  const userId = params.get('userId');
  const secret = params.get('secret');
  if (!params.get('recover') || !userId || !secret) return null;
  return { userId, secret };
}

/** Le nouveau mot de passe vient du formulaire, jamais de l'URL. */
export async function completePasswordRecovery({ userId, secret, password }) {
  const passwordIssue = validatePassword(password);
  if (passwordIssue) throw new Error(passwordIssue);
  if (!userId || !secret) throw new Error('Lien de réinitialisation incomplet.');
  try {
    await account.updateRecovery({ userId, secret, password });
  } catch (error) {
    throw authError(error, 'Lien de réinitialisation expiré. Relance une demande.');
  }
  cleanUrlParams();
  return true;
}

export async function changePassword({ current, next, confirm }) {
  const passwordIssue = validatePassword(next, { confirm });
  if (passwordIssue) throw new Error(passwordIssue);
  try {
    return await account.updatePassword({ password: next, oldPassword: current || undefined });
  } catch (error) {
    throw authError(error, 'Changement de mot de passe refusé.');
  }
}

function cleanUrlParams() {
  const url = new URL(window.location.href);
  url.search = '';
  window.history.replaceState({}, '', `${url.toString()}${window.location.hash}`);
}

/* ---------------------------------------------------------------------- OAuth */

export function isOAuthEnabled() {
  return Boolean(APPWRITE_OAUTH_PROVIDER);
}

/** Redirige le navigateur vers le fournisseur ; aucune valeur de retour exploitable ici. */
export function beginOAuthSession({ provider = APPWRITE_OAUTH_PROVIDER, success, failure } = {}) {
  if (!provider) throw new Error('Connexion externe non activée sur ce projet.');
  account.createOAuth2Session({
    provider,
    success: success ?? redirectUrl({ oauth: '1' }),
    failure: failure ?? redirectUrl({ oauth: 'erreur' }),
  });
}

/* -------------------------------------------------------------------- profil */

function profilePermissions(userId) {
  return [
    Permission.read(Role.user(userId)),
    Permission.update(Role.user(userId)),
    Permission.delete(Role.user(userId)),
  ];
}

function cleanProfileInput({ displayName, bio, promotion, filiere } = {}) {
  const data = {};
  if (displayName !== undefined) data.displayName = String(displayName).trim().slice(0, MAX_DISPLAY_NAME);
  if (bio !== undefined) data.bio = String(bio).trim().slice(0, MAX_BIO);
  if (promotion !== undefined && PROMOTIONS.includes(promotion)) data.promotion = promotion;
  if (filiere !== undefined && FILIERES.includes(filiere)) data.filiere = filiere;
  return data;
}

/**
 * Ligne de profil du compte courant.
 *
 * `row_missing` n'est pas une erreur : un compte créé avant le provisioning, ou
 * via OAuth, n'a pas encore de ligne — on la crée à la volée.
 */
export async function readOwnProfile(user) {
  if (!hasDatabase() || !user?.$id) return null;
  try {
    return await tables.getRow({
      databaseId: DATABASE_ID,
      tableId: PROFILE_TABLE_ID,
      rowId: ID.custom(user.$id),
    });
  } catch (error) {
    if (error?.type === 'row_missing' || error?.code === 404) return upsertOwnProfile(user);
    throw authError(error, 'Profil illisible.');
  }
}

/** `upsertRow` rend l'opération idempotente : pas de conflit de ligne existante. */
export async function upsertOwnProfile(user, input = {}) {
  if (!hasDatabase() || !user?.$id) return null;
  try {
    return await tables.upsertRow({
      databaseId: DATABASE_ID,
      tableId: PROFILE_TABLE_ID,
      rowId: ID.custom(user.$id),
      data: { userId: user.$id, ...cleanProfileInput(input) },
      permissions: profilePermissions(user.$id),
    });
  } catch (error) {
    throw authError(error, 'Enregistrement du profil impossible.');
  }
}

export async function updateOwnProfile(input) {
  const user = await getCurrentUser();
  if (!user) throw new Error('Connecte-toi pour modifier ton profil.');
  const name = cleanProfileInput(input).displayName;
  // Sans table provisionnée, le nom vit quand même dans Auth.
  if (name) await account.updateName({ name }).catch(() => null);
  if (!hasDatabase()) return null;
  return upsertOwnProfile(user, input);
}

/** Préférences Auth : JSON libre, lisible et écrit uniquement par le propriétaire. */
export async function savePreferences(prefs) {
  try {
    return await account.updatePrefs(prefs ?? {});
  } catch (error) {
    throw authError(error, 'Préférences non enregistrées.');
  }
}

/**
 * Export des données de l'utilisateur (droit à la portabilité).
 *
 * La suppression du compte ne peut PAS se faire depuis le navigateur : le SDK
 * web 27 n'expose plus `account.delete()` — elle passe par `users.delete` côté
 * serveur (clé API), déclenchée par l'administrateur du projet.
 */
export async function buildExportBundle({ user, profile, favorites }) {
  return {
    genereLe: new Date().toISOString(),
    compte: user
      ? {
          id: user.$id,
          email: user.email ?? null,
          prenom: user.name ?? null,
          emailVerifie: Boolean(user.emailVerification),
          creeLe: user.$createdAt ?? null,
          derniereConnexion: user.accessedAt ?? null,
          labels: user.labels ?? [],
        }
      : null,
    profil: profile
      ? {
          promotion: profile.promotion ?? null,
          filiere: profile.filiere ?? null,
          bio: profile.bio ?? null,
          majLe: profile.$updatedAt ?? profile.$createdAt ?? null,
        }
      : null,
    favoris: (Array.isArray(favorites) ? favorites : []).map((item) => ({
      chemin: item.path,
      nom: item.name,
      note: item.note || '',
    })),
  };
}
