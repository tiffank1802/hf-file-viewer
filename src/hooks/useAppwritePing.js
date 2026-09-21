import { useSyncExternalStore } from 'react';
import {
  ensureAppwritePing,
  getAppwritePingState,
  retryAppwritePing,
  subscribeAppwritePing,
} from '../services/appwrite.js';

/**
 * Expose l'état du `client.ping()` à React et relance la mesure si besoin.
 * `useSyncExternalStore` évite un Contexte pour une seule valeur globale.
 */
export function useAppwritePing() {
  const state = useSyncExternalStore(subscribeAppwritePing, getAppwritePingState, getAppwritePingState);
  return {
    ...state,
    ping: ensureAppwritePing,
    retry: retryAppwritePing,
  };
}
