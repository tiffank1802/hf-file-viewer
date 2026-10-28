import { apiCredentials, apiUrl, isTauriRuntime } from '../utils/runtime.js';

export async function fetchChatStatus(signal) {
  const response = await fetch(apiUrl('/api/chat/status'), {
    signal,
    credentials: apiCredentials(),
    headers: { Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Assistant indisponible.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function streamChat({ message, intent, scope, history, contextPath, conversationId, provider, model, catalog, signal, onEvent }) {
  const serializedBody = JSON.stringify({
    message,
    intent,
    scope,
    history,
    contextPath,
    conversationId,
    provider,
    model,
    catalog,
  });

  if (isTauriRuntime()) {
    await streamChatViaTauri({ serializedBody, signal, onEvent });
    return;
  }

  const response = await fetch(apiUrl('/api/chat'), {
    method: 'POST',
    signal,
    credentials: apiCredentials(),
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: serializedBody,
  });
  const contentType = response.headers.get('Content-Type') || '';
  if (!response.ok || !contentType.includes('text/event-stream') || !response.body) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error || 'L’assistant n’a pas pu répondre.');
    error.status = response.status;
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (block) => {
    const event = parseEvent(block);
    if (event) onEvent(event);
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    blocks.forEach(consume);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
}

async function streamChatViaTauri({ serializedBody, signal, onEvent }) {
  if (signal?.aborted) {
    throw new DOMException('La requête a été annulée.', 'AbortError');
  }
  const { Channel, invoke } = await import('@tauri-apps/api/core');
  if (signal?.aborted) {
    throw new DOMException('La requête a été annulée.', 'AbortError');
  }
  const streamId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let buffer = '';
  let streamError = null;

  const consume = (block) => {
    const event = parseEvent(block);
    if (event) onEvent(event);
  };

  const onChunk = new Channel();
  onChunk.onmessage = (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'chunk' && typeof msg.text === 'string') {
      buffer += msg.text;
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';
      blocks.forEach(consume);
    } else if (msg.kind === 'error') {
      const error = new Error(msg.message || 'L’assistant n’a pas pu répondre.');
      error.status = Number(msg.status) || 502;
      streamError = error;
    } else if (msg.kind === 'done' && buffer.trim()) {
      consume(buffer);
      buffer = '';
    }
  };

  const onAbort = () => {
    void invoke('tauri_chat_cancel', { streamId }).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    await invoke('tauri_chat_stream', {
      streamId,
      body: serializedBody,
      onEvent: onChunk,
    });
  } catch (err) {
    if (signal?.aborted) {
      throw new DOMException('La requête a été annulée.', 'AbortError');
    }
    const error = new Error(typeof err === 'string' ? err : err?.message || 'L’assistant n’a pas pu répondre.');
    error.status = 502;
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  if (signal?.aborted) {
    throw new DOMException('La requête a été annulée.', 'AbortError');
  }
  if (streamError) {
    throw streamError;
  }
  if (buffer.trim()) {
    consume(buffer);
  }
}

export async function listConversations(signal) {
  const response = await fetch(apiUrl('/api/chat/conversations'), {
    signal,
    credentials: apiCredentials(),
    headers: { Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Conversations indisponibles.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function loadConversation(id, signal) {
  const response = await fetch(apiUrl(`/api/chat/conversations/${encodeURIComponent(id)}`), {
    signal,
    credentials: apiCredentials(),
    headers: { Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Conversation illisible.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function catalogHint(catalog, status) {
  const indexReady = status?.index === 'ready' || status?.index === 'stale';
  if (indexReady || !Array.isArray(catalog?.items) || catalog.items.length === 0 || catalog.items.length > 400) {
    return undefined;
  }
  return catalog.items
    .filter((item) => item && typeof item.path === 'string' && item.path && !item.path.includes('..'))
    .slice(0, 400)
    .map((item) => ({
      path: item.path,
      type: item.type === 'directory' ? 'directory' : 'file',
      size: Number(item.size) > 0 ? Number(item.size) : undefined,
      mtime: item.mtime || undefined,
    }));
}

function parseEvent(block) {
  let name = 'message';
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (data.length === 0) return null;
  try {
    return { event: name, data: JSON.parse(data.join('\n')) };
  } catch {
    return null;
  }
}
