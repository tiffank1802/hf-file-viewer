import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FiBookOpen, FiRefreshCw } from 'react-icons/fi';
import { fetchReaderBlock, fetchReaderBlocks } from '../../services/reader';
import BlockRenderer from './BlockRenderer';

const PAGE_SIZE = 40;

const StructuredReader = forwardRef(function StructuredReader({
  sourcePath,
  artifactId,
  annotations = [],
  highlightBlockId = '',
  onVisibleBlock,
}, ref) {
  const [blocks, setBlocks] = useState([]);
  const [nextFrom, setNextFrom] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const shellRef = useRef(null);
  const nextRef = useRef(0);
  const requestRef = useRef(null);

  const mergeBlocks = useCallback((incoming) => {
    setBlocks((current) => {
      const byID = new Map(current.map((block) => [block.id, block]));
      for (const block of incoming) {
        if (block?.id) byID.set(block.id, block);
      }
      return [...byID.values()].sort((left, right) => Number(left.ordinal) - Number(right.ordinal));
    });
  }, []);

  const loadWindow = useCallback(async (from, { advance = false, signal } = {}) => {
    if (!sourcePath || !artifactId) return null;
    const payload = await fetchReaderBlocks(sourcePath, artifactId, from, PAGE_SIZE, signal);
    const incoming = Array.isArray(payload.blocks) ? payload.blocks : [];
    mergeBlocks(incoming);
    setTotal(Number(payload.total) || 0);
    if (advance) {
      const value = Number(payload.nextFrom) || 0;
      nextRef.current = value;
      setNextFrom(value);
    }
    return payload;
  }, [artifactId, mergeBlocks, sourcePath]);

  useEffect(() => {
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    nextRef.current = 0;
    setBlocks([]);
    setNextFrom(0);
    setTotal(0);
    setError('');
    setLoading(true);
    loadWindow(1, { advance: true, signal: controller.signal })
      .catch((reason) => {
        if (reason.name !== 'AbortError') setError(reason.message || 'Lecture structurée indisponible.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt, loadWindow]);

  const scrollToElement = useCallback((element) => {
    if (!element) return false;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    window.setTimeout(() => element.focus({ preventScroll: true }), 350);
    return true;
  }, []);

  useImperativeHandle(ref, () => ({
    async scrollToBlock(blockId, ordinal = 0) {
      if (!blockId) return false;
      let element = document.getElementById(`reader-block-${blockId}`);
      if (element) return scrollToElement(element);
      try {
        const payload = await fetchReaderBlock(sourcePath, artifactId, blockId);
        mergeBlocks(Array.isArray(payload.blocks) ? payload.blocks : []);
        await nextPaint();
        element = document.getElementById(`reader-block-${blockId}`);
        if (element) return scrollToElement(element);
      } catch {
        // Compatibilité avec un backend plus ancien : repli ordinal/séquentiel.
      }
      if (Number(ordinal) > 0) {
        try {
          await loadWindow(Math.max(1, Number(ordinal) - 2));
          await nextPaint();
          element = document.getElementById(`reader-block-${blockId}`);
          if (element) return scrollToElement(element);
        } catch {
          return false;
        }
      }
      let cursor = nextRef.current;
      for (let step = 0; cursor > 0 && step < 12; step += 1) {
        try {
          const payload = await loadWindow(cursor, { advance: true });
          cursor = Number(payload?.nextFrom) || 0;
          await nextPaint();
          element = document.getElementById(`reader-block-${blockId}`);
          if (element) return scrollToElement(element);
        } catch {
          return false;
        }
      }
      return false;
    },
    async scrollToPage(page) {
      const target = Number(page);
      if (!(target > 0)) return false;
      let element = shellRef.current?.querySelector(`[data-reader-block][data-page="${target}"]`);
      let cursor = nextRef.current;
      for (let step = 0; !element && cursor > 0 && step < 12; step += 1) {
        try {
          const payload = await loadWindow(cursor, { advance: true });
          cursor = Number(payload?.nextFrom) || 0;
          await nextPaint();
          element = shellRef.current?.querySelector(`[data-reader-block][data-page="${target}"]`);
        } catch {
          return false;
        }
      }
      return scrollToElement(element);
    },
  }), [artifactId, loadWindow, mergeBlocks, scrollToElement, sourcePath]);

  useEffect(() => {
    const root = shellRef.current;
    if (!root || !onVisibleBlock || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      if (!visible) return;
      onVisibleBlock({
        blockId: visible.target.dataset.blockId || '',
        page: Number(visible.target.dataset.page) || 0,
        ordinal: Number(visible.target.dataset.ordinal) || 0,
      });
    }, { root, rootMargin: '-15% 0px -65% 0px', threshold: [0, 0.1, 0.5] });
    root.querySelectorAll('[data-reader-block]').forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [blocks, onVisibleBlock]);

  const byBlock = useMemo(() => {
    const result = new Map();
    for (const annotation of annotations) {
      const blockId = annotation.blockId || annotation.anchor?.blockId;
      if (blockId && !result.has(blockId)) result.set(blockId, annotation);
    }
    return result;
  }, [annotations]);

  const loadMore = async () => {
    if (!nextFrom || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      await loadWindow(nextFrom, { advance: true });
    } catch (reason) {
      setError(reason.message || 'Impossible de charger la suite du document.');
    } finally {
      setLoadingMore(false);
    }
  };

  if (loading) {
    return <div className="structured-reader-state"><span /><p>Construction de la lecture structurée…</p></div>;
  }
  if (error && blocks.length === 0) {
    return (
      <div className="structured-reader-state error">
        <FiBookOpen aria-hidden="true" />
        <strong>Lecture structurée indisponible</strong>
        <p>{error}</p>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          <FiRefreshCw aria-hidden="true" /> Réessayer
        </button>
      </div>
    );
  }

  return (
    <section ref={shellRef} className="structured-reader" aria-label="Lecture structurée du document">
      <div className="structured-document">
        {blocks.map((block) => (
          <BlockRenderer
            key={block.id}
            block={block}
            sourcePath={sourcePath}
            artifactId={artifactId}
            annotation={byBlock.get(block.id)}
            focused={highlightBlockId === block.id}
          />
        ))}
        {blocks.length === 0 && <p className="structured-empty-document">Aucun bloc lisible n’a été extrait.</p>}
        <footer className="structured-load-more">
          <small>{blocks.length} bloc{blocks.length > 1 ? 's' : ''}{total > 0 ? ` sur ${total}` : ''}</small>
          {nextFrom > 0 && (
            <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>
              <FiRefreshCw aria-hidden="true" /> {loadingMore ? 'Chargement…' : 'Charger la suite'}
            </button>
          )}
          {error && <p role="alert">{error}</p>}
        </footer>
      </div>
    </section>
  );
});

function nextPaint() {
  return new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
}

export default StructuredReader;
