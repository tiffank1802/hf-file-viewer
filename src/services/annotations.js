export async function listAnnotations(sourcePath, artifactId, signal) {
  const params = new URLSearchParams({ path: sourcePath, artifactId });
  return annotationRequest(`/api/annotations?${params}`, { signal });
}

export async function createAnnotation(input, signal) {
  return annotationRequest('/api/annotations', {
    method: 'POST',
    signal,
    body: input,
  });
}

export async function updateAnnotation(id, patch, signal) {
  return annotationRequest(`/api/annotations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    signal,
    body: patch,
  });
}

export async function deleteAnnotation(id, signal) {
  return annotationRequest(`/api/annotations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal,
  });
}

async function annotationRequest(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      signal: options.signal,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw annotationError('Connexion aux annotations impossible.', 0);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw annotationError(payload.error || 'Les annotations sont indisponibles.', response.status);
  }
  return payload;
}

function annotationError(message, status) {
  const error = new Error(message);
  error.name = 'AnnotationError';
  error.status = status;
  return error;
}
