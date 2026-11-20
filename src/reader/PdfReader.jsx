import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FiRefreshCw } from 'react-icons/fi';
import { GlobalWorkerOptions, TextLayer, getDocument } from 'pdfjs-dist';
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';

GlobalWorkerOptions.workerSrc = workerSource;

const PdfReader = forwardRef(function PdfReader({
  url,
  zoom = 1.2,
  highlights = [],
  targetPage = 1,
  onDocument,
  onFirstPage,
  onPageChange,
  onError,
}, ref) {
  const [pdf, setPdf] = useState(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const pageElements = useRef(new Map());
  const openedAt = useRef(0);
  const firstPageReported = useRef(false);

  useEffect(() => {
    if (!url) return undefined;
    const task = getDocument({
      url,
      withCredentials: true,
      disableAutoFetch: true,
      disableStream: true,
      rangeChunkSize: 256 * 1024,
    });
    let active = true;
    openedAt.current = performance.now();
    firstPageReported.current = false;
    setPdf(null);
    setError('');
    task.promise
      .then((document) => {
        if (!active) return;
        setPdf(document);
        onDocument?.(document);
      })
      .catch((reason) => {
        if (!active) return;
        const message = reason?.message || 'Le PDF ne peut pas être chargé.';
        setError(message);
        onError?.(message);
      });
    return () => {
      active = false;
      void task.destroy();
    };
  }, [attempt, onDocument, onError, url]);

  const scrollToPage = useCallback((page, behavior = 'smooth') => {
    const element = pageElements.current.get(Number(page));
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    element?.scrollIntoView({ behavior: reduced ? 'auto' : behavior, block: 'start' });
  }, []);
  const registerPage = useCallback((page, element) => {
    if (element) pageElements.current.set(page, element);
    else pageElements.current.delete(page);
  }, []);
  const markFirstPage = useCallback((pageNumber) => {
    if (firstPageReported.current) return;
    firstPageReported.current = true;
    onFirstPage?.({
      page: pageNumber,
      durationMs: Math.max(0, Math.round(performance.now() - openedAt.current)),
    });
  }, [onFirstPage]);
  const highlightsByPage = useMemo(() => {
    const grouped = new Map();
    for (const item of highlights) {
      const pageNumber = Number(item.page);
      if (!(pageNumber > 0)) continue;
      if (!grouped.has(pageNumber)) grouped.set(pageNumber, []);
      grouped.get(pageNumber).push(item);
    }
    return grouped;
  }, [highlights]);

  useImperativeHandle(ref, () => ({ scrollToPage }), [scrollToPage]);

  useEffect(() => {
    if (!pdf || targetPage <= 1) return undefined;
    const timeout = window.setTimeout(() => scrollToPage(targetPage, 'auto'), 80);
    return () => window.clearTimeout(timeout);
  }, [pdf, scrollToPage, targetPage]);

  if (error) {
    return (
      <div className="reader-pdf-error" role="alert">
        <strong>Le lecteur PDF interactif est indisponible.</strong>
        <p>{error}</p>
        <span className="reader-recovery-actions">
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            <FiRefreshCw aria-hidden="true" /> Réessayer
          </button>
          <a href={url} target="_blank" rel="noreferrer">Ouvrir le PDF original</a>
        </span>
      </div>
    );
  }
  if (!pdf) {
    return <div className="reader-pdf-loading" role="status"><span /><p>Préparation du document interactif…</p></div>;
  }

  return (
    <div className="reader-pdf-pages" aria-label="Document PDF interactif">
      {Array.from({ length: pdf.numPages }, (_, index) => {
        const page = index + 1;
        return (
          <PdfPage
            key={page}
            pdf={pdf}
            pageNumber={page}
            zoom={zoom}
            highlights={highlightsByPage.get(page) || []}
            register={registerPage}
            onRendered={markFirstPage}
            onVisible={onPageChange}
          />
        );
      })}
    </div>
  );
});

function PdfPage({ pdf, pageNumber, zoom, highlights, register, onRendered, onVisible }) {
  const shellRef = useRef(null);
  const canvasRef = useRef(null);
  const textRef = useRef(null);
  const [nearViewport, setNearViewport] = useState(pageNumber <= 2);
  const [baseSize, setBaseSize] = useState({ width: 700, height: 990 });
  const [renderError, setRenderError] = useState('');
  const [renderAttempt, setRenderAttempt] = useState(0);
  const [rendered, setRendered] = useState(false);
  const size = useMemo(() => ({
    width: baseSize.width * zoom,
    height: baseSize.height * zoom,
  }), [baseSize, zoom]);

  useEffect(() => {
    const element = shellRef.current;
    register(pageNumber, element);
    if (!element || typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      onVisible?.(pageNumber);
      return () => register(pageNumber, null);
    }
    const root = element.closest('.reader-document');
    const renderObserver = new IntersectionObserver(([entry]) => {
      setNearViewport(entry.isIntersecting);
    }, { root, rootMargin: '1100px 0px', threshold: 0 });
    const currentObserver = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) onVisible?.(pageNumber);
    }, { root, rootMargin: '-42% 0px -42% 0px', threshold: 0 });
    renderObserver.observe(element);
    currentObserver.observe(element);
    return () => {
      renderObserver.disconnect();
      currentObserver.disconnect();
      register(pageNumber, null);
    };
  }, [onVisible, pageNumber, register]);

  useEffect(() => {
    if (!nearViewport) {
      setRendered(false);
      return undefined;
    }
    let active = true;
    let renderTask;
    let textLayer;
    setRenderError('');
    setRendered(false);
    pdf.getPage(pageNumber).then(async (page) => {
      if (!active) return;
      const viewport = page.getViewport({ scale: zoom });
      setBaseSize({ width: viewport.width / zoom, height: viewport.height / zoom });
      const canvas = canvasRef.current;
      const textContainer = textRef.current;
      if (!canvas || !textContainer) return;
      const ratio = Math.min(window.devicePixelRatio || 1, window.innerWidth <= 760 ? 1.5 : 2);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Canvas indisponible.');
      renderTask = page.render({
        canvasContext: context,
        viewport,
        transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
      });
      textContainer.replaceChildren();
      textContainer.style.width = `${viewport.width}px`;
      textContainer.style.height = `${viewport.height}px`;
      textLayer = new TextLayer({
        textContentSource: page.streamTextContent({ includeMarkedContent: true }),
        container: textContainer,
        viewport,
      });
      await Promise.all([renderTask.promise, textLayer.render()]);
      if (active) {
        setRendered(true);
        onRendered?.(pageNumber);
      }
    }).catch((reason) => {
      if (active && reason?.name !== 'RenderingCancelledException') {
        setRenderError(reason?.message || 'Page illisible.');
      }
    });
    return () => {
      active = false;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [nearViewport, onRendered, pageNumber, pdf, renderAttempt, zoom]);

  const positionedHighlights = highlights.flatMap((highlight, highlightIndex) => {
    const regions = highlight.rects?.length ? highlight.rects : (highlight.bbox ? [highlight.bbox] : []);
    return regions
      .map((region, rectIndex) => ({
        ...normalizedHighlightRect(region, size, zoom),
        key: `${highlightIndex}-${rectIndex}`,
        kind: highlight.kind || 'selection',
        color: highlight.color || '',
      }))
      .filter((region) => region.w > 0 && region.h > 0);
  });

  return (
    <section
      ref={shellRef}
      className="reader-pdf-page"
      data-reader-page={pageNumber}
      aria-label={`Page ${pageNumber}`}
      aria-busy={nearViewport && !rendered && !renderError}
      style={{ width: size.width, minHeight: size.height }}
    >
      {nearViewport && <canvas ref={canvasRef} className="reader-pdf-canvas" aria-hidden="true" />}
      {nearViewport && <div ref={textRef} className="textLayer reader-pdf-text" />}
      <div className="reader-highlight-layer" aria-hidden="true">
        {positionedHighlights.map((region) => (
          <span
            key={region.key}
            className={`reader-highlight ${region.kind}${region.color ? ` color-${region.color}` : ''}`}
            style={{
              left: `${region.x * 100}%`,
              top: `${region.y * 100}%`,
              width: `${region.w * 100}%`,
              height: `${region.h * 100}%`,
            }}
          />
        ))}
        {highlights.some((highlight) => highlight.kind === 'citation') && positionedHighlights.length === 0 && (
          <span className="reader-highlight-page citation" />
        )}
      </div>
      <span className="reader-page-number">{pageNumber}</span>
      {renderError && (
        <p className="reader-page-error" role="alert">
          <span>{renderError}</span>
          <button type="button" onClick={() => setRenderAttempt((value) => value + 1)}>Réessayer</button>
        </p>
      )}
    </section>
  );
}

function normalizedHighlightRect(region = {}, pageSize = {}, zoom = 1) {
  if ([region.x, region.y, region.w, region.h].every(Number.isFinite)) {
    return clampRect(region.x, region.y, region.w, region.h);
  }
  const l = Number(region.l);
  const t = Number(region.t);
  const r = Number(region.r);
  const b = Number(region.b);
  if (![l, t, r, b].every(Number.isFinite)) return { x: 0, y: 0, w: 0, h: 0 };
  const scale = Number(zoom) > 0 ? Number(zoom) : 1;
  const pageWidth = Number(pageSize.width) / scale;
  const pageHeight = Number(pageSize.height) / scale;
  if (!(pageWidth > 0) || !(pageHeight > 0)) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(l, r) / pageWidth;
  const width = Math.abs(r - l) / pageWidth;
  const top = Math.min(t, b);
  const height = Math.abs(t - b) / pageHeight;
  const bottomOrigin = String(region.origin || region.coord_origin || '').toLowerCase().includes('bottom');
  const y = bottomOrigin ? (pageHeight - Math.max(t, b)) / pageHeight : top / pageHeight;
  return clampRect(x, y, width, height);
}

function clampRect(x, y, w, h) {
  const left = Math.max(0, Math.min(1, Number(x) || 0));
  const top = Math.max(0, Math.min(1, Number(y) || 0));
  return {
    x: left,
    y: top,
    w: Math.max(0, Math.min(1 - left, Number(w) || 0)),
    h: Math.max(0, Math.min(1 - top, Number(h) || 0)),
  };
}

export default PdfReader;
