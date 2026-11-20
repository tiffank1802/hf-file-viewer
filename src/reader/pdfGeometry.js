export const PDF_GEOMETRY_SCHEMA = 'pdf-geometry/v1';
export const MAX_INK_POINTS = 160;

export function buildGeometryAnchor({ shape, points, viewport, page, sourceRevision }) {
  if (!sourceRevision || !page || points.length < 2 || !viewport?.viewBox || !['rect', 'ink'].includes(shape)) return null;
  const pageView = [...viewport.viewBox];
  const pdfPoints = points.slice(0, MAX_INK_POINTS).map(([x, y]) => viewport.convertToPdfPoint(x * viewport.width, y * viewport.height)
    .map((n, index) => Math.max(pageView[index], Math.min(pageView[index + 2], Math.round(n * 1000) / 1000))));
  const first = pdfPoints[0];
  const distance = ([x, y]) => Math.hypot(x - first[0], y - first[1]);
  if (shape === 'rect' ? pdfPoints.length !== 2 || first.some((n, i) => Math.abs(n - pdfPoints[1][i]) < 0.01) : !pdfPoints.some((point) => distance(point) >= 0.01)) return null;
  return { schemaVersion: PDF_GEOMETRY_SCHEMA, page, sourceRevision, geometry: { shape, pageView, points: pdfPoints } };
}

export function geometryLabel(anchor) {
  if (anchor?.schemaVersion !== PDF_GEOMETRY_SCHEMA) return '';
  return anchor.geometry?.shape === 'ink' ? 'Tracé' : 'Zone';
}

export function exportPDFAnnotations(items, sourcePath, sourceRevision) {
  const annotations = items.map(({ anchor, body, color, createdAt, updatedAt, kind, page, status, sourceRevision: revision }) => ({
    anchor, body, color, createdAt, updatedAt, kind, page, status, sourceRevision: revision,
  }));
  const payload = { schemaVersion: 'enise-pdf-annotations/v1', sourcePath, sourceRevision, annotations };
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  link.href = url;
  link.download = `${sourcePath.split('/').at(-1).replace(/\.pdf$/i, '')}-annotations.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
