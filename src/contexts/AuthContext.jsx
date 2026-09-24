import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthContext } from './auth-context.js';
import {
  cleanAuthParams,
  confirmVerification,
  finishRecovery,
  getSession,
  readLinkParams,
  requestRecovery,
  requestVerification,
  saveProfile,
  changePassword,
  signIn as signInRequest,
  signOut as signOutRequest,
  signUp as signUpRequest,
} from '../services/authApi.js';

/**
 * Session du visiteur, lue uniquement via le backend Go.
 * Le secret Appwrite reste dans un cookie HttpOnly : ce contexte ne le voit pas.
 */
export default function AuthProvider({ children }) {
  const [status, setStatus] = useState('loading');
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [configured, setConfigured] = useState(false);
  const [profileTable, setProfileTable] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [recovery, setRecovery] = useState(() => readLinkParams('recover'));
  const pendingVerification = useRef(readLinkParams('verify'));

  const applySession = useCallback((payload) => {
    setConfigured(Boolean(payload?.configured));
    setProfileTable(Boolean(payload?.profileTable));
    setUser(payload?.user ?? null);
    setProfile(payload?.profile ?? null);
    setStatus(payload?.configured ? (payload.user ? 'authenticated' : 'anonymous') : 'unavailable');
    return payload?.user ?? null;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const payload = await getSession();
      return applySession(payload);
    } catch {
      setConfigured(false);
      setUser(null);
      setProfile(null);
      setStatus('unavailable');
      return null;
    }
  }, [applySession]);

  useEffect(() => {
    let alive = true;
    refresh().then(async (nextUser) => {
      if (!alive || !pendingVerification.current) return;
      try {
        const result = await confirmVerification(pendingVerification.current);
        pendingVerification.current = null;
        cleanAuthParams();
        if (!alive) return;
        setNotice(result.notice || 'Adresse email vérifiée.');
        await refresh();
      } catch (err) {
        if (!alive) return;
        if (!nextUser) {
          setNotice('Connecte-toi, puis rouvre le lien pour confirmer l’adresse.');
          return;
        }
        setError(err?.message || 'Vérification impossible.');
      }
    });
    return () => {
      alive = false;
    };
  }, [refresh]);

  const value = useMemo(() => ({
    status,
    user,
    profile,
    error,
    notice,
    recovery,
    configured,
    profileTable,
    isAuthenticated: Boolean(user),
    isProvisioned: configured,
    clearMessages: () => {
      setError(null);
      setNotice(null);
    },
    signIn: async ({ email, password }) => {
      setError(null);
      const payload = await signInRequest(email, password);
      applySession(payload);
      if (pendingVerification.current) {
        try {
          const result = await confirmVerification(pendingVerification.current);
          pendingVerification.current = null;
          cleanAuthParams();
          setNotice(result.notice || 'Adresse email vérifiée.');
          await refresh();
        } catch (err) {
          setError(err?.message || 'Vérification impossible.');
        }
      }
      return payload.user;
    },
    signUp: async (payload) => {
      setError(null);
      const result = await signUpRequest(payload);
      await refresh();
      setNotice(result.notice || 'Compte créé.');
      return result;
    },
    signOut: async () => {
      await signOutRequest().catch(() => null);
      setUser(null);
      setProfile(null);
      setStatus(configured ? 'anonymous' : 'unavailable');
    },
    saveProfile: async (input) => {
      const result = await saveProfile(input);
      if (result.user) setUser(result.user);
      setProfile(result.profile ?? null);
      setNotice(result.notice || 'Profil mis à jour.');
      return result;
    },
    changePassword: async (input) => {
      const result = await changePassword(input);
      setNotice(result.notice || 'Mot de passe mis à jour.');
      return result;
    },
    requestVerification: async () => {
      const result = await requestVerification();
      setNotice(result.notice || 'Email de vérification renvoyé.');
    },
    requestRecovery: async (email) => {
      const result = await requestRecovery(email);
      setNotice(result.notice || 'Email envoyé si le compte existe.');
    },
    finishRecovery: async (input) => {
      const result = await finishRecovery({ ...recovery, ...input });
      setRecovery(null);
      cleanAuthParams();
      setUser(null);
      setProfile(null);
      setStatus(configured ? 'anonymous' : 'unavailable');
      setNotice(result.notice || 'Mot de passe mis à jour. Connecte-toi avec le nouveau.');
    },
    refresh,
  }), [applySession, configured, error, notice, profile, profileTable, recovery, refresh, status, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
