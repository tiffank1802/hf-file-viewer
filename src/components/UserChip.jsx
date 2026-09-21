import { useEffect, useRef, useState } from 'react';
import { FiChevronDown, FiHeart, FiLogOut, FiUser } from 'react-icons/fi';
import { useAuth } from '../hooks/useAuth.js';

function initialsOf(user) {
  const source = String(user?.name || user?.email || '?').trim();
  const parts = source.split(/[\s._@-]+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '');
  return letters.toUpperCase();
}

/**
 * Puce de compte dans l'en-tête : état connecté avec menu court, ou bouton
 * d'appel à la connexion. Rien n'est affiché tant qu'Appwrite n'est pas
 * joignable du tout, pour ne pas proposer une impasse.
 */
export default function UserChip({ favoriteCount = 0, onOpenAuth, onOpenFavorites }) {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!auth.isProvisioned && !auth.isAuthenticated) return null;

  if (!auth.isAuthenticated) {
    return (
      <button type="button" className="user-chip user-chip--guest" onClick={() => onOpenAuth?.('signin')}>
        <FiUser aria-hidden="true" />
        <span>Se connecter</span>
      </button>
    );
  }

  const firstName = String(auth.user?.name || auth.user?.email || '').split(/[\s@._-]+/)[0] || 'Mon compte';

  return (
    <div className="user-chip-wrap" ref={rootRef}>
      <button
        type="button"
        className="user-chip"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="user-chip-avatar" aria-hidden="true">{initialsOf(auth.user)}</span>
        <span className="user-chip-name">{firstName}</span>
        <FiChevronDown aria-hidden="true" />
      </button>

      {open && (
        <div className="user-menu" role="menu">
          <p className="user-menu-mail">{auth.user?.email}</p>
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onOpenAuth?.('profile'); }}
          >
            <FiUser aria-hidden="true" /> Profil &amp; sécurité
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onOpenFavorites?.(); }}
          >
            <FiHeart aria-hidden="true" /> Mes favoris{favoriteCount ? ` (${favoriteCount})` : ''}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={async () => { setOpen(false); await auth.signOut(); }}
          >
            <FiLogOut aria-hidden="true" /> Se déconnecter
          </button>
        </div>
      )}
    </div>
  );
}
