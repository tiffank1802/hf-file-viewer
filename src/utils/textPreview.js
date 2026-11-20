export const INLINE_TEXT_LIMIT = 48 * 1024;

/** Read only enough text for the side pane, even if a proxy ignores Range. */
export async function readTextPreview(response, limit = INLINE_TEXT_LIMIT) {
  if (!response.ok || !response.body) throw new Error('Impossible de charger le texte.');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(limit);
  let filled = 0;
  let finished = false;
  let clipped = false;
  try {
    // Reading one chunk beyond an exact boundary distinguishes a document of
    // exactly `limit` bytes from a larger response without retaining that chunk.
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { finished = true; break; }
      const length = Math.min(limit - filled, value.byteLength);
      bytes.set(value.subarray(0, length), filled);
      filled += length;
      if (length < value.byteLength) { clipped = true; break; }
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const total = /(\d+)$/.exec(response.headers.get('Content-Range')?.split('/')[1] ?? '');
  const truncated = clipped || (total ? Number(total[1]) > filled : response.status === 206 && filled === limit);
  return { text: new TextDecoder().decode(bytes.subarray(0, filled), { stream: truncated }), truncated };
}
