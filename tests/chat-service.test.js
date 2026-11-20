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
