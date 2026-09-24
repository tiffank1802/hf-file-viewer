export const MIN_PASSWORD_LENGTH = 12;
export const PROMOTIONS = ['3A', '4A', '5A', 'Alumni', 'Staff'];
export const FILIERES = ['GM', 'GC', 'GP', 'Autre'];

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Le service de compte est indisponible.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function getSession() {
  return request('/api/auth/session');
}

export function signIn(email, password) {
  return request('/api/auth/login', { method: 'POST', body: { email, password } });
}

export function signUp(payload) {
  return request('/api/auth/signup', { method: 'POST', body: payload });
}

export function signOut() {
  return request('/api/auth/logout', { method: 'POST', body: {} });
}

export function saveProfile(payload) {
  return request('/api/auth/profile', { method: 'POST', body: payload });
}

export function changePassword(payload) {
  return request('/api/auth/password', { method: 'POST', body: payload });
}

export function requestVerification() {
  return request('/api/auth/verify', { method: 'POST', body: {} });
}

const verificationInflight = new Map();

export function confirmVerification({ userId, secret }) {
  const key = `${userId}:${secret}`;
  if (!verificationInflight.has(key)) {
    verificationInflight.set(key, request('/api/auth/verify', { method: 'POST', body: { userId, secret } }));
  }
  return verificationInflight.get(key);
}

export function requestRecovery(email) {
  return request('/api/auth/recover', { method: 'POST', body: { email } });
}

export function finishRecovery({ userId, secret, password, confirm }) {
  return request('/api/auth/recover', { method: 'POST', body: { userId, secret, password, confirm } });
}

export function readLinkParams(flag) {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get(flag) !== '1') return null;
  const userId = params.get('userId') || '';
  const secret = params.get('secret') || '';
  if (!userId || !secret) return null;
  return { userId, secret };
}

export function cleanAuthParams() {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  url.search = '';
  window.history.replaceState({}, '', `${url.pathname}${url.hash}`);
}
