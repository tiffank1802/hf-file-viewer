import { useContext } from 'react';
import { AuthContext } from '../contexts/auth-context.js';

/**
 * Accès au contexte d'authentification.
 *
 * Hors `AuthProvider` (tests, Storybook, un composant réutilisé ailleurs), un
 * objet neutre est renvoyé plutôt qu'une exception : l'interface documentaire
 * doit continuer de fonctionner sans la session.
 */
const NEUTRAL = {
  status: 'unavailable',
  user: null,
  profile: null,
  error: null,
  notice: null,
  isAuthenticated: false,
  isProvisioned: false,
  recovery: null,
  clearMessages: () => {},
  signIn: async () => { throw new Error('AuthProvider manquant.'); },
  signUp: async () => { throw new Error('AuthProvider manquant.'); },
  signOut: async () => {},
  saveProfile: async () => null,
  requestRecovery: async () => {},
  finishRecovery: async () => {},
  refresh: async () => null,
};

export function useAuth() {
  const context = useContext(AuthContext);
  return context ?? NEUTRAL;
}

export function useIsAuthenticated() {
  return useAuth().isAuthenticated;
}
