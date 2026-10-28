import assert from 'node:assert/strict';
import test from 'node:test';

import { streamChat } from '../src/services/chat.js';

test('streamChat transmet le scope documentaire et restitue les citations SSE', async (t) => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: scope\ndata: {"type":"document","knowledgeSource":"docling"}\n\n'));
        controller.enqueue(encoder.encode('event: citations\ndata: {"citations":[{"citationId":"S1","page":4}]}\n\n'));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const events = [];
  await streamChat({
    message: 'Résume ce document',
    intent: 'summary',
    scope: { type: 'document', sourcePath: 'GM/3A/cours.pdf', artifactId: 'artifact-1' },
    history: [],
    contextPath: 'GM/3A',
    onEvent: (event) => events.push(event),
  });

  assert.equal(request.url, '/api/chat');
  const body = JSON.parse(request.options.body);
  assert.equal(body.intent, 'summary');
  assert.deepEqual(body.scope, {
    type: 'document',
    sourcePath: 'GM/3A/cours.pdf',
    artifactId: 'artifact-1',
  });
  assert.equal(events[0].event, 'scope');
  assert.equal(events[0].data.knowledgeSource, 'docling');
  assert.equal(events[1].event, 'citations');
  assert.equal(events[1].data.citations[0].citationId, 'S1');
  assert.equal(events[1].data.citations[0].page, 4);
});

test('Tauri transmet le contexte PDF dans le flux IPC et l’annulation interrompt la demande', async (t) => {
  const oldWindow = globalThis.window;
  const requests = [];
  let unblock;
  const callbacks = new Map();
  globalThis.window = {
    isTauri: true,
    __TAURI_INTERNALS__: {
      transformCallback(callback) { const id = callbacks.size + 1; callbacks.set(id, callback); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(command, args) {
        requests.push({ command, args });
        if (command === 'tauri_chat_cancel') { unblock?.(); return; }
        if (command === 'tauri_chat_stream') {
          args.onEvent.onmessage({ kind: 'chunk', text: 'event: citations\ndata: {"citations":' });
          args.onEvent.onmessage({ kind: 'chunk', text: '[{"citationId":"S1","verified":false}]}\n\n' });
          await new Promise((resolve) => { unblock = resolve; });
        }
      },
    },
  };
  t.after(() => { if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow; });
  const controller = new AbortController();
  const events = [];
  const stream = streamChat({
    message: 'Explique cette sélection',
    scope: { type: 'document', sourcePath: 'GM/cours.pdf', sourceRevision: `sha256:${'a'.repeat(64)}` },
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  });
  // Wait for the IPC command to be registered; it stays pending until canceled.
  for (let attempt = 0; !unblock && attempt < 500; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(typeof unblock, 'function', 'le flux IPC doit être enregistré');
  assert.equal(JSON.parse(requests[0].args.body).scope.sourceRevision, `sha256:${'a'.repeat(64)}`);
  assert.equal(events[0].event, 'citations');
  assert.equal(events[0].data.citations[0].verified, false);
  controller.abort();
  await assert.rejects(stream, { name: 'AbortError' });
  assert.equal(requests[1].command, 'tauri_chat_cancel');
  assert.equal(requests[1].args.streamId, requests[0].args.streamId);
});
