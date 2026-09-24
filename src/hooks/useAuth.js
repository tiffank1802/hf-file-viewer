import { useContext } from 'react';
import { AuthContext } from '../contexts/auth-context.js';

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth doit être utilisé dans AuthProvider.');
  }
  return value;
}
