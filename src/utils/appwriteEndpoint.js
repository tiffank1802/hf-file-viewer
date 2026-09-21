/**
 * Normalise un endpoint d'API Appwrite en une base absolue unique.
 *
 * L'SDK web attend `https://<region>.cloud.appwrite.io/v1` (le `/v1` est
 * **inclus** dans l'endpoint) alors que le code de provisioning, lui, colle ses
 * chemins derrière la base : les deux conventions mélangées produisaient
 * `POST …/v1/v1/databases`, répondu par la page 404 HTML d'Appwrite — un
 * diagnostic qui faisait accuser le réseau alors que la route était fausse.
 *
 * Idempotent : `…/v1` reste `…/v1`, `…` devient `…/v1`.
 */
export function normalizeAppwriteEndpoint(endpoint) {
  const value = String(endpoint ?? '').trim().replace(/\/+$/, '');
  if (!value) return '';
  return /\/v1$/.test(value) ? value : `${value}/v1`;
}

/** Une réponse Appwrite est toujours en JSON ; le HTML signale un proxy ou une route inconnue. */
export function looksLikeAppwriteResponse({ server, contentType } = {}) {
  const byServer = /appwrite/i.test(String(server ?? ''));
  const byType = /json/i.test(String(contentType ?? ''));
  return { fromAppwrite: byServer, json: byType };
}
