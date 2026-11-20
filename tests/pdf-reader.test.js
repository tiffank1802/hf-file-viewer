import test from 'node:test';
import assert from 'node:assert/strict';
import { getDocument, PDFDataRangeTransport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildPdfSelectionAnchor, normalizedQuadsForViewport, pdfQuadsFromClientRects } from '../src/reader/selectionAnchor.js';
import { indexPDFPages, pdfPageText, searchPDFIndex } from '../src/reader/pdfTextIndex.js';
import { createTauriPDFSource } from '../src/reader/tauriPdfRange.js';

// A real PDF.js PageViewport with a non-zero CropBox and default rotation.
function croppedPDF() {
  const stream = 'BT /F1 18 Tf 100 200 Td (Zoom test) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [40 60 572 732] /Rotate 90 /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let bytes = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(bytes));
    bytes += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(bytes);
  bytes += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) bytes += `${String(offset).padStart(10, '0')} 00000 n \n`;
  bytes += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(bytes));
}

function screenRect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function closeTo(actual, expected, tolerance = 0.0001) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should be close to ${expected}`);
}

test('les quadrilatères PDF.js survivent au zoom, à la rotation et à une CropBox décalée', async () => {
  const document = await getDocument({ data: croppedPDF(), useSystemFonts: true }).promise;
  const page = await document.getPage(1);
  assert.deepEqual(page.view, [40, 60, 572, 732]);
  assert.equal(page.rotate, 90);
  for (const rotation of [0, 90, 180, 270]) {
    const viewport = page.getViewport({ scale: 1.25, rotation });
    const pageRect = screenRect(31, 44, viewport.width, viewport.height);
    const selection = screenRect(pageRect.left + viewport.width * 0.2, pageRect.top + viewport.height * 0.3, viewport.width * 0.35, viewport.height * 0.05);
    const quads = pdfQuadsFromClientRects([selection], pageRect, viewport);
    assert.equal(quads.length, 1);
    const output = normalizedQuadsForViewport(quads, page.getViewport({ scale: 2.1, rotation }))[0];
    closeTo(output.x, 0.2);
    closeTo(output.y, 0.3);
    closeTo(output.w, 0.35);
    closeTo(output.h, 0.05);
    // Projecting into a different rotation and then converting back preserves
    // the same PDF-space region (independent of the viewport's origin).
    const rotated = page.getViewport({ scale: 0.8, rotation: (rotation + 90) % 360 });
    const rect = normalizedQuadsForViewport(quads, rotated)[0];
    const client = screenRect(rect.x * rotated.width, rect.y * rotated.height, rect.w * rotated.width, rect.h * rotated.height);
    const roundTrip = pdfQuadsFromClientRects([client], screenRect(0, 0, rotated.width, rotated.height), rotated)[0];
    const bounds = (quad) => [Math.min(quad[0], quad[2], quad[4], quad[6]), Math.min(quad[1], quad[3], quad[5], quad[7]), Math.max(quad[0], quad[2], quad[4], quad[6]), Math.max(quad[1], quad[3], quad[5], quad[7])];
    bounds(roundTrip).forEach((value, i) => closeTo(value, bounds(quads[0])[i], 0.003));
  }
  await document.destroy();
});

test('la sélection PDF est bornée et conserve les segments multipages ordonnés', () => {
  const revision = `etag-sha256:${'a'.repeat(64)}`;
  const segment = (page) => ({ page, pageView: [40, 60, 572, 732], quads: [[100, 200, 200, 200, 200, 220, 100, 220]] });
  const anchor = buildPdfSelectionAnchor({ quote: 'Un passage', segments: [segment(1), segment(2)], sourceRevision: revision });
  assert.equal(anchor.schemaVersion, 'pdf-anchor/v1');
  assert.equal(anchor.sourceRevision, revision);
  assert.equal(anchor.origin, 'pdf-text');
  assert.deepEqual(anchor.segments.map((item) => item.page), [1, 2]);
  assert.equal(buildPdfSelectionAnchor({ quote: 'x'.repeat(2001), segments: [segment(1)], sourceRevision: revision }), null);
  assert.equal(buildPdfSelectionAnchor({ quote: 'test', segments: Array.from({ length: 9 }, (_, i) => segment(i + 1)), sourceRevision: revision }), null);
  assert.equal(buildPdfSelectionAnchor({ quote: 'test', segments: [{ ...segment(1), quads: Array.from({ length: 33 }, () => segment(1).quads[0]) }], sourceRevision: revision }), null);
  assert.equal(buildPdfSelectionAnchor({ quote: 'test', segments: [segment(1)], sourceRevision: '' }), null);
});

test('indexation progressive : passages pertinents, scan, limites et annulation', async () => {
  assert.equal(pdfPageText({ items: [{ str: 'premier', hasEOL: true }, { str: 'second' }] }), 'premier\nsecond');
  const contents = ['L’énergie cinétique dépend de la vitesse.', '', 'La thermodynamique traite de la chaleur.'];
  const pdf = { numPages: contents.length, async getPage(page) { return { async getTextContent() { return { items: [{ str: contents[page - 1] }] }; } }; } };
  const progress = [];
  const index = await indexPDFPages(pdf, { onPage: (state) => progress.push(state.indexedPages) });
  assert.deepEqual(progress, [1, 2, 3]);
  assert.equal(index.complete, true);
  assert.equal(index.pages.get(2), '');
  const result = searchPDFIndex(index, 'Comment la chaleur intervient-elle ?');
  assert.equal(result.passages[0].page, 3);
  assert.equal(result.complete, true);
  assert.ok(result.passages.every((passage) => passage.origin === 'pdf-text' && passage.text.length <= 1800));
  const large = await indexPDFPages({ numPages: 1, async getPage() { return { async getTextContent() { return { items: [{ str: 'x'.repeat(50000) }] }; } }; } });
  assert.equal(large.truncated, true);
  assert.equal(large.complete, false);
  assert.equal(large.pages.get(1).length, 40000);
  const controller = new AbortController();
  const cancelled = await indexPDFPages(pdf, { signal: controller.signal, onPage: () => controller.abort() });
  assert.equal(cancelled.indexedPages, 1);
  assert.equal(cancelled.complete, false);
});

test('transport Tauri : PDF.js lit des plages bornées et refuse une plage incohérente', async () => {
  const bytes = croppedPDF();
  const ranges = [];
  const fetchImpl = async (_url, options) => {
    const value = options.headers.Range;
    ranges.push(value);
    assert.equal(options.credentials, 'omit');
    const match = /^bytes=(\d+)-(\d+)$/.exec(value);
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), bytes.length - 1);
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Type': 'application/pdf' },
    });
  };
  const source = await createTauriPDFSource('eniseapi://localhost/api/file?reader=1', { fetchImpl, chunkSize: 64, RangeTransport: PDFDataRangeTransport });
  const task = getDocument({ ...source, disableAutoFetch: true, disableStream: true, useSystemFonts: true });
  const pdf = await task.promise;
  assert.equal(pdf.numPages, 1);
  assert.deepEqual((await pdf.getPage(1)).view, [40, 60, 572, 732]);
  assert.equal(ranges[0], 'bytes=0-63');
  assert.ok(ranges.length > 1);
  assert.ok(ranges.every((value) => Number(value.split('-')[1]) - Number(value.match(/=(\d+)/)[1]) < 64));
  await task.destroy();

  const invalid = async () => new Response('bad', { status: 206, headers: { 'Content-Range': 'bytes 1-3/4' } });
  await assert.rejects(createTauriPDFSource('eniseapi://localhost/api/file', { fetchImpl: invalid, RangeTransport: PDFDataRangeTransport }), /incohérente/);
  const noRange = async () => new Response(bytes, { status: 200 });
  assert.deepEqual((await createTauriPDFSource('eniseapi://localhost/api/file', { fetchImpl: noRange })).data, bytes);
});
