const READER_METRIC_EVENTS = new Set([
  'open',
  'metadata',
  'first-page',
  'mode-change',
  'selection',
  'assistant',
  'citation-open',
  'annotation',
  'network',
  'pdf-error',
]);

const DIMENSION_KEYS = new Set([
  'kind',
  'mode',
  'status',
  'outcome',
  'action',
  'viewport',
  'pageCount',
  'blockCount',
  'selectionLength',
]);

/**
 * Envoie uniquement des dimensions bornées. Aucun chemin, texte sélectionné,
 * question, note, identifiant utilisateur ou identifiant d’annotation n’est
 * accepté par cette fonction.
 */
export function emitReaderMetric(event, values = {}) {
  const payload = buildReaderMetric(event, values);
  if (!payload || typeof fetch !== 'function') return false;
  try {
    void fetch('/api/reader/metrics', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export function buildReaderMetric(event, values = {}) {
  const name = cleanDimension(event, 40);
  if (!READER_METRIC_EVENTS.has(name)) return null;
  const payload = { event: name };
  for (const [key, raw] of Object.entries(values || {})) {
    if (!DIMENSION_KEYS.has(key)) continue;
    const value = cleanDimension(raw, 48);
    if (value) payload[key] = value;
  }
  if (Number.isFinite(Number(values.durationMs))) {
    payload.durationMs = Math.min(600_000, Math.max(0, Math.round(Number(values.durationMs))));
  }
  return payload;
}

export function metricBucket(value, boundaries = [1, 10, 50, 100, 500]) {
  const number = Math.max(0, Math.round(Number(value) || 0));
  let lower = 0;
  for (const upper of boundaries) {
    if (number <= upper) return `${lower}-${upper}`;
    lower = upper + 1;
  }
  return `${lower}+`;
}

export function readerViewport() {
  if (typeof window === 'undefined') return 'unknown';
  if (window.matchMedia?.('(max-width: 760px)').matches) return 'mobile';
  if (window.matchMedia?.('(max-width: 1100px)').matches) return 'tablet';
  return 'desktop';
}

function cleanDimension(value, max) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || normalized.length > max || !/^[a-z0-9][a-z0-9+_.:-]*$/.test(normalized)) return '';
  return normalized;
}
