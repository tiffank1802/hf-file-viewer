export async function fetchChatStatus(signal) {
  const response = await fetch('/api/chat/status', {
    signal,
    credentials: 'same-origin',
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

export async function streamChat({ message, history, contextPath, conversationId, catalog, signal, onEvent }) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    signal,
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, history, contextPath, conversationId, catalog }),
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

export async function listConversations(signal) {
  const response = await fetch('/api/chat/conversations', {
    signal,
    credentials: 'same-origin',
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
  const response = await fetch(`/api/chat/conversations/${encodeURIComponent(id)}`, {
    signal,
    credentials: 'same-origin',
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
