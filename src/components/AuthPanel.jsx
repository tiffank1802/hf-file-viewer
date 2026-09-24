import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FiAlertCircle,
  FiCheck,
  FiEye,
  FiEyeOff,
  FiLogOut,
  FiShield,
  FiX,
} from 'react-icons/fi';
import { useAuth } from '../hooks/useAuth.js';
import { FILIERES, MIN_PASSWORD_LENGTH, PROMOTIONS } from '../services/authApi.js';

const TABS = [
  { id: 'signin', label: 'Connexion' },
  { id: 'signup', label: 'Inscription' },
  { id: 'recover', label: 'Mot de passe' },
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

function PasswordField({ id, value, onChange, autoComplete, shown, onToggle }) {
  return (
    <span className="auth-password">
      <input
        id={id}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        minLength={MIN_PASSWORD_LENGTH}
        required
      />
      <button type="button" onClick={onToggle} aria-label={shown ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}>
        {shown ? <FiEyeOff aria-hidden="true" /> : <FiEye aria-hidden="true" />}
      </button>
    </span>
  );
}

export default function AuthPanel({ open, mode = 'signin', onModeChange, onClose }) {
  const auth = useAuth();
  const [form, setForm] = useState({
    email: '',
    password: '',
    confirm: '',
    name: '',
    promotion: PROMOTIONS[0],
    filiere: FILIERES[0],
    bio: '',
    current: '',
    next: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState(null);
  const closeRef = useRef(null);
  const activeMode = auth.recovery ? 'recover' : (auth.isAuthenticated ? 'profile' : mode);

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    document.body.classList.add('modal-open');
    closeRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.classList.remove('modal-open');
      window.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      setLocalError(null);
      setPending(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !auth.isAuthenticated) return;
    setForm((current) => ({
      ...current,
      name: auth.user?.name ?? '',
      promotion: auth.profile?.promotion ?? current.promotion ?? PROMOTIONS[0],
      filiere: auth.profile?.filiere ?? current.filiere ?? FILIERES[0],
      bio: auth.profile?.bio ?? '',
    }));
  }, [open, auth.isAuthenticated, auth.user, auth.profile]);

  const update = useCallback((key) => (event) => {
    setForm((current) => ({ ...current, [key]: event.target.value }));
  }, []);

  const run = async (action) => {
    setLocalError(null);
    auth.clearMessages();
    setPending(true);
    try {
      await action();
    } catch (err) {
      setLocalError(err?.message || 'Opération impossible.');
    } finally {
      setPending(false);
    }
  };

  if (!open) return null;

  const message = localError || auth.error;
  const title = activeMode === 'profile'
    ? 'Mon profil'
    : activeMode === 'signup'
      ? 'Créer un compte'
      : activeMode === 'recover'
        ? 'Mot de passe oublié'
        : 'Connexion';

  return (
    <div
      className="modal-backdrop auth-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <section className="auth-card" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <header className="auth-head">
          <h2 id="auth-title">{title}</h2>
          <p>Le compte sert à retrouver tes documents. La bibliothèque reste consultable sans connexion.</p>
        </header>
        <button ref={closeRef} className="auth-close" type="button" onClick={onClose} aria-label="Fermer">
          <FiX aria-hidden="true" />
        </button>

        {!auth.isAuthenticated && !auth.recovery && (
          <div className="auth-tabs" role="tablist" aria-label="Actions du compte">
            {TABS.map((tab) => (
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
        )}

        {message ? (
          <p className="auth-message auth-message--error" role="alert">
            <FiAlertCircle aria-hidden="true" />
            {message}
          </p>
        ) : null}
        {auth.notice ? (
          <p className="auth-message auth-message--ok" role="status">
            <FiCheck aria-hidden="true" />
            {auth.notice}
          </p>
        ) : null}

        {activeMode === 'signin' && (
          <form
            className="auth-form"
            onSubmit={(event) => {
              event.preventDefault();
              run(() => auth.signIn({ email: form.email, password: form.password }));
            }}
          >
            <Field label="Email" htmlFor="auth-email">
              <input id="auth-email" type="email" autoComplete="username" value={form.email} onChange={update('email')} required />
            </Field>
            <Field label="Mot de passe" htmlFor="auth-password">
              <PasswordField
                id="auth-password"
                value={form.password}
                onChange={update('password')}
                autoComplete="current-password"
                shown={showPassword}
                onToggle={() => setShowPassword((value) => !value)}
              />
            </Field>
            <button className="auth-submit" type="submit" disabled={pending}>
              {pending ? 'Connexion…' : 'Se connecter'}
            </button>
          </form>
        )}

        {activeMode === 'signup' && (
          <form
            className="auth-form"
            onSubmit={(event) => {
              event.preventDefault();
              run(() => auth.signUp({
                email: form.email,
                password: form.password,
                confirm: form.confirm,
                name: form.name,
                promotion: form.promotion,
                filiere: form.filiere,
                bio: form.bio,
              }));
            }}
          >
            <Field label="Nom" htmlFor="auth-name">
              <input id="auth-name" autoComplete="name" value={form.name} onChange={update('name')} required />
            </Field>
            <Field label="Email" htmlFor="auth-signup-email">
              <input id="auth-signup-email" type="email" autoComplete="email" value={form.email} onChange={update('email')} required />
            </Field>
            <Field label="Mot de passe" hint={`${MIN_PASSWORD_LENGTH} caractères minimum. Il reste dans Appwrite Auth, jamais dans une table.`} htmlFor="auth-signup-password">
              <PasswordField
                id="auth-signup-password"
                value={form.password}
                onChange={update('password')}
                autoComplete="new-password"
                shown={showPassword}
                onToggle={() => setShowPassword((value) => !value)}
              />
            </Field>
            <Field label="Confirmation" htmlFor="auth-confirm">
              <input id="auth-confirm" type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={form.confirm} onChange={update('confirm')} required />
            </Field>
            <div className="auth-grid">
              <Field label="Promotion" htmlFor="auth-promotion">
                <select id="auth-promotion" value={form.promotion} onChange={update('promotion')}>
                  {PROMOTIONS.map((item) => <option key={item}>{item}</option>)}
                </select>
              </Field>
              <Field label="Filière" htmlFor="auth-filiere">
                <select id="auth-filiere" value={form.filiere} onChange={update('filiere')}>
                  {FILIERES.map((item) => <option key={item}>{item}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Bio" hint="Facultatif, 280 caractères." htmlFor="auth-bio">
              <textarea id="auth-bio" maxLength={280} value={form.bio} onChange={update('bio')} />
            </Field>
            <button className="auth-submit" type="submit" disabled={pending}>
              {pending ? 'Création…' : 'Créer le compte'}
            </button>
          </form>
        )}

        {activeMode === 'recover' && (
          auth.recovery ? (
            <form
              className="auth-form"
              onSubmit={(event) => {
                event.preventDefault();
                run(() => auth.finishRecovery({ password: form.password, confirm: form.confirm }));
              }}
            >
              <p className="auth-note"><FiShield aria-hidden="true" />Choisis un nouveau mot de passe pour ce lien.</p>
              <Field label="Nouveau mot de passe" htmlFor="auth-new">
                <PasswordField
                  id="auth-new"
                  value={form.password}
                  onChange={update('password')}
                  autoComplete="new-password"
                  shown={showPassword}
                  onToggle={() => setShowPassword((value) => !value)}
                />
              </Field>
              <Field label="Confirmation" htmlFor="auth-new-confirm">
                <input id="auth-new-confirm" type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={form.confirm} onChange={update('confirm')} required />
              </Field>
              <button className="auth-submit" type="submit" disabled={pending}>
                {pending ? 'Mise à jour…' : 'Enregistrer le mot de passe'}
              </button>
            </form>
          ) : (
            <form
              className="auth-form"
              onSubmit={(event) => {
                event.preventDefault();
                run(() => auth.requestRecovery(form.email));
              }}
            >
              <Field label="Email du compte" htmlFor="auth-recover-email">
                <input id="auth-recover-email" type="email" autoComplete="email" value={form.email} onChange={update('email')} required />
              </Field>
              <button className="auth-submit" type="submit" disabled={pending}>
                {pending ? 'Envoi…' : 'Envoyer le lien'}
              </button>
            </form>
          )
        )}

        {activeMode === 'profile' && (
          <div className="auth-form">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                run(() => auth.saveProfile({
                  name: form.name,
                  promotion: form.promotion,
                  filiere: form.filiere,
                  bio: form.bio,
                }));
              }}
            >
              <Field label="Nom" htmlFor="auth-profile-name">
                <input id="auth-profile-name" value={form.name} onChange={update('name')} required />
              </Field>
              <p className="auth-note">{auth.user?.email}{auth.user?.emailVerification ? ' · email vérifié' : ' · email non vérifié'}</p>
              <div className="auth-grid">
                <Field label="Promotion" htmlFor="auth-profile-promotion">
                  <select id="auth-profile-promotion" value={form.promotion} onChange={update('promotion')}>
                    {PROMOTIONS.map((item) => <option key={item}>{item}</option>)}
                  </select>
                </Field>
                <Field label="Filière" htmlFor="auth-profile-filiere">
                  <select id="auth-profile-filiere" value={form.filiere} onChange={update('filiere')}>
                    {FILIERES.map((item) => <option key={item}>{item}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Bio" htmlFor="auth-profile-bio">
                <textarea id="auth-profile-bio" maxLength={280} value={form.bio} onChange={update('bio')} />
              </Field>
              {!auth.profileTable && (
                <p className="auth-note">La promotion sera enregistrée dès que la table profils est provisionnée. Le nom, lui, est déjà sur le compte.</p>
              )}
              <button className="auth-submit" type="submit" disabled={pending}>Enregistrer le profil</button>
            </form>
            {!auth.user?.emailVerification && (
              <button className="auth-ghost" type="button" disabled={pending} onClick={() => run(() => auth.requestVerification())}>
                Renvoyer l’email de vérification
              </button>
            )}
            <form
              className="auth-advanced"
              onSubmit={(event) => {
                event.preventDefault();
                run(async () => {
                  await auth.changePassword({ current: form.current, next: form.next, confirm: form.confirm });
                  setForm((current) => ({ ...current, current: '', next: '', confirm: '' }));
                });
              }}
            >
              <strong>Changer le mot de passe</strong>
              <Field label="Mot de passe actuel" htmlFor="auth-current">
                <input id="auth-current" type="password" autoComplete="current-password" value={form.current} onChange={update('current')} required />
              </Field>
              <Field label="Nouveau mot de passe" htmlFor="auth-next">
                <input id="auth-next" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} value={form.next} onChange={update('next')} required />
              </Field>
              <Field label="Confirmation" htmlFor="auth-next-confirm">
                <input id="auth-next-confirm" type="password" autoComplete="new-password" value={form.confirm} onChange={update('confirm')} required />
              </Field>
              <button className="auth-ghost" type="submit" disabled={pending}>Mettre à jour</button>
            </form>
            <button className="auth-signout" type="button" onClick={() => run(() => auth.signOut())}>
              <FiLogOut aria-hidden="true" /> Se déconnecter
            </button>
            <p className="auth-note">Les favoris sont ceux du compte. Un cœur ajouté hors connexion n’est pas gardé sur cet appareil.</p>
          </div>
        )}
      </section>
    </div>
  );
}
