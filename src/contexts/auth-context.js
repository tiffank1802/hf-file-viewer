import { createContext } from 'react';

/**
 * Séparé du `AuthProvider` pour que le fichier `.jsx` n'exporte qu'un composant
 * (règle `react-refresh/only-export-components` d'ESLint).
 */
export const AuthContext = createContext(null);
