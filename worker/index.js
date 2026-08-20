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
