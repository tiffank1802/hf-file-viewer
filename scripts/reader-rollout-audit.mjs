#!/usr/bin/env node

import fs from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_CATALOG_URL = 'https://huggingface.co/buckets/ktongue/ENISE-SITE-DERIVED/resolve/reader/v1/catalog.json';
const READY_STATUS = 'structured-ready';
const READER_SCHEMA = 'reader-ui/v1';
const FETCH_ATTEMPTS = 3;

export function selectPilotDocuments(catalog, limit = 8) {
  const maximum = Math.min(30, Math.max(1, Number(limit) || 8));
  const entries = Object.entries(catalog?.documents || {})
    .map(([sourcePath, entry]) => ({ ...entry, sourcePath }))
    .filter((entry) => (
      entry.status === 'ready'
      && entry.sourcePresent !== false
      && readerFamily(entry.sourcePath)
      && pilotPathSafe(entry.sourcePath)
    ));
  const lightweight = [...entries].sort((left, right) => (
    sortableSize(left.sourceSize) - sortableSize(right.sourceSize)
    || left.sourcePath.localeCompare(right.sourcePath, 'fr')
  ));
  const selected = [];
  const add = (entry, reason) => {
    if (!entry || selected.some((item) => item.sourcePath === entry.sourcePath) || selected.length >= maximum) return;
    selected.push({ ...entry, family: readerFamily(entry.sourcePath), reason });
  };

  add(lightweight.find((entry) => readerFamily(entry.sourcePath) === 'pdf' && positive(entry.assetCount) > 0), 'pdf-with-assets');
  add(lightweight.find((entry) => readerFamily(entry.sourcePath) === 'pdf' && positive(entry.assetCount) === 0), 'pdf-text');
  for (const family of ['document', 'presentation', 'spreadsheet', 'text', 'ebook', 'message', 'image']) {
    add(lightweight.find((entry) => readerFamily(entry.sourcePath) === family), `format-${family}`);
  }
  const longPDF = entries
    .filter((entry) => readerFamily(entry.sourcePath) === 'pdf')
    .sort((left, right) => positive(right.blockCount) - positive(left.blockCount))[0];
  add(longPDF, 'long-structured-pdf');
  for (const entry of lightweight) add(entry, 'lightweight-ready');
  return selected.slice(0, maximum);
}

export async function auditReaderRollout({
  origin,
  catalog,
  documents,
  limit = 8,
  timeoutMs = 20_000,
  fetchImpl = fetch,
}) {
  const base = normalizedOrigin(origin);
  const selected = documents?.length
    ? documents.map((sourcePath) => ({
      ...(catalog?.documents?.[sourcePath] || {}),
      sourcePath,
      family: readerFamily(sourcePath),
      reason: 'explicit',
    }))
    : selectPilotDocuments(catalog, limit);
  const report = {
    schemaVersion: 'reader-rollout-audit/v1',
    generatedAt: new Date().toISOString(),
    origin: base,
    catalogUpdatedAt: catalog?.updatedAt || null,
    pipelineVersion: catalog?.pipelineVersion || null,
    selected: selected.length,
    documents: [],
  };

  report.health = await auditHealth(base, timeoutMs, fetchImpl);
  for (const entry of selected) {
    report.documents.push(await auditDocument(base, entry, timeoutMs, fetchImpl));
  }
  const passed = report.documents.filter((item) => item.ok);
  report.pilotPaths = passed.map((item) => item.sourcePath);
  report.summary = {
    passed: passed.length,
    failed: report.documents.length - passed.length,
    pdfRangeReady: passed.filter((item) => item.checks.pdfRange === 'ok').length,
    blockTypes: [...new Set(passed.flatMap((item) => item.blockTypes))].sort(),
    families: [...new Set(passed.map((item) => item.family))].sort(),
  };
  report.ok = report.health.ok && report.summary.failed === 0 && report.summary.passed > 0;
  return report;
}

async function auditHealth(origin, timeoutMs, fetchImpl) {
  const started = performance.now();
  try {
    const payload = await requestJSON(`${origin}/api/health`, { timeoutMs, fetchImpl });
    return {
      ok: payload.response.ok && payload.body?.ok === true,
      status: payload.response.status,
      backend: payload.body?.backend || '',
      index: payload.body?.index || '',
      durationMs: elapsed(started),
    };
  } catch (error) {
    return { ok: false, status: error.status || 0, error: safeMessage(error), durationMs: elapsed(started) };
  }
}

async function auditDocument(origin, entry, timeoutMs, fetchImpl) {
  const result = {
    sourcePath: entry.sourcePath,
    family: entry.family || readerFamily(entry.sourcePath),
    reason: entry.reason || 'explicit',
    sourceSize: positive(entry.sourceSize),
    artifactId: entry.artifactId || '',
    checks: {},
    blockTypes: [],
    errors: [],
    durationsMs: {},
    ok: false,
  };
  const metadataStarted = performance.now();
  try {
    const metadataURL = apiURL(origin, '/api/reader/document', { path: entry.sourcePath });
    const metadata = await requestJSON(metadataURL, { timeoutMs, fetchImpl });
    result.durationsMs.metadata = elapsed(metadataStarted);
    if (!metadata.response.ok) throw httpError(metadata.response.status, metadata.body?.error || 'Métadonnées refusées.');
    if (metadata.body?.schemaVersion !== READER_SCHEMA) result.errors.push('reader-schema');
    if (metadata.body?.sourcePath !== entry.sourcePath) result.errors.push('source-path-mismatch');
    if (metadata.body?.status !== READY_STATUS) result.errors.push(`status:${metadata.body?.status || 'missing'}`);
    if (!metadata.body?.artifactId) result.errors.push('artifact-id-missing');
    if (entry.artifactId && metadata.body?.artifactId !== entry.artifactId) result.errors.push('artifact-id-mismatch');
    result.checks.metadata = result.errors.length === 0 ? 'ok' : 'failed';

    const artifactId = metadata.body?.artifactId || entry.artifactId;
    result.artifactId = artifactId || '';
    if (artifactId) {
      const blockErrorStart = result.errors.length;
      const blocksStarted = performance.now();
      const blocksURL = apiURL(origin, '/api/reader/blocks', {
        path: entry.sourcePath,
        artifactId,
        from: 1,
        limit: 40,
      });
      const blocks = await requestJSON(blocksURL, { timeoutMs, fetchImpl });
      if (!blocks.response.ok) throw httpError(blocks.response.status, blocks.body?.error || 'Blocs refusés.');
      const items = Array.isArray(blocks.body?.blocks) ? blocks.body.blocks : [];
      if (blocks.body?.schemaVersion !== READER_SCHEMA) result.errors.push('blocks-schema');
      if (blocks.body?.sourcePath !== entry.sourcePath) result.errors.push('blocks-source-path-mismatch');
      if (blocks.body?.artifactId !== artifactId) result.errors.push('blocks-artifact-id-mismatch');
      if (items.length === 0) result.errors.push('blocks-empty');
      if (items.length > 60) result.errors.push('blocks-unbounded');
      if (items.some((block) => !block?.id || !Number.isFinite(Number(block.ordinal)))) result.errors.push('blocks-invalid');
      result.blockTypes = [...new Set(items.map((block) => String(block.type || 'text').toLowerCase()))].sort();

      const nextFrom = positive(blocks.body?.nextFrom);
      result.checks.blockWindows = 1;
      if (nextFrom) {
        const nextWindow = await requestJSON(apiURL(origin, '/api/reader/blocks', {
          path: entry.sourcePath,
          artifactId,
          from: nextFrom,
          limit: 40,
        }), { timeoutMs, fetchImpl });
        if (!nextWindow.response.ok) throw httpError(nextWindow.response.status, nextWindow.body?.error || 'Fenêtre de blocs suivante refusée.');
        const nextItems = Array.isArray(nextWindow.body?.blocks) ? nextWindow.body.blocks : [];
        if (
          nextWindow.body?.schemaVersion !== READER_SCHEMA
          || nextWindow.body?.sourcePath !== entry.sourcePath
          || nextWindow.body?.artifactId !== artifactId
        ) result.errors.push('blocks-next-schema');
        if (positive(nextWindow.body?.from) !== nextFrom || nextItems.length === 0) result.errors.push('blocks-next-window');
        if (nextItems.some((block) => !block?.id || !Number.isFinite(Number(block.ordinal)))) result.errors.push('blocks-next-invalid');
        result.blockTypes = [...new Set([
          ...result.blockTypes,
          ...nextItems.map((block) => String(block.type || 'text').toLowerCase()),
        ])].sort();
        result.checks.blockWindows = 2;
      } else if (positive(blocks.body?.total) > items.length) {
        result.errors.push('blocks-next-from-missing');
      }
      result.durationsMs.blocks = elapsed(blocksStarted);
      result.checks.blocks = result.errors.length === blockErrorStart ? 'ok' : 'failed';

      const target = items[Math.min(items.length - 1, 3)];
      if (target?.id) {
        const directURL = apiURL(origin, '/api/reader/blocks', {
          path: entry.sourcePath,
          artifactId,
          blockId: target.id,
          limit: 8,
        });
        const direct = await requestJSON(directURL, { timeoutMs, fetchImpl });
        const directItems = Array.isArray(direct.body?.blocks) ? direct.body.blocks : [];
        if (
          !direct.response.ok
          || direct.body?.schemaVersion !== READER_SCHEMA
          || direct.body?.sourcePath !== entry.sourcePath
          || direct.body?.artifactId !== artifactId
          || !directItems.some((block) => block.id === target.id)
        ) result.errors.push('direct-block-navigation');
        else result.checks.directBlock = 'ok';
      }
    }

    if (result.family === 'pdf') {
      const rangeStarted = performance.now();
      const range = await requestFirstChunk(apiURL(origin, '/api/file', { path: entry.sourcePath }), {
        timeoutMs,
        fetchImpl,
        headers: { Range: 'bytes=0-1023' },
      });
      result.durationsMs.pdfRange = elapsed(rangeStarted);
      if (range.status !== 206 || range.bytes === 0) result.errors.push(`pdf-range:${range.status}`);
      else if (!/^bytes 0-\d+\/\d+$/i.test(range.contentRange)) result.errors.push('pdf-content-range-invalid');
      else result.checks.pdfRange = 'ok';
    }
  } catch (error) {
    result.errors.push(`request:${error.status || 0}:${safeMessage(error)}`);
  }
  if (!readerFamily(entry.sourcePath)) result.errors.push('pilot-format-unsupported');
  if (!pilotPathSafe(entry.sourcePath)) result.errors.push('pilot-path-unrepresentable');
  result.errors = [...new Set(result.errors)];
  result.ok = result.errors.length === 0;
  return result;
}

export function renderAuditReport(report) {
  const lines = [
    '# Audit du rollout lecteur',
    '',
    `- Origine : ${report.origin}`,
    `- Verdict : ${report.ok ? 'PROMOTION AUTORISÉE' : 'PROMOTION BLOQUÉE'}`,
    `- Santé API : ${report.health?.ok ? 'OK' : 'ÉCHEC'} (${report.health?.status || 0})`,
    `- Documents : ${report.summary?.passed || 0} réussis, ${report.summary?.failed || 0} en échec`,
    `- Familles validées : ${(report.summary?.families || []).join(', ') || 'aucune'}`,
    `- Types de blocs observés : ${(report.summary?.blockTypes || []).join(', ') || 'aucun'}`,
    '',
    '| État | Famille | Raison | Document | Erreurs |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const item of report.documents || []) {
    lines.push(`| ${item.ok ? 'OK' : 'ÉCHEC'} | ${item.family} | ${item.reason} | ${escapeCell(item.sourcePath)} | ${escapeCell(item.errors.join(', '))} |`);
  }
  if (report.ok && report.pilotPaths?.length) {
    lines.push('', '## Allowlist pilote', '', '```dotenv', `VITE_READER_ROLLOUT="pilot"`, `VITE_READER_PILOT_PATHS="${report.pilotPaths.join(',')}"`, '```');
  }
  return `${lines.join('\n')}\n`;
}

export function readerFamily(sourcePath) {
  const extension = path.extname(String(sourcePath || '')).slice(1).toLowerCase();
  if (extension === 'pdf') return 'pdf';
  if (['docx', 'odt'].includes(extension)) return 'document';
  if (['pptx', 'odp'].includes(extension)) return 'presentation';
  if (['xlsx', 'ods', 'csv'].includes(extension)) return 'spreadsheet';
  if (['html', 'htm', 'md', 'txt', 'adoc', 'asciidoc', 'tex', 'vtt'].includes(extension)) return 'text';
  if (extension === 'epub') return 'ebook';
  if (['eml', 'msg'].includes(extension)) return 'message';
  if (['png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp', 'bmp'].includes(extension)) return 'image';
  return '';
}

async function requestJSON(url, { timeoutMs, fetchImpl }) {
  const response = await timedFetch(url, { timeoutMs, fetchImpl, headers: { Accept: 'application/json' } });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw httpError(response.status, 'Réponse JSON illisible.');
  }
  return { response, body };
}

async function requestFirstChunk(url, { timeoutMs, fetchImpl, headers }) {
  const response = await timedFetch(url, { timeoutMs, fetchImpl, headers });
  let bytes = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const first = await reader.read();
    bytes = first.value?.byteLength || 0;
    await reader.cancel().catch(() => {});
  } else {
    bytes = (await response.arrayBuffer()).byteLength;
  }
  return {
    status: response.status,
    bytes,
    contentRange: response.headers.get('Content-Range') || '',
  };
}

async function timedFetch(url, { timeoutMs, fetchImpl, headers = {} }) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { headers, signal: controller.signal });
      if (!retryableStatus(response.status) || attempt === FETCH_ATTEMPTS) return response;
      if (response.body) await response.body.cancel().catch(() => {});
      lastError = httpError(response.status, `HTTP ${response.status} transitoire.`);
    } catch (error) {
      if (error.name === 'AbortError') lastError = httpError(408, `Délai dépassé après ${timeoutMs} ms.`);
      else lastError = networkError(error);
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < FETCH_ATTEMPTS) await delay(250 * (2 ** (attempt - 1)));
  }
  throw lastError || new Error('Requête réseau interrompue.');
}

function retryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function networkError(error) {
  const code = error?.cause?.code || error?.code || '';
  const suffix = code ? ` (${code})` : '';
  const wrapped = new Error(`${error?.message || 'Requête réseau interrompue.'}${suffix}`);
  wrapped.cause = error;
  return wrapped;
}

function delay(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function normalizedOrigin(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('L’origine doit utiliser HTTP ou HTTPS.');
  return url.origin;
}

function apiURL(origin, pathname, values) {
  const url = new URL(pathname, origin);
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, String(value));
  return url.toString();
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function sortableSize(value) {
  return positive(value) || Number.MAX_SAFE_INTEGER;
}

function pilotPathSafe(value) {
  const sourcePath = String(value || '');
  return sourcePath === sourcePath.trim() && sourcePath.length > 0 && !/[,\\\r\n"$]/.test(sourcePath);
}

function elapsed(started) {
  return Math.max(0, Math.round(performance.now() - started));
}

function safeMessage(error) {
  return String(error?.message || error || 'Erreur inconnue').replace(/[\r\n|]+/g, ' ').slice(0, 240);
}

function escapeCell(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function parseArgs(argv) {
  const options = { paths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Valeur manquante pour ${arg}.`);
      index += 1;
      return value;
    };
    if (arg === '--origin') options.origin = next();
    else if (arg === '--catalog-url') options.catalogURL = next();
    else if (arg === '--limit') options.limit = Number(next());
    else if (arg === '--timeout-ms') options.timeoutMs = Number(next());
    else if (arg === '--path') options.paths.push(next());
    else if (arg === '--json') options.jsonPath = next();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Option inconnue: ${arg}`);
  }
  return options;
}

function usage() {
  return `Audit non destructif du lecteur préconverti.\n\nUsage:\n  npm run reader:audit -- --origin https://api.example.test [options]\n\nOptions:\n  --catalog-url URL   catalogue reader/v1 (défaut: bucket dérivé public)\n  --limit N           documents représentatifs, 1 à 30 (défaut: 8)\n  --path PATH         document exact; option répétable\n  --timeout-ms N      délai par requête (défaut: 20000)\n  --json FILE         écrire aussi le rapport JSON\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const origin = options.origin || process.env.READER_AUDIT_ORIGIN;
  if (!origin) throw new Error('--origin ou READER_AUDIT_ORIGIN est requis.');
  const catalogURL = options.catalogURL || process.env.READER_CATALOG_URL || DEFAULT_CATALOG_URL;
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 30)) {
    throw new Error('--limit doit être un entier compris entre 1 et 30.');
  }
  const timeoutMs = options.timeoutMs === undefined ? 20_000 : Number(options.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error('--timeout-ms doit être compris entre 1000 et 120000.');
  }
  const catalogPayload = await requestJSON(catalogURL, { timeoutMs, fetchImpl: fetch });
  if (!catalogPayload.response.ok) throw httpError(catalogPayload.response.status, 'Catalogue Docling indisponible.');
  const report = await auditReaderRollout({
    origin,
    catalog: catalogPayload.body,
    documents: options.paths,
    limit: options.limit,
    timeoutMs,
  });
  process.stdout.write(renderAuditReport(report));
  if (options.jsonPath) await fs.writeFile(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (!report.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Audit impossible: ${safeMessage(error)}\n`);
    process.exitCode = 1;
  });
}
