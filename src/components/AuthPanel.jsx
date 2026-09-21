import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FiAlertCircle,
  FiCheck,
  FiDownload,
  FiEye,
  FiEyeOff,
  FiLogOut,
  FiRefreshCw,
  FiShield,
  FiX,
} from 'react-icons/fi';
import { useAuth } from '../hooks/useAuth.js';
import {
  FILIERES,
  MIN_PASSWORD_LENGTH,
  PROMOTIONS,
  buildExportBundle,
  isOAuthEnabled,
  beginOAuthSession,
  listActiveSessions,
  requestEmailVerification,
  signOutOtherSessions,
  changePassword,
} from '../services/appwriteAuth.js';

/**
 * Panneau unique de compte : connexion, inscription, mot de passe oublié,
 * profil. Un seul écran plutôt que quatre modales séparées — et un seul endroit
 * où traduire les erreurs Appwrite.
 */
const TABS = [
  { id: 'signin', label: 'Connexion' },
  { id: 'signup', label: 'Inscription' },
  { id: 'recover', label: 'Mot de passe oublié' },
  { id: 'profile', label: 'Mon profil' },
];

function Field({ label, hint, error, children, htmlFor }) {
  return (
    <label className="auth-field" htmlFor={htmlFor}>
      <span>{label}</span>
      {children}
      {hint && !error ? <small>{hint}</small> : null}
      {error ? <small className="auth-field-error">{error}</small> : null}
    </label>
  );
}

export default function AuthPanel({ open, mode = 'signin', onModeChange, onClose, favorites }) {
  const auth = useAuth();
  const [form, setForm] = useState({
    email: '', password: '', confirm: '', name: '',
    promotion: PROMOTIONS[0], filiere: FILIERES[0], bio: '',
    current: '', next: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState(null);
  const [sessions, setSessions] = useState(null);
  const closeRef = useRef(null);

  // Un lien de réinitialisation ouvert alors qu'une session existe prime sur l'onglet profil.
  const activeMode = auth.recovery ? 'recover' : (auth.isAuthenticated ? 'profile' : mode);

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    document.body.classList.add('modal-open');
    closeRef.current?.focus();
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.classList.remove('modal-open');
      window.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) { setLocalError(null); setPending(false); setSessions(null); }
  }, [open]);

  useEffect(() => {
    if (auth.recovery && open) onModeChange?.('recover');
  }, [auth.recovery, onModeChange, open]);

  // Le profil s'ouvre pré-rempli par les valeurs réellement stockées.
  useEffect(() => {
    if (!open || !auth.isAuthenticated) return;
    setForm((current) => ({
      ...current,
      name: auth.user?.name ?? '',
      promotion: auth.profile?.promotion ?? current.promotion ?? PROMOTIONS[0],
      filiere: auth.profile?.filiere ?? current.filiere ?? FILIERES[0],
      bio: auth.profile?.bio ?? '',
    }));
  }, [open, activeMode, auth.isAuthenticated, auth.user, auth.profile]);

  const update = useCallback((key) => (event) => {
    setForm((current) => ({ ...current, [key]: event.target.value }));
  }, []);

  const run = useCallback(async (action) => {
    setPending(true);
    setLocalError(null);
    auth.clearMessages();
    try {
      await action();
      return true;
    } catch (error) {
      setLocalError(error?.message || 'Action impossible pour le moment.');
      return false;
    } finally {
      setPending(false);
    }
  }, [auth]);

  const submitSignIn = (event) => {
    event.preventDefault();
    void run(async () => {
      await auth.signIn({ email: form.email, password: form.password });
      onClose?.();
    });
  };

  const submitSignUp = (event) => {
    event.preventDefault();
    void run(async () => {
      await auth.signUp({
        email: form.email,
        password: form.password,
        confirm: form.confirm,
        name: form.name,
        promotion: form.promotion,
        filiere: form.filiere,
      });
      onClose?.();
    });
  };

  const submitRecovery = (event) => {
    event.preventDefault();
    if (auth.recovery) {
      void run(async () => {
        await auth.finishRecovery({ ...auth.recovery, password: form.password });
        onModeChange?.('signin');
      });
      return;
    }
    void run(() => auth.requestRecovery(form.email));
  };

  const submitProfile = (event) => {
    event.preventDefault();
    void run(() => auth.saveProfile({
      displayName: form.name,
      promotion: form.promotion,
      filiere: form.filiere,
      bio: form.bio,
    }));
  };

  const submitPasswordChange = (event) => {
    event.preventDefault();
    void run(async () => {
      await changePassword({ current: form.current, next: form.next, confirm: form.confirm });
      setForm((current) => ({ ...current, current: '', next: '', confirm: '' }));
    });
  };

  const downloadBundle = () => {
    void run(async () => {
      const bundle = await buildExportBundle({
        user: auth.user,
        profile: auth.profile,
        favorites: favorites?.items ?? [],
      });
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'enise-docs-mon-compte.json';
      link.click();
      URL.revokeObjectURL(url);
    });
  };

  if (!open) return null;

  const message = localError ?? auth.error;
  const verified = Boolean(auth.user?.emailVerification);

  return (
    <div className="modal-backdrop auth-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <section className="auth-card" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <header className="auth-head">
          <h2 id="auth-title">Compte étudiant</h2>
          <p>Retrouve tes favoris sur n’importe quel poste. Le mot de passe reste chiffré côté Appwrite.</p>
          <button ref={closeRef} className="auth-close" type="button" onClick={onClose} aria-label="Fermer">
            <FiX aria-hidden="true" />
          </button>
        </header>

        <div className="auth-tabs" role="tablist" aria-label="Actions du compte">
          {TABS.filter((tab) => {
            if (auth.recovery) return tab.id === 'recover';
            return auth.isAuthenticated ? tab.id === 'profile' : tab.id !== 'profile';
          }).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeMode === tab.id}
              className={activeMode === tab.id ? 'is-active' : ''}
              onClick={() => onModeChange?.(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {message ? (
          <p className="auth-message auth-message--error" role="alert"><FiAlertCircle aria-hidden="true" />{message}</p>
        ) : null}
        {auth.notice ? (
          <p className="auth-message auth-message--ok"><FiCheck aria-hidden="true" />{auth.notice}</p>
        ) : null}

        {activeMode === 'signin' && (
          <form className="auth-form" onSubmit={submitSignIn} noValidate>
            <Field label="Adresse email" htmlFor="auth-email">
              <input id="auth-email" type="email" autoComplete="email" value={form.email} onChange={update('email')} required />
            </Field>
            <PasswordField
              id="auth-password" label="Mot de passe" autoComplete="current-password" value={form.password}
              onChange={update('password')} shown={showPassword} onToggle={() => setShowPassword((v) => !v)}
            />
            <button className="auth-submit" type="submit" disabled={pending}>{pending ? 'Connexion…' : 'Se connecter'}</button>
            {isOAuthEnabled() && (
              <button className="auth-oauth" type="button" onClick={() => beginOAuthSession()}>Continuer avec un fournisseur externe</button>
            )}
          </form>
        )}

        {activeMode === 'signup' && (
          <form className="auth-form" onSubmit={submitSignUp} noValidate>
            <Field label="Prénom et nom" htmlFor="auth-name">
              <input id="auth-name" autoComplete="name" value={form.name} onChange={update('name')} placeholder="Ex. Aïcha Ngo Bell" />
            </Field>
            <Field label="Adresse email" htmlFor="auth-signup-email" hint="Un email de confirmation est envoyé immédiatement.">
              <input id="auth-signup-email" type="email" autoComplete="email" value={form.email} onChange={update('email')} required />
            </Field>
            <PasswordField
              id="auth-new-password" label="Mot de passe" autoComplete="new-password" value={form.password}
              onChange={update('password')} shown={showPassword} onToggle={() => setShowPassword((v) => !v)}
              hint={`${MIN_PASSWORD_LENGTH} caractères minimum.`}
            />
            <PasswordField
              id="auth-confirm" label="Répéter le mot de passe" autoComplete="new-password" value={form.confirm}
              onChange={update('confirm')} shown={showPassword} onToggle={() => setShowPassword((v) => !v)}
            />
            <div className="auth-grid">
              <Field label="Année" htmlFor="auth-promotion">
                <select id="auth-promotion" value={form.promotion} onChange={update('promotion')}>
                  {PROMOTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </Field>
              <Field label="Filière" htmlFor="auth-filiere">
                <select id="auth-filiere" value={form.filiere} onChange={update('filiere')}>
                  {FILIERES.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </Field>
            </div>
            <button className="auth-submit" type="submit" disabled={pending}>{pending ? 'Création du compte…' : 'Créer mon compte'}</button>
          </form>
        )}

        {activeMode === 'recover' && (
          <form className="auth-form" onSubmit={submitRecovery} noValidate>
            {auth.recovery ? (
              <>
                <p className="auth-note">Choisis un nouveau mot de passe pour finir la réinitialisation.</p>
                <PasswordField
                  id="auth-recover-password" label="Nouveau mot de passe" autoComplete="new-password" value={form.password}
                  onChange={update('password')} shown={showPassword} onToggle={() => setShowPassword((v) => !v)}
                />
                <button className="auth-submit" type="submit" disabled={pending}>{pending ? 'Enregistrement…' : 'Mettre à jour'}</button>
              </>
            ) : (
              <>
                <Field label="Adresse email du compte" htmlFor="auth-recover-email">
                  <input id="auth-recover-email" type="email" autoComplete="email" value={form.email} onChange={update('email')} required />
                </Field>
                <button className="auth-submit" type="submit" disabled={pending}>{pending ? 'Envoi…' : 'Envoyer le lien'}</button>
              </>
            )}
          </form>
        )}

        {activeMode === 'profile' && auth.user && (
          <div className="auth-form">
            <p className="auth-note">
              <FiShield aria-hidden="true" />
              {verified ? 'Adresse email vérifiée.' : 'Adresse email non vérifiée — un lien peut être renvoyé.'}
            </p>
            {!verified && (
              <button type="button" className="auth-ghost" disabled={pending} onClick={() => run(() => requestEmailVerification())}>
                Renvoyer l’email de vérification
              </button>
            )}
            <form onSubmit={submitProfile} noValidate>
              <Field label="Prénom et nom" htmlFor="auth-profile-name">
                <input id="auth-profile-name" value={form.name || auth.user.name || ''} onChange={update('name')} />
              </Field>
              <div className="auth-grid">
                <Field label="Année" htmlFor="auth-profile-promotion">
                  <select id="auth-profile-promotion" value={form.promotion || auth.profile?.promotion || PROMOTIONS[0]} onChange={update('promotion')}>
                    {PROMOTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </Field>
                <Field label="Filière" htmlFor="auth-profile-filiere">
                  <select id="auth-profile-filiere" value={form.filiere || auth.profile?.filiere || FILIERES[0]} onChange={update('filiere')}>
                    {FILIERES.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Petit mot pour les autres" htmlFor="auth-profile-bio" hint="280 caractères maximum, facultatif.">
                <textarea id="auth-profile-bio" rows="2" value={form.bio || auth.profile?.bio || ''} onChange={update('bio')} />
              </Field>
              <button className="auth-submit" type="submit" disabled={pending}>{pending ? 'Enregistrement…' : 'Enregistrer le profil'}</button>
            </form>

            {favorites && (
              <div className="auth-sync">
                <span>
                  Favoris&nbsp;: {favorites.items.length} · état&nbsp;
                  <strong>{{ local: 'local', loading: 'synchronisation…', synced: 'à jour', partial: 'partiel', offline: 'hors ligne', unprovisioned: 'table absente' }[favorites.sync.state] || favorites.sync.state}</strong>
                  {favorites.sync.lastSyncAt ? ` · ${new Date(favorites.sync.lastSyncAt).toLocaleTimeString('fr-FR')}` : ''}
                </span>
                {favorites.sync.enabled && favorites.sync.state !== 'synced' && (
                  <button type="button" className="auth-ghost" onClick={favorites.sync.retry}><FiRefreshCw aria-hidden="true" />Relancer</button>
                )}
                {favorites.sync.error ? <small className="auth-field-error">{favorites.sync.error}</small> : null}
              </div>
            )}

            <details className="auth-advanced">
              <summary>Sécurité du compte</summary>
              <form onSubmit={submitPasswordChange} noValidate>
                <PasswordField id="auth-current" label="Mot de passe actuel" autoComplete="current-password" value={form.current} onChange={update('current')} shown={showPassword} onToggle={() => setShowPassword((v) => !v)} />
                <PasswordField id="auth-next" label="Nouveau mot de passe" autoComplete="new-password" value={form.next} onChange={update('next')} shown={showPassword} onToggle={() => setShowPassword((v) => !v)} />
                <button className="auth-submit" type="submit" disabled={pending}>{pending ? 'Modification…' : 'Changer de mot de passe'}</button>
              </form>
              <div className="auth-actions">
                <button type="button" className="auth-ghost" onClick={() => run(() => listActiveSessions().then(setSessions))}>
                  Voir mes sessions actives{sessions ? ` (${sessions.length})` : ''}
                </button>
                <button type="button" className="auth-ghost" onClick={() => run(async () => { await signOutOtherSessions(); setSessions(null); })}>
                  Déconnecter les autres appareils
                </button>
                <button type="button" className="auth-ghost" onClick={downloadBundle}>
                  <FiDownload aria-hidden="true" /> Exporter mes données
                </button>
              </div>
              <p className="auth-note">
                La suppression définitive du compte se demande à un administrateur du projet&nbsp;:
                l’API publique ne l’autorise pas depuis le navigateur.
              </p>
            </details>

            <button
              type="button"
              className="auth-signout"
              onClick={() => run(async () => { await auth.signOut(); onClose?.(); })}
            >
              <FiLogOut aria-hidden="true" /> Se déconnecter
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function PasswordField({ id, label, hint, autoComplete, value, onChange, shown, onToggle }) {
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <span className="auth-password">
        <input id={id} type={shown ? 'text' : 'password'} autoComplete={autoComplete} value={value} onChange={onChange} required />
        <button type="button" onClick={onToggle} aria-label={shown ? 'Masquer le mot de passe' : 'Afficher le mot de passe'} aria-pressed={shown}>
          {shown ? <FiEyeOff aria-hidden="true" /> : <FiEye aria-hidden="true" />}
        </button>
      </span>
    </Field>
  );
}
