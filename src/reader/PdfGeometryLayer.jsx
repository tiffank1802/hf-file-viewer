import { useRef, useState } from 'react';
import { buildGeometryAnchor, MAX_INK_POINTS } from './pdfGeometry';

export function PdfShape({ shape, points, color = 'yellow', preview = false }) {
  if (points.length < 2) return null;
  const [[x, y], [a, b]] = points;
  const attrs = { className: `reader-pdf-shape color-${color}${preview ? ' preview' : ''}`, vectorEffect: 'non-scaling-stroke' };
  return shape === 'rect'
    ? <rect {...attrs} x={Math.min(x, a)} y={Math.min(y, b)} width={Math.abs(x - a)} height={Math.abs(y - b)} />
    : <polyline {...attrs} points={points.map((point) => point.join(',')).join(' ')} />;
}

export function PdfGeometryInput({ mode, page, viewport, sourceRevision, onComplete }) {
  const stroke = useRef(null);
  const [draft, setDraft] = useState([]);
  const clamp = (value) => Math.max(0, Math.min(1, value));
  const pointFor = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return [clamp((event.clientX - bounds.left) / bounds.width), clamp((event.clientY - bounds.top) / bounds.height)];
  };
  return <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" className="reader-pdf-geometry-input" aria-hidden="true"
    onPointerDown={(event) => {
      if (!event.isPrimary || event.button !== 0 || stroke.current) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      stroke.current = { id: event.pointerId, points: [pointFor(event)] };
      setDraft(stroke.current.points);
    }}
    onPointerMove={(event) => {
      if (stroke.current?.id !== event.pointerId) return;
      const points = stroke.current.points;
      const next = pointFor(event);
      if (mode === 'rect') stroke.current.points = [points[0], next];
      else if (Math.hypot(next[0] - points.at(-1)[0], next[1] - points.at(-1)[1]) >= 0.003) {
        if (points.length >= MAX_INK_POINTS - 1) return;
        stroke.current.points = [...points, next];
      }
      setDraft(stroke.current.points);
    }}
    onPointerUp={(event) => {
      if (stroke.current?.id !== event.pointerId) return;
      const points = stroke.current.points;
      stroke.current = null;
      setDraft([]);
      const last = pointFor(event);
      const anchor = buildGeometryAnchor({ shape: mode, points: mode === 'rect' ? [points[0], last] : [...points, last], viewport, page, sourceRevision });
      if (anchor) onComplete(anchor);
    }}
    onLostPointerCapture={() => { stroke.current = null; setDraft([]); }}
  >
    <PdfShape shape={mode} points={draft.map(([x, y]) => [x * 1000, y * 1000])} preview />
  </svg>;
}
