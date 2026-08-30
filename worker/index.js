const HF_ORIGIN = 'https://huggingface.co';
const DEFAULT_BUCKET_ID = 'ktongue/ENISE-SITE';
/**
 * Version des clés de cache (Cache API et Workers KV).
 *
 * Le Cache API des Workers ne se purge pas par URL et n’est pas vidé
 * datacenter par datacenter via cache.delete depuis l’extérieur : pour
 * invalider d’un coup un état périmé (par exemple un index calculé à 0
 * pendant la création du bucket Hugging Face), incrémenter cette version
 * puis redéployer. Les anciennes entrées deviennent orphelines et expirent
 * naturellement selon leur TTL.
 */
const CACHE_KEY_VERSION = 'v2';
const DEFAULT_TREE_TTL = 6 * 60 * 60;
const DEFAULT_INDEX_TTL = 12 * 60 * 60;
const DEFAULT_FILE_TTL = 7 * 24 * 60 * 60;
const DEFAULT_KV_TTL = 24 * 60 * 60;
const DEFAULT_MAX_CACHEABLE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TREE_PAGES = 45;
const MAX_INDEX_ITEMS = 50_000;
const APS_BASE_URL = 'https://developer.api.autodesk.com';
const DEFAULT_APS_CACHE_TTL = 24 * 60 * 60;
const DEFAULT_APS_UPLOAD_BYTES = 100 * 1024 * 1024;

const API_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'X-Robots-Tag': 'noindex, nofollow',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...API_SECURITY_HEADERS,
          Allow: 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Range, Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    try {
      if (url.pathname === '/api/health') {
        return handleHealth(env);
      }

      if (url.pathname === '/api/tree') {
        assertMethod(request, ['GET']);
        return await handleTree(request, env, ctx);
      }

      if (url.pathname === '/api/index') {
        assertMethod(request, ['GET']);
        return await handleIndex(request, env, ctx);
      }

      if (url.pathname === '/api/file') {
        assertMethod(request, ['GET', 'HEAD']);
        return await handleFile(request, env, ctx);
      }

      if (url.pathname === '/api/counts') {
        assertMethod(request, ['GET']);
        return await handleCounts(request, env, ctx);
      }

      if (url.pathname === '/api/aps/token') {
        assertMethod(request, ['GET']);
        return await handleApsToken(request, env);
      }

      if (url.pathname === '/api/aps/view') {
        assertMethod(request, ['POST']);
        return await handleApsView(request, env, ctx);
      }

      if (url.pathname === '/api/aps/status') {
        assertMethod(request, ['GET']);
        return await handleApsStatus(request, env, ctx);
      }

      return jsonResponse(
        { error: 'Route API introuvable.' },
        { status: 404, cacheControl: 'no-store' },
      );
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse(
          { error: error.message },
          { status: error.status, cacheControl: 'no-store' },
        );
      }

      console.error('Unhandled Worker error', error);
      return jsonResponse(
        { error: 'Le service documentaire est momentanément indisponible.' },
        { status: 500, cacheControl: 'no-store' },
      );
    }
  },
};

async function handleTree(request, env, ctx) {
  const requestUrl = new URL(request.url);
  const prefix = normalizePrefix(requestUrl.searchParams.get('prefix') ?? '');
  const bucketId = getBucketId(env);
  const edgeTtl = positiveInteger(env.TREE_CACHE_TTL, DEFAULT_TREE_TTL);
  const cache = caches.default;
  const cacheKey = makeCacheKey('tree', bucketId, { prefix });
  const startedAt = Date.now();

  const cached = await cache.match(cacheKey);
  if (cached) {
    return responseFromCache(cached, 'HIT', 'public, max-age=300, stale-while-revalidate=3600');
  }

  const kvKey = makeKvKey('tree', bucketId, prefix);
  const kvBody = await readMetadataKv(env, kvKey);
  if (kvBody) {
    storeJsonInCache(ctx, cache, cacheKey, kvBody, edgeTtl);
    return jsonResponse(kvBody, {
      serialized: true,
      cacheControl: 'public, max-age=300, stale-while-revalidate=3600',
      headers: {
        'X-Cache-Status': 'KV-HIT',
        'Server-Timing': 'edge;desc="cache miss", kv;desc="metadata hit"',
      },
    });
  }

  const { items, complete } = await fetchBucketTree(env, prefix, false);
  const payload = {
    bucketId,
    prefix,
    items,
    complete,
    fetchedAt: new Date().toISOString(),
  };

  const body = JSON.stringify(payload);
  storeJsonInCache(ctx, cache, cacheKey, body, edgeTtl);
  storeMetadataKv(ctx, env, kvKey, body);

  return jsonResponse(body, {
    serialized: true,
    cacheControl: 'public, max-age=300, stale-while-revalidate=3600',
    headers: {
      'X-Cache-Status': 'MISS',
      'Server-Timing': `edge;desc="cache miss", hf;dur=${Date.now() - startedAt}`,
    },
  });
}

/**
 * Charge le document d’index (Cache API → Workers KV → Hugging Face).
 *
 * Le parcours récursif du bucket n’a lieu qu’au tout premier appel : les
 * effectifs par dossier (`counts`) et le total (`totalFiles`) y sont calculés
 * une seule fois puis stockés dans le JSON mis en cache. Toutes les vues du
 * portail réutilisent ensuite ce même document.
 */
async function loadIndexDocument(env, ctx) {
  const bucketId = getBucketId(env);
  const edgeTtl = positiveInteger(env.INDEX_CACHE_TTL, DEFAULT_INDEX_TTL);
  const cache = caches.default;
  const cacheKey = makeCacheKey('index', bucketId);
  const startedAt = Date.now();

  const cached = await cache.match(cacheKey);
  if (cached) {
    return {
      body: await cached.text(),
      bucketId,
      cacheStatus: 'HIT',
      timing: 'edge;desc="cache hit";dur=0',
      durationMs: Date.now() - startedAt,
    };
  }

  const kvKey = makeKvKey('index', bucketId, 'recursive-counts');
  const kvBody = await readMetadataKv(env, kvKey);
  if (kvBody) {
    storeJsonInCache(ctx, cache, cacheKey, kvBody, edgeTtl);
    return {
      body: kvBody,
      bucketId,
      cacheStatus: 'KV-HIT',
      timing: 'edge;desc="cache miss", kv;desc="index hit"',
      durationMs: Date.now() - startedAt,
    };
  }

  const { items, complete } = await fetchBucketTree(env, '', true);
  const compactItems = items.slice(0, MAX_INDEX_ITEMS).map(compactBucketItem);
  const { counts, totalFiles } = countFilesByDirectory(compactItems);
  const payload = {
    bucketId,
    items: compactItems,
    counts,
    totalFiles,
    complete: complete && items.length <= MAX_INDEX_ITEMS,
    fetchedAt: new Date().toISOString(),
  };

  const body = JSON.stringify(payload);
  storeJsonInCache(ctx, cache, cacheKey, body, edgeTtl);
  storeMetadataKv(ctx, env, kvKey, body);

  return {
    body,
    bucketId,
    cacheStatus: 'MISS',
    timing: `edge;desc="cache miss", hf;dur=${Date.now() - startedAt}`,
    durationMs: Date.now() - startedAt,
  };
}

async function handleIndex(request, env, ctx) {
  const { body, cacheStatus, timing } = await loadIndexDocument(env, ctx);

  return jsonResponse(body, {
    serialized: true,
    cacheControl: 'public, max-age=1800, stale-while-revalidate=7200',
    headers: {
      'X-Cache-Status': cacheStatus,
      'X-Data-Source': 'index-json',
      'Server-Timing': timing,
    },
  });
}

async function handleCounts(request, env, ctx) {
  const requestUrl = new URL(request.url);
  const prefix = normalizePrefix(requestUrl.searchParams.get('prefix') ?? '');
  const { body, bucketId, cacheStatus, timing } = await loadIndexDocument(env, ctx);
  const document = parseIndexDocument(body);
  const { counts, totalFiles } = selectCountsForPrefix(document, prefix);

  return jsonResponse(
    {
      bucketId,
      prefix,
      counts,
      totalFiles,
      complete: document.complete !== false,
      fetchedAt: document.fetchedAt ?? null,
      source: 'index-json',
    },
    {
      cacheControl: 'public, max-age=1800, stale-while-revalidate=7200',
      headers: {
        'X-Cache-Status': cacheStatus,
        'X-Data-Source': 'index-json',
        'Server-Timing': timing,
      },
    },
  );
}

function parseIndexDocument(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(502, 'Index documentaire illisible.');
  }
}

/** Extrait du JSON d’index les effectifs correspondant à un préfixe. */
export function selectCountsForPrefix(document, prefix = '') {
  const base = String(prefix || '').replace(/^\/+|\/+$/g, '');
  const source =
    document && typeof document.counts === 'object' && document.counts ? document.counts : {};

  if (!base) {
    const declaredTotal = Number(document?.totalFiles);
    return {
      counts: { ...source },
      totalFiles: Number.isFinite(declaredTotal) ? declaredTotal : 0,
    };
  }

  const counts = {};
  for (const [path, value] of Object.entries(source)) {
    if (path === base || path.startsWith(`${base}/`)) counts[path] = value;
  }

  const scopedTotal = Number(source[base]);
  return { counts, totalFiles: Number.isFinite(scopedTotal) ? scopedTotal : 0 };
}

async function handleFile(request, env, ctx) {
  const url = new URL(request.url);
  const filePath = normalizeFilePath(url.searchParams.get('path'));
  const shouldDownload = url.searchParams.get('download') === '1';
  const bucketId = getBucketId(env);
  const edgeTtl = positiveInteger(env.FILE_CACHE_TTL, DEFAULT_FILE_TTL);
  const maxCacheableBytes = positiveInteger(
    env.MAX_CACHEABLE_FILE_BYTES,
    DEFAULT_MAX_CACHEABLE_FILE_BYTES,
  );
  const cache = caches.default;
  const cacheKey = makeCacheKey('file', bucketId, { path: filePath });
  const range = request.headers.get('Range');

  if (request.method === 'GET') {
    const lookupRequest = range
      ? new Request(cacheKey, { headers: { Range: range } })
      : cacheKey;
    const cached = await cache.match(lookupRequest);

    if (cached) {
      return prepareFileResponse(cached, {
        cacheStatus: 'HIT',
        shouldDownload,
        filePath,
      });
    }
  }

  const upstreamUrl = buildHfFileUrl(bucketId, filePath);
  const upstreamHeaders = buildHfHeaders(env);
  if (range) upstreamHeaders.set('Range', range);
  const ifRange = request.headers.get('If-Range');
  if (ifRange) upstreamHeaders.set('If-Range', ifRange);

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
      redirect: 'follow',
    });
  } catch {
    throw new HttpError(502, 'Connexion au stockage Hugging Face interrompue.');
  }

  if (!upstream.ok && upstream.status !== 206) {
    if (upstream.status === 404) {
      throw new HttpError(404, 'Document introuvable dans le bucket Hugging Face.');
    }
    throw new HttpError(
      upstream.status >= 500 ? 502 : upstream.status,
      'Hugging Face n’a pas pu fournir ce document.',
    );
  }

  const response = prepareFileResponse(upstream, {
    cacheStatus: range || upstream.status === 206 ? 'BYPASS-RANGE' : 'MISS',
    shouldDownload,
    filePath,
  });

  if (request.method === 'HEAD') return response;

  const contentLength = Number(response.headers.get('Content-Length'));
  const cacheable =
    upstream.status === 200 &&
    !range &&
    Number.isFinite(contentLength) &&
    contentLength >= 0 &&
    contentLength <= maxCacheableBytes;

  if (!cacheable) {
    response.headers.set(
      'X-Cache-Status',
      range ? 'BYPASS-RANGE' : 'BYPASS-SIZE',
    );
    return response;
  }

  const edgeResponse = response.clone();
  edgeResponse.headers.set('Cache-Control', `public, max-age=${edgeTtl}`);
  edgeResponse.headers.set('Content-Disposition', contentDisposition(filePath, false));
  edgeResponse.headers.delete('X-Cache-Status');

  ctx.waitUntil(
    cache.put(cacheKey, edgeResponse).catch((error) => {
      console.error('Unable to persist file in Cache API', error);
    }),
  );

  return response;
}

/** Vérifie que les identifiants APS sont présents (jamais côté navigateur). */
export function isApsConfigured(env) {
  return Boolean(String(env.APS_CLIENT_ID || '').trim() && String(env.APS_CLIENT_SECRET || '').trim());
}

/** Construit une clé courte et stable à partir de la source d’un document. */
export function makeApsSourceKey(filePath, size = '', mtime = '') {
  const source = `${String(filePath || '')}|${String(size || '')}|${String(mtime || '')}`;
  return `${hashIdentifier(source)}${hashIdentifier(`aps:${source}`)}`.slice(0, 32);
}

/** Nom d’objet OSS utilisé pour stocker un fichier 3D. */
export function buildApsObjectKey(filePath, sourceKey) {
  const filename = filePath.split('/').pop() || 'document';
  const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'document';
  return `${sourceKey}-${safeName}`;
}

async function handleApsToken(_request, env) {
  if (!isApsConfigured(env)) {
    return jsonResponse(
      { error: 'Autodesk APS non configuré.', status: 'not-configured' },
      { status: 501, cacheControl: 'no-store' },
    );
  }

  const { accessToken, expiresIn } = await getApsAccessToken(env);
  return jsonResponse(
    { access_token: accessToken, expires_in: expiresIn, token_type: 'Bearer' },
    { cacheControl: 'no-store', headers: { 'X-APS-Status': 'ready' } },
  );
}

async function handleApsStatus(request, env, ctx) {
  if (!isApsConfigured(env)) {
    return jsonResponse(
      { error: 'Autodesk APS non configuré.', status: 'not-configured' },
      { status: 501, cacheControl: 'no-store' },
    );
  }

  const url = new URL(request.url);
  const filePath = normalizeFilePath(url.searchParams.get('path'));
  const size = normalizeNumericSearchParam(url.searchParams.get('size'));
  const mtime = String(url.searchParams.get('mtime') || '');
  const record = await readApsRecord(env, ctx, filePath, size, mtime);

  if (!record || !record.urn) {
    return jsonResponse(
      { status: 'missing', message: 'Aucune traduction 3D enregistrée pour ce fichier.' },
      { cacheControl: 'no-store' },
    );
  }

  const { accessToken } = await getApsAccessToken(env);
  const updated = await refreshApsRecord(env, ctx, filePath, size, mtime, record, accessToken);
  return jsonResponse(updated, { cacheControl: 'no-store' });
}

async function handleApsView(request, env, ctx) {
  if (!isApsConfigured(env)) {
    return jsonResponse(
      { error: 'Autodesk APS non configuré.', status: 'not-configured' },
      { status: 501, cacheControl: 'no-store' },
    );
  }

  const url = new URL(request.url);
  const filePath = normalizeFilePath(url.searchParams.get('path'));
  const size = normalizeNumericSearchParam(url.searchParams.get('size'));
  const mtime = String(url.searchParams.get('mtime') || '');
  const force = url.searchParams.get('force') === '1';
  const existing = await readApsRecord(env, ctx, filePath, size, mtime);
  const { accessToken } = await getApsAccessToken(env);

  if (existing && !force) {
    if (existing.status === 'success') {
      return jsonResponse(
        { ...stripApsRecordForClient(existing), cacheStatus: 'cached' },
        { cacheControl: 'no-store' },
      );
    }
    if (existing.urn) {
      const refreshed = await refreshApsRecord(
        env,
        ctx,
        filePath,
        size,
        mtime,
        existing,
        accessToken,
      );
      return jsonResponse(refreshed, { cacheControl: 'no-store' });
    }
  }

  const record = await startApsTranslation(env, ctx, filePath, size, mtime, accessToken, force);
  return jsonResponse(
    { ...stripApsRecordForClient(record), cacheStatus: 'new' },
    { cacheControl: 'no-store' },
  );
}

async function getApsAccessToken(env) {
  if (!isApsConfigured(env)) {
    throw new HttpError(501, 'Autodesk APS non configuré.');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: String(env.APS_CLIENT_ID || '').trim(),
    client_secret: String(env.APS_CLIENT_SECRET || '').trim(),
    scope: 'bucket:create bucket:read data:read data:write viewables:read',
  });

  let response;
  try {
    response = await fetch(`${APS_BASE_URL}/authentication/v2/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
  } catch {
    throw new HttpError(502, 'Connexion à Autodesk APS impossible.');
  }

  if (!response.ok) {
    throw await autodeskHttpError(response, 'Authentification Autodesk refusée.');
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new HttpError(502, 'Réponse illisible d’Autodesk APS.');
  }

  if (!payload.access_token) {
    throw new HttpError(502, 'Autodesk APS n’a pas renvoyé de jeton d’accès.');
  }

  return {
    accessToken: String(payload.access_token),
    expiresIn: Math.max(Number(payload.expires_in) || 3600, 60),
  };
}

async function ensureApsBucket(env, accessToken) {
  const bucketKey = getApsBucketKey(env);
  const headers = apsAuthHeaders(accessToken);

  let detail;
  try {
    detail = await fetch(
      `${APS_BASE_URL}/oss/v2/buckets/${encodeURIComponent(bucketKey)}/details`,
      { headers },
    );
  } catch {
    throw new HttpError(502, 'Connexion au stockage Autodesk impossible.');
  }
  if (detail.ok) return bucketKey;

  let created;
  try {
    created = await fetch(`${APS_BASE_URL}/oss/v2/buckets`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucketKey, policyKey: 'transient' }),
    });
  } catch {
    throw new HttpError(502, 'Création du stockage Autodesk impossible.');
  }

  if (created.ok) return bucketKey;
  if (created.status === 409) {
    detail = await fetch(
      `${APS_BASE_URL}/oss/v2/buckets/${encodeURIComponent(bucketKey)}/details`,
      { headers },
    );
    if (detail.ok) return bucketKey;
    throw new HttpError(502, 'Le panier Autodesk existe déjà et n’appartient pas à cette application.');
  }

  throw await autodeskHttpError(created, 'Création du panier Autodesk refusée.');
}

function getApsBucketKey(env) {
  const configured = String(env.APS_BUCKET_KEY || '').trim().toLowerCase();
  if (configured) return configured;
  const clientId = String(env.APS_CLIENT_ID || '').trim();
  return `enise-docs-3d-${hashIdentifier(clientId).slice(0, 10)}`;
}

async function startApsTranslation(env, ctx, filePath, size, mtime, accessToken, force) {
  const sourceKey = makeApsSourceKey(filePath, size, mtime);
  const bucketKey = await ensureApsBucket(env, accessToken);
  const objectKey = buildApsObjectKey(filePath, sourceKey);
  const objectId = await uploadApsObject(env, accessToken, bucketKey, objectKey, filePath);
  const encodedUrn = base64ToUrlSafe(base64Encode(objectId));

  let jobResponse;
  try {
    jobResponse = await fetch(`${APS_BASE_URL}/modelderivative/v2/designdata/job`, {
      method: 'POST',
      headers: {
        ...apsAuthHeaders(accessToken),
        'Content-Type': 'application/json',
        ...(force ? { 'x-ads-force': 'true' } : {}),
      },
      body: JSON.stringify({
        input: { urn: encodedUrn, compressedUrn: false },
        output: { formats: [{ type: 'svf2', views: ['2d', '3d'] }] },
      }),
    });
  } catch {
    throw new HttpError(502, 'Démarrage de la conversion 3D Autodesk impossible.');
  }

  if (!jobResponse.ok) {
    throw await autodeskHttpError(jobResponse, 'Autodesk a refusé la conversion du fichier.');
  }

  let job;
  try {
    job = await jobResponse.json();
  } catch {
    throw new HttpError(502, 'Réponse de conversion Autodesk illisible.');
  }

  if (!job.urn) {
    throw new HttpError(502, 'Autodesk n’a pas renvoyé d’identifiant de conversion.');
  }

  const record = {
    path: filePath,
    objectKey,
    objectId,
    urn: String(job.urn),
    status: 'inprogress',
    progress: 0,
    message: 'Conversion 3D démarrée.',
    updatedAt: new Date().toISOString(),
  };
  await storeApsRecord(ctx, env, filePath, size, mtime, record);
  return record;
}

async function uploadApsObject(env, accessToken, bucketKey, objectKey, filePath) {
  const bucketId = getBucketId(env);
  const upstreamUrl = buildHfFileUrl(bucketId, filePath);

  let source;
  try {
    source = await fetch(upstreamUrl, buildHfFetchInit(env));
  } catch {
    throw new HttpError(502, 'Connexion au stockage Hugging Face interrompue.');
  }

  if (source.status === 404) {
    throw new HttpError(404, 'Document 3D introuvable dans le bucket Hugging Face.');
  }
  if (!source.ok) {
    throw new HttpError(source.status >= 500 ? 502 : source.status, 'Impossible de lire le fichier 3D pour Autodesk.');
  }

  const contentLength = Number(source.headers.get('Content-Length'));
  const maxBytes = positiveInteger(env.MAX_APS_UPLOAD_BYTES, DEFAULT_APS_UPLOAD_BYTES);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError(
      413,
      `Ce fichier est trop volumineux pour Autodesk (limite ${Math.round(maxBytes / 1024 / 1024)} Mo).`,
    );
  }

  const uploadPath = `${APS_BASE_URL}/oss/v2/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectKey)}/signeds3upload`;
  let signed;
  try {
    signed = await fetch(uploadPath, { headers: apsAuthHeaders(accessToken) });
  } catch {
    throw new HttpError(502, 'Demande d’URL de téléversement Autodesk impossible.');
  }
  if (!signed.ok) throw await autodeskHttpError(signed, 'Autodesk a refusé le téléversement du fichier.');

  let signedPayload;
  try {
    signedPayload = await signed.json();
  } catch {
    throw new HttpError(502, 'Réponse de téléversement Autodesk illisible.');
  }

  const uploadUrls = Array.isArray(signedPayload.urls) ? signedPayload.urls : [];
  const uploadUrl = uploadUrls[0];
  if (!uploadUrl || !signedPayload.uploadKey) {
    throw new HttpError(502, 'Autodesk n’a pas fourni d’URL de téléversement.');
  }

  let uploaded;
  try {
    uploaded = await fetch(uploadUrl, {
      method: 'PUT',
      body: source.body,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  } catch {
    throw new HttpError(502, 'Téléversement du fichier vers Autodesk impossible.');
  }
  if (!uploaded.ok) throw new HttpError(502, 'Le téléversement du fichier 3D a échoué.');

  let completed;
  try {
    completed = await fetch(
      `${APS_BASE_URL}/oss/v2/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectKey)}/signeds3upload`,
      {
        method: 'POST',
        headers: { ...apsAuthHeaders(accessToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadKey: signedPayload.uploadKey }),
      },
    );
  } catch {
    throw new HttpError(502, 'Validation du téléversement Autodesk impossible.');
  }
  if (!completed.ok) throw await autodeskHttpError(completed, 'Autodesk a refusé de valider le fichier.');

  let completedPayload;
  try {
    completedPayload = await completed.json();
  } catch {
    throw new HttpError(502, 'Réponse de fin de téléversement Autodesk illisible.');
  }
  if (!completedPayload.objectId) {
    throw new HttpError(502, 'Autodesk n’a pas confirmé le fichier téléversé.');
  }
  return String(completedPayload.objectId);
}

async function refreshApsRecord(env, ctx, filePath, size, mtime, record, accessToken) {
  if (!record.urn) return stripApsRecordForClient(record);

  let response;
  try {
    response = await fetch(
      `${APS_BASE_URL}/modelderivative/v2/designdata/${encodeURIComponent(record.urn)}/manifest`,
      { headers: apsAuthHeaders(accessToken) },
    );
  } catch {
    throw new HttpError(502, 'Vérification de la conversion Autodesk impossible.');
  }
  if (response.status === 404) {
    const pending = {
      ...record,
      status: 'inprogress',
      progress: 0,
      message: 'Conversion 3D en attente de démarrage…',
      updatedAt: new Date().toISOString(),
    };
    await storeApsRecord(ctx, env, filePath, size, mtime, pending);
    return { ...stripApsRecordForClient(pending), cacheStatus: 'pending' };
  }
  if (!response.ok) throw await autodeskHttpError(response, 'Autodesk n’a pas pu fournir l’état de conversion.');

  let manifest;
  try {
    manifest = await response.json();
  } catch {
    throw new HttpError(502, 'État de conversion Autodesk illisible.');
  }

  const status = normalizeApsManifestStatus(manifest.status);
  const updated = {
    ...record,
    status,
    progress: clampProgress(manifest.progress, status === 'success' ? 100 : 0),
    message: describeApsManifest(manifest, filePath),
    updatedAt: new Date().toISOString(),
  };

  await storeApsRecord(ctx, env, filePath, size, mtime, updated);
  return { ...stripApsRecordForClient(updated), cacheStatus: 'checked' };
}

async function readApsRecord(env, ctx, filePath, size, mtime) {
  const sourceKey = makeApsSourceKey(filePath, size, mtime);
  const bucketId = getBucketId(env);
  const cache = caches.default;
  const cacheKey = makeCacheKey('aps', bucketId, { file: sourceKey });
  const cached = await cache.match(cacheKey);
  if (cached) {
    try {
      return JSON.parse(await cached.text());
    } catch {
      // Ignore une entrée corrompue et relire la source KV.
    }
  }

  const kvBody = await readMetadataKv(env, makeKvKey('aps', bucketId, sourceKey));
  if (kvBody) {
    try {
      const record = JSON.parse(kvBody);
      storeJsonInCache(
        ctx,
        cache,
        cacheKey,
        kvBody,
        positiveInteger(env.APS_CACHE_TTL, DEFAULT_APS_CACHE_TTL),
      );
      return record;
    } catch {
      // Ignore une entrée KV corrompue.
    }
  }

  return null;
}

async function storeApsRecord(ctx, env, filePath, size, mtime, record) {
  const sourceKey = makeApsSourceKey(filePath, size, mtime);
  const bucketId = getBucketId(env);
  const body = JSON.stringify(record);
  const ttl = positiveInteger(env.APS_CACHE_TTL, DEFAULT_APS_CACHE_TTL);
  storeJsonInCache(ctx, caches.default, makeCacheKey('aps', bucketId, { file: sourceKey }), body, ttl);
  storeMetadataKv(ctx, env, makeKvKey('aps', bucketId, sourceKey), body);
}

function apsAuthHeaders(accessToken) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };
}

function normalizeApsManifestStatus(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'success' || value === 'complete') return 'success';
  if (value === 'failed' || value === 'timeout' || value === 'canceled' || value === 'cancelled') {
    return 'failed';
  }
  return 'inprogress';
}

function clampProgress(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, Math.round(number)));
}

export function describeApsManifest(manifest, filePath = '') {
  const messages = (manifest.derivatives || [])
    .flatMap((derivative) => derivative.messages || [])
    .filter((message) => message && (message.type === 'error' || message.type === 'warning'))
    .map((message) => String(message.message || ''))
    .filter(Boolean);

  const status = normalizeApsManifestStatus(manifest.status);
  if (status === 'success') return 'Modèle 3D prêt.';
  if (status === 'failed') return describeApsFailure(messages, filePath);
  return manifest && String(manifest.progress || '') ? `Conversion en cours (${clampProgress(manifest.progress)} %).` : 'Conversion en cours…';
}

/** Traduit les erreurs du convertisseur Autodesk en message actionnable. */
export function describeApsFailure(messages = [], filePath = '') {
  const raw = messages.filter(Boolean).join(' · ') || 'La conversion 3D a échoué.';
  const unsupported = /version of the file.{0,30}not supported|not supported|unsupported/i.test(raw);
  if (!unsupported) return raw;

  const extension = String(filePath || '').split('.').pop()?.toUpperCase() || '3D';
  return (
    `La version du fichier ${extension} n’est pas prise en charge par le convertisseur Autodesk. ` +
    `Exportez le modèle en STEP/IGES/OBJ/STL puis réessayez, ou téléchargez le fichier pour l’ouvrir dans son application d’origine. ` +
    `(Autodesk : ${raw})`
  );
}

function stripApsRecordForClient(record) {
  return {
    status: record.status,
    urn: record.urn || null,
    progress: record.progress,
    message: record.message,
    updatedAt: record.updatedAt,
  };
}

function base64Encode(value) {
  return btoa(String(value));
}

function base64ToUrlSafe(value) {
  return String(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function normalizeNumericSearchParam(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : '';
}

async function autodeskHttpError(response, fallback) {
  let detail = fallback;
  try {
    const body = await response.json();
    detail = body.diagnostic || body.developerMessage || body.message || JSON.stringify(body);
  } catch {
    // Le corps n'est pas un JSON lisible, conserver le message générique.
  }
  return new HttpError(response.status >= 500 ? 502 : response.status, `Autodesk APS : ${detail}`);
}

export async function fetchBucketTree(env, prefix = '', recursive = false) {
  const bucketId = getBucketId(env);
  const items = [];
  let nextUrl = buildHfTreeUrl(bucketId, prefix, recursive);
  let pageCount = 0;
  let complete = true;

  while (nextUrl && pageCount < MAX_TREE_PAGES && items.length < MAX_INDEX_ITEMS) {
    let response;
    try {
      response = await fetch(nextUrl, buildHfFetchInit(env));
    } catch {
      throw new HttpError(502, 'Connexion au stockage Hugging Face interrompue.');
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new HttpError(
          502,
          'Le bucket Hugging Face requiert une autorisation côté serveur.',
        );
      }
      if (response.status === 404) {
        throw new HttpError(404, 'Ce dossier n’existe pas dans la bibliothèque.');
      }
      throw new HttpError(502, 'Impossible de joindre le stockage Hugging Face.');
    }

    const data = await response.json();
    const pageItems = Array.isArray(data) ? data : data.items;
    if (!Array.isArray(pageItems)) {
      throw new HttpError(502, 'Réponse inattendue du stockage Hugging Face.');
    }

    items.push(...pageItems);
    nextUrl = getNextLink(response.headers.get('Link'), nextUrl);
    pageCount += 1;
  }

  if (nextUrl || items.length >= MAX_INDEX_ITEMS) complete = false;
  return { items: items.slice(0, MAX_INDEX_ITEMS), complete };
}

export function buildHfTreeUrl(bucketId, prefix = '', recursive = false) {
  const encodedBucket = encodeBucketId(bucketId);
  const encodedPrefix = prefix ? `/${encodeURIComponent(normalizePrefix(prefix))}` : '';
  const url = new URL(`${HF_ORIGIN}/api/buckets/${encodedBucket}/tree${encodedPrefix}`);
  url.searchParams.set('recursive', String(Boolean(recursive)));
  if (recursive) url.searchParams.set('limit', '1000');
  return url.toString();
}

export function buildHfFileUrl(bucketId, filePath) {
  const encodedBucket = encodeBucketId(bucketId);
  const encodedPath = normalizeFilePath(filePath)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${HF_ORIGIN}/buckets/${encodedBucket}/resolve/${encodedPath}?download=false`;
}

export function getNextLink(linkHeader, currentUrl) {
  if (!linkHeader) return null;

  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel=(?:"next"|next)/i);
    if (match) return new URL(match[1], currentUrl).toString();
  }

  return null;
}

export function normalizePrefix(value) {
  const prefix = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
  validatePath(prefix, true);
  return prefix;
}

export function normalizeFilePath(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    throw new HttpError(400, 'Le chemin du document est obligatoire.');
  }
  const filePath = String(value).trim().replace(/^\/+/, '');
  validatePath(filePath, false);
  return filePath;
}

function validatePath(value, allowEmpty) {
  if (!allowEmpty && value.length === 0) {
    throw new HttpError(400, 'Chemin de document invalide.');
  }
  const hasControlCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (value.length > 1500 || hasControlCharacter) {
    throw new HttpError(400, 'Chemin de document invalide.');
  }
  if (value.split('/').some((segment) => segment === '..')) {
    throw new HttpError(400, 'Chemin de document invalide.');
  }
}

function getBucketId(env) {
  const value = String(env.HF_BUCKET_ID || DEFAULT_BUCKET_ID).trim();
  if (!/^[\w.-]+\/[\w.-]+$/u.test(value)) {
    throw new HttpError(500, 'Configuration HF_BUCKET_ID invalide.');
  }
  return value;
}

function encodeBucketId(bucketId) {
  return bucketId.split('/').map(encodeURIComponent).join('/');
}

function buildHfHeaders(env) {
  const headers = new Headers({
    Accept: 'application/json, application/octet-stream;q=0.9, */*;q=0.8',
    'User-Agent': 'enise-docs-cloudflare-worker/1.0',
  });
  if (env.HF_TOKEN) headers.set('Authorization', `Bearer ${env.HF_TOKEN}`);
  return headers;
}

export function buildHfFetchInit(env) {
  return {
    headers: buildHfHeaders(env),
    redirect: 'follow',
  };
}

export function countFilesByDirectory(items, prefix = '') {
  const base = String(prefix || '').replace(/^\/+|\/+$/g, '');
  const counts = {};
  let totalFiles = 0;

  for (const item of items) {
    if (!item || item.type === 'directory') continue;
    const path = String(item.path || '').replace(/^\/+/, '');
    if (!path) continue;
    if (base && path !== base && !path.startsWith(`${base}/`)) continue;
    totalFiles += 1;
    const parts = path.split('/').filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) {
      const dirPath = parts.slice(0, index).join('/');
      if (base && (dirPath === base || !dirPath.startsWith(`${base}/`))) continue;
      counts[dirPath] = (counts[dirPath] || 0) + 1;
    }
  }

  return { counts, totalFiles };
}

function makeCacheKey(kind, bucketId, params = {}) {
  const url = new URL(`https://edge-cache.enise-docs.internal/${CACHE_KEY_VERSION}/${kind}`);
  url.searchParams.set('bucket', bucketId);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return new Request(url, { method: 'GET' });
}

function storeJsonInCache(ctx, cache, cacheKey, body, ttl) {
  const response = new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${ttl}`,
      ...API_SECURITY_HEADERS,
    },
  });
  ctx.waitUntil(
    cache.put(cacheKey, response).catch((error) => {
      console.error('Unable to persist JSON in Cache API', error);
    }),
  );
}

async function readMetadataKv(env, key) {
  if (!env.METADATA_KV) return null;
  try {
    return await env.METADATA_KV.get(key);
  } catch (error) {
    console.error('Unable to read metadata from Workers KV', error);
    return null;
  }
}

function storeMetadataKv(ctx, env, key, body) {
  if (!env.METADATA_KV) return;
  const expirationTtl = positiveInteger(env.KV_CACHE_TTL, DEFAULT_KV_TTL);
  ctx.waitUntil(
    env.METADATA_KV.put(key, body, { expirationTtl }).catch((error) => {
      console.error('Unable to persist metadata in Workers KV', error);
    }),
  );
}

function hashIdentifier(value) {
  const source = String(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export function makeKvKey(kind, bucketId, suffix = '') {
  const value = `${CACHE_KEY_VERSION}:${kind}:${bucketId}:${suffix}`;
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  const digest = [first, second]
    .map((part) => (part >>> 0).toString(16).padStart(8, '0'))
    .join('');
  return `enise-docs:${kind}:${digest}`;
}

function responseFromCache(cached, cacheStatus, cacheControl) {
  const response = new Response(cached.body, cached);
  response.headers.set('Cache-Control', cacheControl);
  response.headers.set('X-Cache-Status', cacheStatus);
  response.headers.set('Server-Timing', 'edge;desc="cache hit";dur=0');
  applySecurityHeaders(response.headers);
  return response;
}

function jsonResponse(value, options = {}) {
  const {
    status = 200,
    headers = {},
    cacheControl = 'no-store',
    serialized = false,
  } = options;
  const body = serialized ? value : JSON.stringify(value);
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
      ...API_SECURITY_HEADERS,
      ...headers,
    },
  });
}

function prepareFileResponse(source, { cacheStatus, shouldDownload, filePath }) {
  const response = new Response(source.body, source);
  response.headers.delete('Set-Cookie');
  response.headers.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  response.headers.set('Content-Disposition', contentDisposition(filePath, shouldDownload));
  response.headers.set('X-Cache-Status', cacheStatus);
  applySecurityHeaders(response.headers);

  const extension = getExtension(filePath);
  if (['html', 'htm', 'xml'].includes(extension)) {
    response.headers.set('Content-Type', 'text/plain; charset=utf-8');
    response.headers.set('Content-Security-Policy', "sandbox; default-src 'none'");
  } else if (extension === 'svg') {
    response.headers.set('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
  }

  return response;
}

function contentDisposition(filePath, shouldDownload) {
  const filename = filePath.split('/').pop() || 'document';
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${shouldDownload ? 'attachment' : 'inline'}; filename*=UTF-8''${encoded}`;
}

function compactBucketItem(item) {
  const compact = {
    type: item.type === 'directory' ? 'directory' : 'file',
    path: String(item.path || ''),
  };
  if (Number.isFinite(item.size)) compact.size = item.size;
  if (item.mtime || item.uploadedAt || item.uploaded_at) {
    compact.mtime = item.mtime || item.uploadedAt || item.uploaded_at;
  }
  if (Number.isFinite(item.numItems)) compact.numItems = item.numItems;
  if (Number.isFinite(item.totalFiles)) compact.totalFiles = item.totalFiles;
  return compact;
}

function positiveInteger(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function getExtension(filePath) {
  const filename = filePath.split('/').pop() || '';
  return filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
}

function applySecurityHeaders(headers) {
  Object.entries(API_SECURITY_HEADERS).forEach(([name, value]) => headers.set(name, value));
}

function assertMethod(request, allowedMethods) {
  if (!allowedMethods.includes(request.method)) {
    throw new HttpError(405, `Méthode ${request.method} non autorisée.`);
  }
}

function handleHealth(env) {
  return jsonResponse(
    {
      ok: true,
      service: 'enise-docs',
      bucketId: getBucketId(env),
      cache: 'cloudflare-cache-api',
    },
    { cacheControl: 'no-store' },
  );
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}
