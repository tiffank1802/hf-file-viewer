export const MAX_SELECTION_CHARS = 2000;
export const MAX_SELECTION_ZONES = 32;
export const MAX_SELECTION_PAGES = 8;
export const PDF_ANCHOR_SCHEMA = 'pdf-anchor/v1';

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

/** Convert screen rectangles to the PDF page's unrotated user-space quads.
 * PDF.js PageViewport accounts for CropBox, rotation, zoom and axis direction.
 */
export function pdfQuadsFromClientRects(clientRects, pageRect, viewport) {
  if (!pageRect || !(pageRect.width > 0) || !(pageRect.height > 0) || !viewport?.convertToPdfPoint) return [];
  const clipped = Array.from(clientRects || []).map((rect) => {
    const left = Math.max(pageRect.left, rect.left);
    const top = Math.max(pageRect.top, rect.top);
    const right = Math.min(pageRect.right ?? pageRect.left + pageRect.width, rect.right ?? rect.left + rect.width);
    const bottom = Math.min(pageRect.bottom ?? pageRect.top + pageRect.height, rect.bottom ?? rect.top + rect.height);
    return { left, top, right, bottom };
  }).filter((rect) => rect.right - rect.left > 0.5 && rect.bottom - rect.top > 0.5);

  // PDF.js can return a rectangle per span. Merge adjacent rectangles on the
  // same line, but never bridge widely separated columns.
  clipped.sort((a, b) => a.top - b.top || a.left - b.left);
  const lines = [];
  for (const rect of clipped) {
    const last = lines.at(-1);
    const height = rect.bottom - rect.top;
    const overlap = last && Math.min(last.bottom, rect.bottom) - Math.max(last.top, rect.top);
    const gap = last ? rect.left - last.right : Infinity;
    if (last && overlap > Math.min(height, last.bottom - last.top) * 0.7 && gap <= Math.max(3, height * 0.35) && gap >= -height) {
      last.left = Math.min(last.left, rect.left);
      last.right = Math.max(last.right, rect.right);
      last.top = Math.min(last.top, rect.top);
      last.bottom = Math.max(last.bottom, rect.bottom);
    } else {
      lines.push({ ...rect });
    }
  }
  const convert = (x, y) => viewport.convertToPdfPoint(
    ((x - pageRect.left) / pageRect.width) * viewport.width,
    ((y - pageRect.top) / pageRect.height) * viewport.height,
  ).map((value) => Math.round(value * 1000) / 1000);
  return lines.map((rect) => [
    ...convert(rect.left, rect.top),
    ...convert(rect.right, rect.top),
    ...convert(rect.right, rect.bottom),
    ...convert(rect.left, rect.bottom),
  ]);
}

/** Project stored PDF-space quads into the current page viewport. */
export function normalizedQuadsForViewport(quads, viewport) {
  if (!viewport?.convertToViewportPoint || !(viewport.width > 0) || !(viewport.height > 0)) return [];
  return (quads || []).flatMap((quad) => {
    if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite)) return [];
    const points = [];
    for (let index = 0; index < 8; index += 2) points.push(viewport.convertToViewportPoint(quad[index], quad[index + 1]));
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    const left = Math.max(0, Math.min(...xs) / viewport.width);
    const top = Math.max(0, Math.min(...ys) / viewport.height);
    const right = Math.min(1, Math.max(...xs) / viewport.width);
    const bottom = Math.min(1, Math.max(...ys) / viewport.height);
    return right > left && bottom > top ? [{ x: left, y: top, w: right - left, h: bottom - top }] : [];
  });
}

export function buildPdfSelectionAnchor({ quote, segments = [], sourceRevision, pageText = '', origin = 'pdf-text' }) {
  const exact = String(quote || '').replace(/\s+/g, ' ').trim();
  const totalZones = segments.reduce((total, segment) => total + (segment?.quads?.length || 0), 0);
  if (exact.length < 2 || Array.from(exact).length > MAX_SELECTION_CHARS || !sourceRevision ||
      !segments.length || segments.length > MAX_SELECTION_PAGES || totalZones < 1 || totalZones > MAX_SELECTION_ZONES ||
      segments.some((segment) => !segment?.page || !Array.isArray(segment.pageView) || !segment.quads?.length)) return null;
  const normalizedPage = String(pageText || '').replace(/\s+/g, ' ');
  const start = normalizedPage.indexOf(exact);
  return {
    schemaVersion: PDF_ANCHOR_SCHEMA,
    sourceRevision,
    origin,
    page: segments[0].page,
    segments,
    quote: exact,
    prefix: start >= 0 ? normalizedPage.slice(Math.max(0, start - 120), start) : '',
    suffix: start >= 0 ? normalizedPage.slice(start + exact.length, start + exact.length + 120) : '',
    start: start >= 0 ? start : 0,
    end: start >= 0 ? start + exact.length : exact.length,
  };
}
