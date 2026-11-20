export const PDF_RANGE_CHUNK_SIZE = 256 * 1024;

function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(value || '').trim());
  if (!match) return null;
  const [, first, last, size] = match.map(Number);
  if (![first, last, size].every(Number.isSafeInteger) || first < 0 || last < first || last >= size) return null;
  return { first, last, size };
}

async function readPDFResponse(response, expectedFirst, expectedEnd, expectedSize) {
  if (response.status !== 206) throw new Error('La lecture par plages du PDF a échoué. Rouvrez le document.');
  const range = parseContentRange(response.headers.get('Content-Range'));
  if (!range || range.first !== expectedFirst || (expectedEnd != null && range.last + 1 !== expectedEnd) ||
      (expectedSize != null && range.size !== expectedSize)) {
    throw new Error('Le stockage a renvoyé une plage PDF incohérente. Rouvrez le document.');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== range.last - range.first + 1) throw new Error('Une plage du PDF est incomplète.');
  return { range, bytes };
}

/**
 * Tauri's custom protocol returns a buffered response. Ask for a bounded first
 * range, then supply PDF.js with explicit ranges so a large PDF never requires
 * one huge gateway response. A non-range origin can still return a small 200.
 */
export async function createTauriPDFSource(url, { signal, onError, fetchImpl = fetch, chunkSize = PDF_RANGE_CHUNK_SIZE, RangeTransport } = {}) {
  const response = await fetchImpl(url, {
    headers: { Range: `bytes=0-${chunkSize - 1}` },
    credentials: 'omit',
    signal,
  });
  if (response.status === 200) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.byteLength) throw new Error('Le PDF est vide.');
    return { data: bytes };
  }
  const { range, bytes } = await readPDFResponse(response, 0, null, null);
  if (range.last + 1 !== Math.min(chunkSize, range.size)) throw new Error('La première plage du PDF est incohérente.');

  if (typeof RangeTransport !== 'function') throw new Error('Le transport PDF par plages est indisponible.');
  class TauriRangeTransport extends RangeTransport {
    constructor() {
      super(range.size, bytes, false);
      this.requests = new Set();
      this.closed = false;
    }

    requestDataRange(begin, end) {
      if (this.closed) return;
      const controller = new AbortController();
      this.requests.add(controller);
      void (async () => {
        if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > range.size) {
          throw new Error('La plage PDF demandée est invalide.');
        }
        // PDF.js may combine many chunks into one request. Split it again so
        // no single protocol response can exceed the native gateway's cap.
        const combined = new Uint8Array(end - begin);
        let next = begin;
        const worker = async () => {
          while (next < end && !this.closed) {
            const start = next;
            const stop = Math.min(end, start + chunkSize);
            next = stop;
            const response = await fetchImpl(url, {
              headers: { Range: `bytes=${start}-${stop - 1}` },
              credentials: 'omit',
              signal: controller.signal,
            });
            const { bytes: part } = await readPDFResponse(response, start, stop, range.size);
            combined.set(part, start - begin);
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, Math.ceil((end - begin) / chunkSize)) }, () => worker()));
        if (!this.closed) this.onDataRange(begin, combined);
      })().catch((error) => {
        if (!this.closed && error.name !== 'AbortError') {
          this.abort();
          onError?.(error);
        }
      }).finally(() => this.requests.delete(controller));
    }

    abort() {
      this.closed = true;
      for (const request of this.requests) request.abort();
      this.requests.clear();
    }
  }

  return { range: new TauriRangeTransport(), length: range.size, rangeChunkSize: chunkSize };
}
