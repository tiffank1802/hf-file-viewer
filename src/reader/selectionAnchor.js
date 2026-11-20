const MAX_SELECTION_CHARS = 2000;

export function canonicalReaderText(value = '') {
  return String(value)
    .replace(/\u00ad/g, '')
    .replace(/-\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('fr');
}

export function findSelectionBlock(blocks = [], quote = '') {
  const needle = canonicalReaderText(quote);
  if (!needle) return null;
  return blocks.find((block) => {
    const content = [block?.text, block?.markdown, block?.caption].filter(Boolean).join('\n');
    return canonicalReaderText(content).includes(needle);
  }) || null;
}

export function normalizedSelectionRects(clientRects, pageRect) {
  if (!pageRect || pageRect.width <= 0 || pageRect.height <= 0) return [];
  return Array.from(clientRects || [])
    .map((rect) => ({
      x: clamp((rect.left - pageRect.left) / pageRect.width),
      y: clamp((rect.top - pageRect.top) / pageRect.height),
      w: clamp(rect.width / pageRect.width),
      h: clamp(rect.height / pageRect.height),
    }))
    .filter((rect) => rect.w > 0 && rect.h > 0)
    .slice(0, 32);
}

export function buildSelectionAnchor({ quote, page, rects, pageText = '', blocks = [] }) {
  const exact = String(quote || '').replace(/\s+/g, ' ').trim();
  if (exact.length < 2 || Array.from(exact).length > MAX_SELECTION_CHARS) return null;
  const normalizedPage = String(pageText || '').replace(/\s+/g, ' ');
  const start = normalizedPage.indexOf(exact);
  const block = findSelectionBlock(blocks, exact);
  return {
    blockId: block?.id || '',
    quote: exact,
    prefix: start >= 0 ? normalizedPage.slice(Math.max(0, start - 120), start) : '',
    suffix: start >= 0 ? normalizedPage.slice(start + exact.length, start + exact.length + 120) : '',
    start: start >= 0 ? start : 0,
    end: start >= 0 ? start + exact.length : exact.length,
    page: Number(page) || 0,
    rects: (rects || []).slice(0, 32),
  };
}

export function buildStructuredSelectionAnchor({ quote, blockId, blockText = '', page = 0 }) {
  const exact = String(quote || '').replace(/\s+/g, ' ').trim();
  const id = String(blockId || '').trim();
  if (!id || exact.length < 2 || Array.from(exact).length > MAX_SELECTION_CHARS) return null;
  const normalizedBlock = String(blockText || '').replace(/\s+/g, ' ').trim();
  const start = normalizedBlock.indexOf(exact);
  if (start < 0) return null;
  return {
    blockId: id,
    quote: exact,
    prefix: normalizedBlock.slice(Math.max(0, start - 120), start),
    suffix: normalizedBlock.slice(start + exact.length, start + exact.length + 120),
    start,
    end: start + exact.length,
    page: Math.max(0, Number(page) || 0),
    rects: [],
  };
}

function clamp(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, Math.round(value * 10000) / 10000));
}
