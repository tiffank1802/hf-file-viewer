import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
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
  onPageChange,
  onError,
}, ref) {
  const [pdf, setPdf] = useState(null);
  const [error, setError] = useState('');
  const pageElements = useRef(new Map());

  useEffect(() => {
    if (!url) return undefined;
    const task = getDocument({ url, withCredentials: true });
    let active = true;
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
      task.destroy();
    };
  }, [url, onDocument, onError]);

  const scrollToPage = useCallback((page, behavior = 'smooth') => {
    const element = pageElements.current.get(Number(page));
    element?.scrollIntoView({ behavior, block: 'start' });
  }, []);
  const registerPage = useCallback((page, element) => {
    if (element) pageElements.current.set(page, element);
    else pageElements.current.delete(page);
  }, []);

  useImperativeHandle(ref, () => ({ scrollToPage }), [scrollToPage]);

  useEffect(() => {
    if (pdf && targetPage > 1) {
      window.setTimeout(() => scrollToPage(targetPage, 'auto'), 80);
    }
  }, [pdf, scrollToPage, targetPage]);

  if (error) {
    return (
      <div className="reader-pdf-error" role="alert">
        <strong>Le lecteur PDF interactif est indisponible.</strong>
        <p>{error}</p>
        <a href={url} target="_blank" rel="noreferrer">Ouvrir le PDF original</a>
      </div>
    );
  }
  if (!pdf) {
    return <div className="reader-pdf-loading"><span /><p>Préparation du document interactif…</p></div>;
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
            highlights={highlights.filter((item) => item.page === page)}
            register={registerPage}
            onVisible={onPageChange}
          />
        );
      })}
    </div>
  );
});

function PdfPage({ pdf, pageNumber, zoom, highlights, register, onVisible }) {
  const shellRef = useRef(null);
  const canvasRef = useRef(null);
  const textRef = useRef(null);
  const [visible, setVisible] = useState(pageNumber <= 2);
  const [size, setSize] = useState({ width: 700 * zoom, height: 990 * zoom });
  const [renderError, setRenderError] = useState('');

  useEffect(() => {
    const element = shellRef.current;
    register(pageNumber, element);
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return () => register(pageNumber, null);
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) setVisible(true);
        if (entry.intersectionRatio >= 0.45) onVisible?.(pageNumber);
      }
    }, { rootMargin: '900px 0px', threshold: [0, 0.45] });
    observer.observe(element);
    return () => {
      observer.disconnect();
      register(pageNumber, null);
    };
  }, [onVisible, pageNumber, register]);

  useEffect(() => {
    if (!visible) return undefined;
    let active = true;
    let renderTask;
    let textLayer;
    pdf.getPage(pageNumber).then(async (page) => {
      if (!active) return;
      const viewport = page.getViewport({ scale: zoom });
      setSize({ width: viewport.width, height: viewport.height });
      const canvas = canvasRef.current;
      const textContainer = textRef.current;
      if (!canvas || !textContainer) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext('2d', { alpha: false });
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
  }, [pdf, pageNumber, visible, zoom]);

  const positionedHighlights = highlights.flatMap((highlight, highlightIndex) => {
    const regions = highlight.rects?.length ? highlight.rects : (highlight.bbox ? [highlight.bbox] : []);
    return regions
      .map((region, rectIndex) => ({
        ...normalizedHighlightRect(region, size, zoom),
        key: `${highlightIndex}-${rectIndex}`,
        kind: highlight.kind || 'selection',
      }))
      .filter((region) => region.w > 0 && region.h > 0);
  });

  return (
    <section
      ref={shellRef}
      className="reader-pdf-page"
      data-reader-page={pageNumber}
      aria-label={`Page ${pageNumber}`}
      style={{ width: size.width, minHeight: size.height }}
    >
      {visible && <canvas ref={canvasRef} className="reader-pdf-canvas" />}
      {visible && <div ref={textRef} className="textLayer reader-pdf-text" />}
      <div className="reader-highlight-layer" aria-hidden="true">
        {positionedHighlights.map((region) => (
          <span
            key={region.key}
            className={`reader-highlight ${region.kind}`}
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
      {renderError && <p className="reader-page-error">{renderError}</p>}
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
