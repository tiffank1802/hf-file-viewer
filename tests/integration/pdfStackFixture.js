import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PDF_PATH = 'Fixtures/reader-r6.pdf';
export const USERS = { alice: 'session-alice-test', bob: 'session-bob-test' };

function replyJSON(response, data, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(data));
}

async function bodyJSON(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function reservePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitUntilReady(base, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Le backend Go s'est arrêté (${child.exitCode}).`);
    try {
      const response = await fetch(`${base}/api/auth/session`);
      if (response.ok) return;
    } catch {
      // The process logs before ListenAndServe has bound its socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Le backend Go ne répond pas.');
}

/** Real Go and static frontend; only storage, Appwrite and the AI are fake. */
export async function startPDFStack() {
  const binary = process.env.PDF_INTEGRATION_GO_BIN;
  if (!binary) throw new Error('Utilisez npm run test:pdf-integration pour compiler le backend de test.');
  const temp = await mkdtemp(path.join(tmpdir(), 'enise-pdf-stack-'));
  // Go reads DEV_VARS even when credentials are empty in the environment.
  // Point it to an actual empty file so it cannot fall back to operator secrets.
  const emptyDevVars = path.join(temp, 'empty-dev-vars');
  await writeFile(emptyDevVars, '', { mode: 0o600 });
  const pdf = await readFile(path.join(ROOT, 'tests/fixtures/reader-r6.pdf'));
  const documentKey = createHash('sha256').update(PDF_PATH).digest('hex');
  const state = {
    etag: '"integration-v1"',
    rows: new Map(),
    permissions: [],
    prompts: [],
    providerAborts: 0,
    doclingRequests: 0,
    fileRequests: [],
    pdfListCalls: 0,
    pdfListGate: null,
    // The fake intentionally leaks all rows to exercise Go's second
    // ownership check, in addition to asserting the Appwrite permissions.
    legacy: [{
      $id: 'legacy-note',
      data: {
        userId: 'alice', documentKey, sourcePath: PDF_PATH, artifactId: 'ancienne-structure',
        anchorJson: JSON.stringify({ page: 1, quote: 'Ancien passage', start: 0, end: 14 }),
        kind: 'note', color: 'yellow', status: 'active', body: 'Ancienne note Docling', page: 1,
      },
    }],
  };
  const upstream = http.createServer((request, response) => {
    void handleFake(request, response, state, pdf).catch((error) => {
      if (!response.headersSent) replyJSON(response, { message: error.message }, 500);
      else response.destroy(error);
    });
  });
  await new Promise((resolve, reject) => upstream.listen(0, '127.0.0.1', resolve).once('error', reject));
  const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(binary, [], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      ENISE_ROOT: temp,
      DEV_VARS: emptyDevVars,
      ADDR: `127.0.0.1:${port}`,
      STATIC_DIR: path.join(ROOT, 'dist'),
      CACHE_DIR: path.join(temp, 'cache'),
      HF_ORIGIN: upstreamURL,
      HF_BUCKET_ID: 'ktongue/ENISE-SITE',
      HF_DERIVED_BUCKET_ID: 'ktongue/ENISE-SITE-DERIVED',
      HF_TOKEN: '',
      APPWRITE_ENABLED: '1',
      APPWRITE_ENDPOINT: upstreamURL,
      APPWRITE_PUBLIC_ORIGIN: '',
      APPWRITE_PROJECT_ID: 'testproject',
      APPWRITE_DATABASE_ID: 'testdb',
      APPWRITE_PROFILE_TABLE_ID: 'profiles',
      APPWRITE_FAVORITES_TABLE_ID: 'favorites',
      APPWRITE_CONVERSATIONS_TABLE_ID: 'conversations',
      APPWRITE_MESSAGES_TABLE_ID: 'messages',
      APPWRITE_ANNOTATIONS_TABLE_ID: 'annotations',
      APPWRITE_PDF_ANNOTATIONS_TABLE_ID: 'pdf_annotations_v2',
      APPWRITE_FLAVOR: 'tablesdb',
      NVIDIA_API_KEY: 'test-provider-key',
      NVIDIA_API_BASE: `${upstreamURL}/v1`,
      NVIDIA_MODEL: 'meta/llama-3.1-8b-instruct',
      NVIDIA_NIM_API_KEY: '',
      OPENROUTER_API_KEY: '', OPENROUTER_KEY: '', OPENCODE_API_KEY: '', OPENCODE_ZEN_API_KEY: '',
      CLOUDFLARE_AI_TOKEN: '', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '',
    },
  });
  let logs = '';
  child.stderr.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-30_000); });

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
      timer.unref();
      await once(child, 'exit').catch(() => {});
      clearTimeout(timer);
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(temp, { recursive: true, force: true });
  };
  try {
    await waitUntilReady(base, child);
  } catch (error) {
    await stop();
    throw new Error(`${error.message}\n${logs}`);
  }
  return { base, pdf, state, stop, logs: () => logs };
}

async function handleFake(request, response, state, pdf) {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname.endsWith('/tree')) {
    return replyJSON(response, [{ type: 'file', path: PDF_PATH, size: pdf.length }]);
  }
  if (url.pathname.includes('/reader/v1/')) {
    state.doclingRequests += 1;
    return replyJSON(response, { message: 'Docling volontairement indisponible' }, 503);
  }
  if (url.pathname.endsWith(`/resolve/${PDF_PATH}`)) {
    state.fileRequests.push({ method: request.method, range: request.headers.range || '' });
    const headers = { 'Content-Type': 'application/pdf', 'Accept-Ranges': 'bytes' };
    if (state.etag) headers.ETag = state.etag;
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    if (match) {
      const start = Number(match[1]);
      const end = Math.min(pdf.length - 1, match[2] ? Number(match[2]) : pdf.length - 1);
      if (start >= pdf.length || end < start) {
        response.writeHead(416, { 'Content-Range': `bytes */${pdf.length}` });
        return response.end();
      }
      response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${pdf.length}`, 'Content-Length': end - start + 1 });
      return response.end(request.method === 'HEAD' ? undefined : pdf.subarray(start, end + 1));
    }
    response.writeHead(200, { ...headers, 'Content-Length': pdf.length });
    return response.end(request.method === 'HEAD' ? undefined : pdf);
  }
  if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
    const body = await bodyJSON(request);
    state.prompts.push(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    const prompt = JSON.stringify(body.messages);
    if (prompt.includes('Attends volontairement')) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Réponse partielle. ' } }] })}\n\n`);
      const timer = setTimeout(() => response.end('data: [DONE]\n\n'), 15_000);
      response.on('close', () => {
        clearTimeout(timer);
        if (!response.writableFinished) state.providerAborts += 1;
      });
      return;
    }
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'La vitesse intervient au carré [S1].' } }] })}\n\n`);
    return response.end('data: [DONE]\n\n');
  }
  const session = request.headers['x-appwrite-session'];
  const user = Object.entries(USERS).find(([, token]) => token === session)?.[0];
  if (url.pathname === '/account') {
    return user
      ? replyJSON(response, { $id: user, name: user, email: `${user}@example.test` })
      : replyJSON(response, { type: 'user_unauthorized', message: 'Session inconnue' }, 401);
  }
  if (url.pathname.startsWith('/tablesdb/testdb/tables/')) {
    if (!user) return replyJSON(response, { type: 'user_unauthorized' }, 401);
    if (url.pathname.includes('/profiles/rows/')) {
      return replyJSON(response, { type: 'row_not_found', message: 'Profil absent' }, 404);
    }
    if (url.pathname.endsWith('/favorites/rows')) return replyJSON(response, { rows: [], total: 0 });
    if (url.pathname.endsWith('/annotations/rows') && request.method === 'GET') {
      return replyJSON(response, { rows: state.legacy, total: state.legacy.length });
    }
    if (url.pathname.endsWith('/pdf_annotations_v2/rows')) {
      if (request.method === 'GET') {
        state.pdfListCalls += 1;
        const rows = [...state.rows.values()].map((row) => structuredClone(row));
        const gate = state.pdfListGate;
        if (gate) await gate;
        return replyJSON(response, { rows, total: rows.length });
      }
      if (request.method === 'POST') {
        const input = await bodyJSON(request);
        state.permissions.push({ user, permissions: input.permissions });
        const row = { $id: input.rowId, data: input.data };
        state.rows.set(input.rowId, row);
        return replyJSON(response, row, 201);
      }
    }
    const match = /\/pdf_annotations_v2\/rows\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const row = state.rows.get(id);
      if (!row) return replyJSON(response, { type: 'row_not_found' }, 404);
      if (request.method === 'GET') return replyJSON(response, row);
      if (request.method === 'PATCH') {
        const patch = await bodyJSON(request);
        row.data = { ...row.data, ...patch.data };
        return replyJSON(response, row);
      }
      if (request.method === 'DELETE') {
        state.rows.delete(id);
        response.writeHead(204);
        return response.end();
      }
    }
  }
  return replyJSON(response, { message: `Route simulée absente : ${request.method} ${url.pathname}` }, 404);
}

/** Restrict the test browser to this local origin; it cannot reach production. */
export async function isolateContext(context, base, user) {
  if (user) await context.addCookies([{ name: 'enise_session', value: USERS[user], url: base, httpOnly: true }]);
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.origin === base ? route.continue() : route.abort('blockedbyclient');
  });
}

/**
 * Simulate only the native transport boundary: inject the test session and
 * stream the real Go response. This is not the Rust gateway or a WebView.
 */
export async function startSimulatedTauriGateway(stack, user) {
  const requests = [];
  const server = http.createServer((request, response) => {
    // Serve the UI and simulated gateway under one origin so the unchanged Web
    // CSP still applies. The actual custom protocol is only available in Tauri.
    const target = new URL(request.url, stack.base);
    if (target.origin !== stack.base) {
      response.writeHead(403);
      return response.end();
    }
    requests.push({ method: request.method, url: request.url, range: request.headers.range || '' });
    const proxy = http.request(target, {
      method: request.method,
      headers: { ...request.headers, host: target.host, cookie: `enise_session=${USERS[user]}` },
    }, (upstream) => {
      response.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(response);
    });
    proxy.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.on('aborted', () => proxy.destroy());
    response.on('close', () => { if (!response.writableFinished) proxy.destroy(); });
    request.pipe(proxy);
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    stop: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
