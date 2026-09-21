import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthContext } from './auth-context.js';
import { APPWRITE_ENABLED } from '../config.js';
import {
  completePasswordRecovery,
  describeDataWrites,
  getCurrentUser,
  readOwnProfile,
  readRecoveryParams,
  readVerificationParams,
  requestPasswordRecovery,
  signInWithPassword,
  signOut,
  signUpWithPassword,
  updateOwnProfile,
  verifyEmail,
} from '../services/appwriteAuth.js';

/**
 * Session et profil du visiteur, au-dessus du service `appwriteAuth`.
 *
 * Règles volontaires :
 * - l'app reste utilisable sans Appwrite : `status` vaut `'unavailable'` et
 *   aucun appel réseau n'est tenté ;
 * - une erreur d'authentification ne casse jamais l'affichage de la
 *   bibliothèque : elle est remontée à l'UI, pas lancée dans la console ;
 * - les liens d'email (vérification, mot de passe oublié) sont lus au
 *   démarrage et rejoués dès qu'une session existe, car l'API exige d'être
 *   connecté.
 */
export default function AuthProvider({ children }) {
  const [status, setStatus] = useState(APPWRITE_ENABLED ? 'loading' : 'unavailable');
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const pendingVerification = useRef(null);
  const [recovery, setRecovery] = useState(() => (APPWRITE_ENABLED ? readRecoveryParams() : null));

  const applyUser = useCallback(async (nextUser) => {
    setUser(nextUser ?? null);
    if (!nextUser) {
      setProfile(null);
      setStatus(APPWRITE_ENABLED ? 'anonymous' : 'unavailable');
      return null;
    }
    const row = await readOwnProfile(nextUser).catch(() => null);
    setProfile(row ?? null);
    setStatus('authenticated');
    return row;
  }, []);

  const refresh = useCallback(async () => {
    if (!APPWRITE_ENABLED) return null;
    try {
      const nextUser = await getCurrentUser();
      const row = await applyUser(nextUser);
      if (nextUser && pendingVerification.current) {
        const done = await verifyEmail(pendingVerification.current).catch(() => false);
        pendingVerification.current = null;
        if (done) {
          setNotice('Adresse email vérifiée.');
          const fresh = await getCurrentUser().catch(() => nextUser);
          await applyUser(fresh ?? nextUser);
        }
      }
      return row;
    } catch (err) {
      setError(err?.message || 'État de connexion indisponible.');
      setStatus('error');
      return null;
    }
  }, [applyUser]);

  useEffect(() => {
    if (!APPWRITE_ENABLED) return undefined;
    let alive = true;
    pendingVerification.current = readVerificationParams();
    refresh().finally(() => {
      if (!alive) return;
      // Le lien était ouvert hors connexion : on le rejoue maintenant.
      if (pendingVerification.current) void refresh();
    });
    return () => {
      alive = false;
    };
  }, [refresh]);

  const value = useMemo(
    () => ({
      status,
      user,
      profile,
      error,
      notice,
      isAuthenticated: Boolean(user),
      isProvisioned: APPWRITE_ENABLED,
      // Causes lisibles d'un profil qui ne s'écrit pas ; vide = tout est en place.
      dataWriteReasons: describeDataWrites(),
      recovery,
      clearMessages: () => {
        setError(null);
        setNotice(null);
      },
      signIn: async (credentials) => {
        setError(null);
        const nextUser = await signInWithPassword(credentials);
        await applyUser(nextUser);
        return nextUser;
      },
      signUp: async (payload) => {
        setError(null);
        const { user: nextUser, profile } = await signUpWithPassword(payload);
        await applyUser(nextUser);
        // Le compte vit dans Auth (Console → Users) ; la ligne de profil vit dans
        // TablesDB. Les deux n'échouent pas ensemble : le message doit dire lequel
        // a manqué, sinon « je ne le vois pas dans la base » devient indéchiffrable.
        setNotice(profile?.saved
          ? 'Compte créé, profil enregistré.'
          : `Compte créé, mais aucune ligne dans la table profils : ${profile?.reason ?? 'cause inconnue.'}`);
        return { user: nextUser, profile };
      },
      signOut: async () => {
        await signOut();
        setUser(null);
        setProfile(null);
        setStatus(APPWRITE_ENABLED ? 'anonymous' : 'unavailable');
      },
      saveProfile: async (input) => {
        const row = await updateOwnProfile(input);
        if (row) setProfile(row);
        setNotice('Profil mis à jour.');
        return row;
      },
      requestRecovery: async (email) => {
        await requestPasswordRecovery(email);
        setNotice('Un email de réinitialisation vient d’être envoyé s’il existe un compte pour cette adresse.');
      },
      finishRecovery: async ({ userId, secret, password }) => {
        await completePasswordRecovery({ userId, secret, password });
        setRecovery(null);
        setNotice('Mot de passe mis à jour. Tu es connecté.');
        await refresh();
      },
      refresh,
    }),
    [applyUser, error, notice, profile, recovery, refresh, status, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
