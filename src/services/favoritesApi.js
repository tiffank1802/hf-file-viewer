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
    const error = new Error(payload.error || 'Favoris indisponibles.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function listFavorites() {
  return request('/api/favorites');
}

export function addFavorite(item) {
  return request('/api/favorites', { method: 'POST', body: item });
}

export function removeFavorite(item) {
  return request('/api/favorites/remove', { method: 'POST', body: item });
}

export function setFavoriteNote(rowId, note) {
  return request('/api/favorites/note', { method: 'POST', body: { rowId, note } });
}

export function importFavorites(items) {
  return request('/api/favorites/import', { method: 'POST', body: { items } });
}
