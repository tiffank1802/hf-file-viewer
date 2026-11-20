import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  FiBookOpen,
  FiChevronLeft,
  FiColumns,
  FiEdit3,
  FiFileText,
  FiList,
  FiMinus,
  FiPlus,
  FiRefreshCw,
  FiSidebar,
  FiWifiOff,
  FiX,
} from 'react-icons/fi';
import { fetchPDFRevision, fetchReaderDocument, hashPDFBytes, pdfReaderUrl } from '../services/reader';
import { normalizeBucketItem } from '../utils/files';
import AnnotationComposer from './AnnotationComposer';
import AnnotationPanel from './AnnotationPanel';
import PdfReader from './PdfReader';
import ReaderAssistant from './ReaderAssistant';
import { emitReaderMetric, metricBucket, readerViewport } from './readerMetrics';
import StructuredReader from './structured/StructuredReader';
import { useReaderAnnotations } from './useReaderAnnotations';
import { usePdfTextIndex } from './usePdfTextIndex';
import { searchPDFIndex } from './pdfTextIndex';
import {
  buildPdfSelectionAnchor,
  buildStructuredSelectionAnchor,
  MAX_SELECTION_CHARS,
  MAX_SELECTION_PAGES,
  MAX_SELECTION_ZONES,
} from './selectionAnchor';

const ACTIONS = [
  { label: 'Expliquer', intent: 'explain-selection', question: 'Explique clairement ce passage, son rôle dans la section et les prérequis nécessaires.' },
  { label: 'Simplifier', intent: 'explain-selection', question: 'Reformule ce passage simplement sans perdre les termes techniques importants.' },
  { label: 'Traduire', intent: 'translate-selection', question: 'Traduis ce passage en français s’il est dans une autre langue, sinon en anglais.' },
];

export default function DocumentWorkspace({
  file,
  initialPage = 1,
  authenticated = false,
  onRequireAuth,
  onClose,
}) {
  const documentFile = normalizeBucketItem(file || {});
  const [metadata, setMetadata] = useState(null);
  const [metadataError, setMetadataError] = useState('');
  const [metadataAttempt, setMetadataAttempt] = useState(0);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const [mobile, setMobile] = useState(isMobileReader);
  const [page, setPage] = useState(Math.max(1, Number(initialPage) || 1));
  const [pdfTargetPage, setPdfTargetPage] = useState(Math.max(1, Number(initialPage) || 1));
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(() => (isMobileReader() ? 0.68 : 1.15));
  const [viewMode, setViewMode] = useState(documentFile.kind === 'pdf' ? 'pdf' : 'structured');
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobileReader());
  const [sidebarTab, setSidebarTab] = useState('outline');
  const [assistantOpen, setAssistantOpen] = useState(() => !isMobileReader());
  const [selection, setSelection] = useState(null);
  const [noteSelection, setNoteSelection] = useState(null);
  const [highlights, setHighlights] = useState([]);
  const [selectionError, setSelectionError] = useState('');
  const [pdfIdentity, setPdfIdentity] = useState({ strategy: '', revision: '', error: '' });
  const [pdfIdentityAttempt, setPdfIdentityAttempt] = useState(0);
  const [pdfDocument, setPdfDocument] = useState(null);
  const [pdfHash, setPdfHash] = useState('');
  const [pdfHashError, setPdfHashError] = useState('');
  const [pendingAsk, setPendingAsk] = useState(null);
  const captureSequence = useRef(0);
  const pdfRef = useRef(null);
  const structuredRef = useRef(null);
  const assistantRef = useRef(null);
  const selectionToolbarRef = useRef(null);
  const metadataStartedAt = useRef(0);
  const metadataErrorRef = useRef('');
  const structuredReady = metadata?.status === 'structured-ready';
  // A Docling response (including a stale capability flag) must never hide
  // the original PDF, whose availability is independent of that pipeline.
  const pdfAvailable = documentFile.kind === 'pdf' || Boolean(metadata?.capabilities?.pdf);
  const pdfMode = viewMode === 'pdf' && documentFile.kind === 'pdf';
  const pdfUrl = pdfReaderUrl(documentFile.path, pdfIdentity.revision);
  const currentPdf = pdfDocument?.url === pdfUrl ? pdfDocument.pdf : null;
  const pdfRevision = currentPdf
    ? (pdfIdentity.strategy === 'strong-etag' ? pdfIdentity.revision : pdfIdentity.strategy === 'sha256' ? pdfHash : '')
    : '';
  const ready = pdfMode ? Boolean(pdfRevision) : structuredReady;
  const pdfIndex = usePdfTextIndex(pdfMode ? currentPdf : null, pdfRevision);
  const annotations = useReaderAnnotations({
    sourcePath: documentFile.path,
    artifactId: metadata?.artifactId || '',
    sourceRevision: pdfRevision,
    pdfMode,
    ready,
    authenticated,
    onRequireAuth,
  });
  const activeAnnotations = useMemo(() => annotations.items
    .filter((item) => item.status === 'active' && (pdfMode
      ? item.sourceRevision === pdfRevision && !item.legacy
      : item.artifactId === metadata?.artifactId)), [annotations.items, metadata?.artifactId, pdfMode, pdfRevision]);
  const annotationHighlights = useMemo(() => activeAnnotations
    .map((item) => ({
      annotationId: item.id,
      page: Number(item.page || item.anchor?.page) || 1,
      blockId: item.blockId || item.anchor?.blockId || '',
      rects: item.anchor?.rects || [],
      segments: item.anchor?.segments || [],
      kind: 'annotation',
      color: item.color || 'yellow',
    })), [activeAnnotations]);
  const visibleHighlights = useMemo(
    () => [...annotationHighlights, ...highlights],
    [annotationHighlights, highlights],
  );
  const structuredHighlightBlock = useMemo(() => [...highlights]
    .reverse()
    .find((item) => (item.kind === 'selection' || item.kind === 'citation') && item.blockId)?.blockId || '', [highlights]);

  // A pending geometric capture must never complete against another PDF,
  // revision, viewport or mode. Old selections/composers are discarded when
  // the document identity changes; PDF-space highlights survive zoom changes.
  useEffect(() => {
    captureSequence.current += 1;
    setSelection(null);
    setNoteSelection(null);
    setPendingAsk(null);
    setHighlights([]);
    return () => { captureSequence.current += 1; };
  }, [documentFile.path, pdfRevision, viewMode]);
  useEffect(() => {
    if (!assistantOpen) setPendingAsk(null);
  }, [assistantOpen]);
  useEffect(() => {
    captureSequence.current += 1;
  }, [zoom]);

  useEffect(() => {
    document.body.classList.add('reader-open');
    emitReaderMetric('open', { kind: documentFile.kind, viewport: readerViewport() });
    return () => document.body.classList.remove('reader-open');
  }, [documentFile.kind]);

  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 760px)');
    const syncViewport = () => {
      const nextMobile = query?.matches ?? isMobileReader();
      setMobile(nextMobile);
      if (nextMobile) {
        setSidebarOpen(false);
        setAssistantOpen(false);
      }
    };
    const onOnline = () => {
      setOnline(true);
      if (metadataErrorRef.current) setMetadataAttempt((value) => value + 1);
      emitReaderMetric('network', { outcome: 'online' });
    };
    const onOffline = () => {
      setOnline(false);
      emitReaderMetric('network', { outcome: 'offline' });
    };
    query?.addEventListener?.('change', syncViewport);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      query?.removeEventListener?.('change', syncViewport);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    if (!documentFile.path || documentFile.kind !== 'pdf') return undefined;
    const controller = new AbortController();
    setPdfIdentity({ strategy: '', revision: '', error: '' });
    setPdfHash('');
    setPdfHashError('');
    fetchPDFRevision(documentFile.path, controller.signal)
      .then((identity) => {
        if (identity.strategy !== 'strong-etag' && identity.strategy !== 'sha256') throw new Error('Version du PDF indisponible.');
        setPdfIdentity({ ...identity, error: '' });
      })
      .catch((error) => {
        if (error.name !== 'AbortError') setPdfIdentity({ strategy: '', revision: '', error: error.message || 'Version du PDF indisponible.' });
      });
    return () => controller.abort();
  }, [documentFile.kind, documentFile.path, pdfIdentityAttempt]);

  useEffect(() => {
    if (!currentPdf || pdfIdentity.strategy !== 'sha256') return undefined;
    let active = true;
    setPdfHash('');
    setPdfHashError('');
    const maxBytes = Number(pdfIdentity.maxHashBytes) || 64 * 1024 * 1024;
    if (Number(pdfIdentity.size) > maxBytes) {
      setPdfHashError('Ce PDF dépasse la limite de 64 Mio sans ETag fort.');
      return () => { active = false; };
    }
    hashPDFBytes(currentPdf, maxBytes)
      .then((revision) => { if (active) setPdfHash(revision); })
      .catch((error) => { if (active) setPdfHashError(error.message || 'Empreinte PDF indisponible.'); });
    return () => { active = false; };
  }, [currentPdf, pdfIdentity]);

  useEffect(() => {
    if (!documentFile.path) return undefined;
    const controller = new AbortController();
    metadataStartedAt.current = performance.now();
    setMetadata(null);
    setMetadataError('');
    metadataErrorRef.current = '';
    fetchReaderDocument(documentFile.path, '', controller.signal)
      .then((value) => {
        setMetadata(value);
        if (documentFile.kind !== 'pdf' && !value.capabilities?.pdf) setViewMode('structured');
        if (documentFile.kind !== 'pdf' && Number(value.pageCount) > 0) setPageCount(Number(value.pageCount));
        emitReaderMetric('metadata', {
          kind: value.kind || documentFile.kind,
          status: value.status || 'unknown',
          outcome: 'success',
          pageCount: metricBucket(value.pageCount),
          blockCount: metricBucket(value.blockCount),
          durationMs: performance.now() - metadataStartedAt.current,
        });
      })
      .catch((error) => {
        if (error.name !== 'AbortError') {
          metadataErrorRef.current = error.message;
          setMetadataError(error.message);
          emitReaderMetric('metadata', {
            kind: documentFile.kind,
            outcome: 'error',
            durationMs: performance.now() - metadataStartedAt.current,
          });
        }
      });
    return () => controller.abort();
  }, [documentFile.kind, documentFile.path, metadataAttempt]);

  useEffect(() => {
    const params = new URLSearchParams();
    params.set('path', documentFile.path);
    if (page > 1) params.set('page', String(page));
    window.history.replaceState({ reader: true }, '', `/read?${params}`);
  }, [documentFile.path, page]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (noteSelection) setNoteSelection(null);
      else if (selection) {
        captureSequence.current += 1;
        setSelection(null);
        setHighlights((current) => current.filter((item) => item.kind !== 'selection'));
        window.getSelection()?.removeAllRanges();
      }
      else if (mobile && assistantOpen) setAssistantOpen(false);
      else if (mobile && sidebarOpen) setSidebarOpen(false);
      else onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [assistantOpen, mobile, noteSelection, onClose, selection, sidebarOpen]);

  useEffect(() => {
    if (selection?.focusToolbar) selectionToolbarRef.current?.querySelector('button:not([disabled])')?.focus();
  }, [selection]);

  const changePage = useCallback((nextPage) => {
    const target = Math.min(Math.max(1, Number(nextPage) || 1), pageCount || Number.MAX_SAFE_INTEGER);
    setPage(target);
    if (viewMode === 'structured') void structuredRef.current?.scrollToPage(target);
    else {
      setPdfTargetPage(target);
      pdfRef.current?.scrollToPage(target);
    }
  }, [pageCount, viewMode, setPage, setPdfTargetPage]);

  const onPdfDocument = useCallback((pdf, url) => {
    setPdfDocument({ pdf, url });
    setPageCount(pdf.numPages);
  }, [setPdfDocument, setPageCount]);

  const onPdfFirstPage = useCallback(({ durationMs }) => {
    emitReaderMetric('first-page', {
      kind: 'pdf',
      outcome: 'success',
      durationMs,
    });
  }, []);

  const onPdfError = useCallback(() => {
    // A failed or obsolete load must not leave the previous PDF marked ready.
    setPdfDocument(null);
    emitReaderMetric('pdf-error', { outcome: 'error' });
  }, [setPdfDocument]);

  const retryPDF = useCallback(() => {
    setPdfIdentityAttempt((value) => value + 1);
  }, [setPdfIdentityAttempt]);

  const onVisiblePage = useCallback((visiblePage) => {
    setPage((current) => (current === visiblePage ? current : visiblePage));
  }, [setPage]);

  const captureSelection = useCallback(async (focusToolbar = false) => {
    const sequence = ++captureSequence.current;
    const browserSelection = window.getSelection();
    if (!browserSelection || browserSelection.isCollapsed || browserSelection.rangeCount === 0) return;
    // Never leave actions for an older passage visible after a failed capture.
    setSelection(null);
    setHighlights((current) => current.filter((item) => item.kind !== 'selection'));
    const range = browserSelection.getRangeAt(0);
    const quote = browserSelection.toString().replace(/\s+/g, ' ').trim();
    if (quote.length < 2) return;
    if (Array.from(quote).length > MAX_SELECTION_CHARS) {
      setSelectionError('La sélection dépasse 2 000 caractères. Choisissez un passage plus court.');
      return;
    }
    setSelectionError('');
    const rangeRect = range.getBoundingClientRect();
    const position = {
      left: Math.max(12, Math.min(window.innerWidth - 330, rangeRect.left + rangeRect.width / 2 - 150)),
      top: Math.max(64, rangeRect.top - 52),
    };

    if (viewMode === 'structured') {
      const startElement = selectionElement(range.startContainer)?.closest?.('[data-reader-block]');
      const endElement = selectionElement(range.endContainer)?.closest?.('[data-reader-block]');
      if (!startElement || !endElement || startElement.dataset.blockId !== endElement.dataset.blockId) return;
      const anchor = buildStructuredSelectionAnchor({
        quote,
        blockId: startElement.dataset.blockId,
        blockText: startElement.innerText || startElement.textContent || '',
        page: Number(startElement.dataset.page) || 0,
      });
      if (!anchor) return;
      if (anchor.page > 0) setPage(anchor.page);
      setSelection({ anchor, position, focusToolbar });
      emitReaderMetric('selection', {
        mode: 'structured', outcome: 'anchored',
        selectionLength: metricBucket(Array.from(quote).length, [10, 50, 200, 500, 2000]),
      });
      setHighlights((current) => [
        ...current.filter((item) => item.kind !== 'selection'),
        { page: anchor.page, rects: [], blockId: anchor.blockId, kind: 'selection' },
      ]);
      if (!mobile) setAssistantOpen(true);
      return;
    }

    if (!pdfRevision) {
      setSelectionError('Vérification de la version du PDF en cours ou indisponible. Réessayez après son chargement.');
      return;
    }
    const startElement = selectionElement(range.startContainer)?.closest?.('.reader-pdf-text');
    const endElement = selectionElement(range.endContainer)?.closest?.('.reader-pdf-text');
    const firstPage = Number(startElement?.closest?.('[data-reader-page]')?.dataset.readerPage);
    const lastPage = Number(endElement?.closest?.('[data-reader-page]')?.dataset.readerPage);
    if (!startElement || !endElement || !firstPage || !lastPage || lastPage < firstPage) return;
    if (lastPage - firstPage + 1 > MAX_SELECTION_PAGES) {
      setSelectionError('Sélectionnez au maximum 8 pages à la fois.');
      return;
    }
    const segments = [];
    const quotes = [];
    const pageTexts = [];
    for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
      const pageElement = document.querySelector(`[data-reader-page="${pageNumber}"]`);
      const textLayer = pageElement?.querySelector('.reader-pdf-text');
      if (!pageElement || !textLayer) {
        setSelectionError('Toutes les pages sélectionnées doivent être chargées à l’écran.');
        return;
      }
      const pageRange = document.createRange();
      pageRange.selectNodeContents(textLayer);
      if (pageNumber === firstPage) pageRange.setStart(range.startContainer, range.startOffset);
      if (pageNumber === lastPage) pageRange.setEnd(range.endContainer, range.endOffset);
      const pageQuote = pageRange.toString().replace(/\s+/g, ' ').trim();
      if (!pageQuote) continue;
      const rects = [...pageRange.getClientRects()];
      const segment = await pdfRef.current?.selectionGeometry(pageNumber, rects, pageElement.getBoundingClientRect());
      if (sequence !== captureSequence.current) return;
      if (!segment?.quads?.length) {
        setSelectionError('Impossible de positionner cette sélection sur la page PDF.');
        return;
      }
      segments.push(segment);
      quotes.push(pageQuote);
      pageTexts.push(pdfIndex.pages.get(pageNumber) || textLayer.innerText || textLayer.textContent || '');
    }
    if (segments.reduce((count, item) => count + item.quads.length, 0) > MAX_SELECTION_ZONES) {
      setSelectionError('La sélection contient plus de 32 zones. Choisissez un passage plus court.');
      return;
    }
    const anchor = buildPdfSelectionAnchor({
      quote: quotes.join(' '), segments, sourceRevision: pdfRevision, pageText: pageTexts.join(' '),
    });
    if (!anchor) {
      setSelectionError('Cette sélection ne peut pas être ancrée. Choisissez un passage plus court.');
      return;
    }
    setSelection({ anchor, position, focusToolbar });
    emitReaderMetric('selection', {
      mode: 'pdf', outcome: 'geometric',
      selectionLength: metricBucket(Array.from(anchor.quote).length, [10, 50, 200, 500, 2000]),
    });
    setHighlights((current) => [
      ...current.filter((item) => item.kind !== 'selection'),
      { page: anchor.page, segments: anchor.segments, kind: 'selection' },
    ]);
    if (!mobile) setAssistantOpen(true);
  }, [mobile, pdfIndex.pages, pdfRevision, viewMode, setSelectionError, setPage, setSelection, setHighlights, setAssistantOpen]);

  const askSelection = useCallback((action) => {
    if (!selection?.anchor) return;
    if (assistantRef.current) assistantRef.current.ask(action.question, action.intent, selection.anchor);
    else setPendingAsk({ ...action, anchor: selection.anchor });
    emitReaderMetric('assistant', { action: action.intent, outcome: 'started' });
    if (mobile) setSidebarOpen(false);
    setAssistantOpen(true);
  }, [mobile, selection, setPendingAsk, setSidebarOpen, setAssistantOpen]);

  useEffect(() => {
    if (!assistantOpen || !pendingAsk) return undefined;
    // The mobile assistant has just mounted. Defer the request until after
    // React's effect setup/cleanup cycle, otherwise StrictMode can immediately
    // abort the request while replaying its unmount cleanup in development.
    const timer = window.setTimeout(() => {
      assistantRef.current?.ask(pendingAsk.question, pendingAsk.intent, pendingAsk.anchor);
      setPendingAsk(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [assistantOpen, pendingAsk, setPendingAsk]);

  const keepHighlight = useCallback(async () => {
    if (!selection?.anchor || !ready) return;
    const saved = await annotations.create({ anchor: selection.anchor, kind: 'highlight', color: 'yellow' });
    if (!saved) return;
    emitReaderMetric('annotation', { action: 'highlight', outcome: 'saved' });
    setHighlights((current) => current.filter((item) => item.kind !== 'selection'));
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    if (mobile) setAssistantOpen(false);
    setSidebarOpen(true);
    setSidebarTab('annotations');
  }, [annotations, mobile, ready, selection, setHighlights, setSelection, setAssistantOpen, setSidebarOpen, setSidebarTab]);

  const startNote = useCallback(() => {
    if (!selection?.anchor || !ready) return;
    if (!authenticated) {
      onRequireAuth?.();
      return;
    }
    setNoteSelection(selection);
  }, [authenticated, onRequireAuth, ready, selection, setNoteSelection]);

  const closeNote = useCallback(() => setNoteSelection(null), [setNoteSelection]);

  const saveNote = useCallback(async ({ body, color }) => {
    if (!noteSelection?.anchor) return;
    const saved = await annotations.create({
      anchor: noteSelection.anchor,
      kind: 'note',
      color,
      body,
    });
    if (!saved) return;
    emitReaderMetric('annotation', { action: 'note', outcome: 'saved' });
    setHighlights((current) => current.filter((item) => item.kind !== 'selection'));
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    setNoteSelection(null);
    if (mobile) setAssistantOpen(false);
    setSidebarOpen(true);
    setSidebarTab('annotations');
  }, [annotations, mobile, noteSelection, setHighlights, setSelection, setNoteSelection, setAssistantOpen, setSidebarOpen, setSidebarTab]);

  const openAnnotation = useCallback((annotation) => {
    if (annotation?.status !== 'active' || (pdfMode && (
      annotation?.legacy || annotation?.sourceRevision !== pdfRevision || annotation?.anchor?.schemaVersion !== 'pdf-anchor/v1'
    ))) {
      setSelectionError('Cette annotation non active ou issue d’une ancienne version doit être vérifiée avant de la positionner sur le document actuel.');
      return;
    }
    const targetPage = Number(annotation?.page || annotation?.anchor?.page) || 0;
    const blockId = annotation?.blockId || annotation?.anchor?.blockId || '';
    if (targetPage > 0) setPage(targetPage);
    if (viewMode === 'structured') void structuredRef.current?.scrollToBlock(blockId);
    else {
      setPdfTargetPage(targetPage || 1);
      pdfRef.current?.scrollToPage(targetPage || 1);
    }
    setHighlights((current) => [
      ...current.filter((item) => item.kind !== 'citation'),
      {
        page: targetPage,
        blockId,
        rects: annotation?.anchor?.rects || [],
        segments: annotation?.anchor?.segments || [],
        kind: 'citation',
      },
    ]);
  }, [pdfMode, pdfRevision, viewMode, setSelectionError, setPage, setPdfTargetPage, setHighlights]);

  const onStructuredVisible = useCallback((block) => {
    if (block.page > 0) setPage((current) => (current === block.page ? current : block.page));
  }, [setPage]);

  const openOutlineItem = useCallback((item) => {
    if (Number(item?.page) > 0) setPage(Number(item.page));
    if (viewMode === 'structured') void structuredRef.current?.scrollToBlock(item?.blockId, item?.ordinal);
    else changePage(item?.page || 1);
  }, [changePage, viewMode, setPage]);

  const openCitation = useCallback((citation) => {
    if (pdfMode && citation?.sourceRevision && citation.sourceRevision !== pdfRevision) {
      setSelectionError('Cette citation appartient à une autre version du PDF.');
      return;
    }
    emitReaderMetric('citation-open', { mode: viewMode, outcome: 'opened' });
    const targetPage = Number(citation?.page) || 0;
    const blockId = citation?.blockIds?.[0] || '';
    if (targetPage > 0) setPage(targetPage);
    if (viewMode === 'structured') void structuredRef.current?.scrollToBlock(blockId);
    else {
      setPdfTargetPage(targetPage || 1);
      pdfRef.current?.scrollToPage(targetPage || 1);
    }
    const selected = highlights.find((item) => (
      item.page === targetPage
      && (!citation?.blockIds?.length || citation.blockIds.includes(item.blockId))
    ));
    const marker = citation?.segments?.length ? { page: targetPage, segments: citation.segments } : (!pdfMode && selected) || {
      page: targetPage,
      blockId,
      bbox: citation?.bbox || null,
    };
    setHighlights((current) => [
      ...current.filter((item) => item.kind !== 'citation'),
      { ...marker, kind: 'citation' },
    ]);
  }, [highlights, pdfMode, pdfRevision, viewMode, setSelectionError, setPage, setPdfTargetPage, setHighlights]);

  const selectViewMode = useCallback((mode) => {
    if (mode === 'pdf') setPdfTargetPage(page);
    captureSequence.current += 1;
    setSelection(null);
    setHighlights([]);
    window.getSelection()?.removeAllRanges();
    setViewMode(mode);
    emitReaderMetric('mode-change', { mode, kind: documentFile.kind });
  }, [documentFile.kind, page, setPdfTargetPage, setSelection, setHighlights, setViewMode]);

  const toggleSidebar = useCallback(() => {
    const next = !sidebarOpen;
    setSidebarOpen(next);
    if (next && mobile) setAssistantOpen(false);
  }, [mobile, sidebarOpen, setSidebarOpen, setAssistantOpen]);

  const toggleAssistant = useCallback(() => {
    const next = !assistantOpen;
    setAssistantOpen(next);
    if (next && mobile) setSidebarOpen(false);
  }, [assistantOpen, mobile, setAssistantOpen, setSidebarOpen]);

  const onSidebarTabsKeyDown = useCallback((event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tab = event.key === 'ArrowRight' || event.key === 'End' ? 'annotations' : 'outline';
    setSidebarTab(tab);
    window.requestAnimationFrame(() => document.getElementById(`reader-${tab}-tab`)?.focus());
  }, [setSidebarTab]);

  const getPDFContext = useCallback((question) => searchPDFIndex(pdfIndex, question), [pdfIndex]);
  const retryMetadata = useCallback(() => setMetadataAttempt((value) => value + 1), [setMetadataAttempt]);
  const clearSelection = useCallback(() => {
    captureSequence.current += 1;
    setSelectionError('');
    setSelection(null);
    setHighlights((current) => current.filter((item) => item.kind !== 'selection'));
    window.getSelection()?.removeAllRanges();
  }, [setSelectionError, setSelection, setHighlights]);

  return (
    <div className={`document-workspace${sidebarOpen ? ' sidebar-open' : ''}${assistantOpen ? ' assistant-open' : ''}`}>
      <a className="skip-link reader-skip-link" href="#reader-document-content">Aller au document</a>
      {!online && (
        <div className="reader-network-status" role="status">
          <FiWifiOff aria-hidden="true" /> Hors connexion — la lecture déjà chargée reste disponible.
        </div>
      )}
      {(selectionError || (!noteSelection && annotations.error) || (pdfMode && (pdfIdentity.error || pdfHashError))) && (
        <div className="reader-notice" role="status">
          <span>{selectionError || (pdfMode && (pdfIdentity.error || pdfHashError)) || annotations.error}</span>
          {(pdfIdentity.error || pdfHashError) && <button type="button" onClick={retryPDF}>Réessayer</button>}
          {selectionError && <button type="button" aria-label="Fermer le message" onClick={() => setSelectionError('')}><FiX aria-hidden="true" /></button>}
        </div>
      )}
      <header className="reader-header">
        <button type="button" onClick={onClose} aria-label="Revenir à la bibliothèque"><FiChevronLeft aria-hidden="true" /></button>
        <div className="reader-title">
          <FiBookOpen aria-hidden="true" />
          <span><strong>{metadata?.title || documentFile.name}</strong><small>{documentFile.path}</small></span>
        </div>
        <div className="reader-center-controls">
          {pdfAvailable && structuredReady && (
            <div className="reader-mode-switch" role="group" aria-label="Mode de lecture">
              <button type="button" aria-pressed={viewMode === 'pdf'} className={viewMode === 'pdf' ? 'active' : ''} onClick={() => selectViewMode('pdf')}><FiBookOpen aria-hidden="true" /> PDF</button>
              <button type="button" aria-pressed={viewMode === 'structured'} className={viewMode === 'structured' ? 'active' : ''} onClick={() => selectViewMode('structured')}><FiFileText aria-hidden="true" /> Structuré</button>
            </div>
          )}
          {viewMode === 'pdf' ? (
            <div className="reader-page-controls">
              <label>
                <span className="sr-only">Page</span>
                <input
                  type="number"
                  min="1"
                  max={pageCount || undefined}
                  value={page}
                  onChange={(event) => changePage(event.target.value)}
                />
              </label>
              <span>/ {pageCount || '—'}</span>
              <button type="button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))} aria-label="Réduire le zoom"><FiMinus /></button>
              <span>{Math.round(zoom * 100)} %</span>
              <button type="button" onClick={() => setZoom((value) => Math.min(2.2, value + 0.1))} aria-label="Augmenter le zoom"><FiPlus /></button>
            </div>
          ) : (
            <span className="reader-structured-label"><FiFileText aria-hidden="true" /> Lecture accessible</span>
          )}
        </div>
        <div className="reader-header-actions">
          <button
            type="button"
            className={sidebarOpen ? 'active' : ''}
            onClick={toggleSidebar}
            aria-label={sidebarOpen ? 'Masquer le plan et les notes' : 'Afficher le plan et les notes'}
            aria-expanded={sidebarOpen}
            aria-controls="reader-sidebar-panel"
          ><FiSidebar aria-hidden="true" /></button>
          <button
            type="button"
            className={assistantOpen ? 'active' : ''}
            onClick={toggleAssistant}
            aria-label={assistantOpen ? 'Masquer l’assistant' : 'Afficher l’assistant'}
            aria-expanded={assistantOpen}
            aria-controls="reader-assistant-panel"
          ><FiColumns aria-hidden="true" /></button>
          <button type="button" onClick={onClose} aria-label="Fermer le lecteur"><FiX /></button>
        </div>
      </header>

      <div className="reader-body">
        {mobile && (sidebarOpen || assistantOpen) && (
          <button
            type="button"
            className="reader-panel-backdrop"
            tabIndex="-1"
            aria-hidden="true"
            onClick={() => {
              setSidebarOpen(false);
              setAssistantOpen(false);
            }}
          />
        )}
        {sidebarOpen && (
          <aside id="reader-sidebar-panel" className="reader-sidebar" aria-label="Plan et annotations du document">
            <button type="button" className="reader-panel-close" onClick={() => setSidebarOpen(false)} aria-label="Fermer le plan et les notes"><FiX aria-hidden="true" /></button>
            <div className={`reader-docling-state ${ready ? 'ready' : 'fallback'}`}>
              <i />
              <span><strong>{pdfMode ? 'PDF original' : (structuredReady ? 'Structure Docling prête' : 'Lecture originale')}</strong><small>{pdfMode ? (ready ? 'Sélection, notes et IA sur le PDF' : 'Vérification de la version du PDF…') : readerStatus(metadata, metadataError)}</small></span>
              {metadataError && !pdfMode && (
                <button type="button" onClick={retryMetadata} disabled={!online} aria-label="Réessayer de charger la structure">
                  <FiRefreshCw aria-hidden="true" />
                </button>
              )}
            </div>
            <div className="reader-sidebar-tabs" role="tablist" aria-label="Navigation du document" onKeyDown={onSidebarTabsKeyDown}>
              <button id="reader-outline-tab" type="button" role="tab" aria-controls="reader-outline-panel" aria-selected={sidebarTab === 'outline'} tabIndex={sidebarTab === 'outline' ? 0 : -1} className={sidebarTab === 'outline' ? 'active' : ''} onClick={() => setSidebarTab('outline')}><FiList aria-hidden="true" /> Plan</button>
              <button id="reader-annotations-tab" type="button" role="tab" aria-controls="reader-annotations-panel" aria-selected={sidebarTab === 'annotations'} tabIndex={sidebarTab === 'annotations' ? 0 : -1} className={sidebarTab === 'annotations' ? 'active' : ''} onClick={() => setSidebarTab('annotations')}><FiEdit3 aria-hidden="true" /> Notes <i>{annotations.items.length}</i></button>
            </div>
            {sidebarTab === 'outline' ? (
              <div id="reader-outline-panel" role="tabpanel" aria-labelledby="reader-outline-tab">
                <nav aria-label="Plan du document">
                  <h2>Plan du document</h2>
                {metadata?.outline?.length > 0 ? metadata.outline.map((item) => (
                  <button
                    key={item.blockId}
                    type="button"
                    className={item.page === page ? 'current' : ''}
                    aria-current={item.page === page ? 'location' : undefined}
                    style={{ paddingLeft: `${12 + Math.min(item.level, 4) * 8}px` }}
                    onClick={() => openOutlineItem(item)}
                  >
                    <span>{item.label}</span>
                    {item.page > 0 && <small>{item.page}</small>}
                  </button>
                )) : (
                  <p>{metadataError || 'Le plan apparaîtra lorsque la structure sera disponible.'}</p>
                )}
                </nav>
              </div>
            ) : (
              <div id="reader-annotations-panel" role="tabpanel" aria-labelledby="reader-annotations-tab">
                <AnnotationPanel
                  items={annotations.items}
                  authenticated={authenticated}
                  loading={annotations.loading}
                  saving={annotations.saving}
                  error={annotations.error}
                  onRequireAuth={onRequireAuth}
                  onOpen={openAnnotation}
                  onUpdate={annotations.update}
                  onDelete={annotations.remove}
                  onRetry={() => void annotations.reload()}
                />
              </div>
            )}
          </aside>
        )}

        <main
          id="reader-document-content"
          className="reader-document"
          tabIndex="-1"
          onPointerUp={() => window.setTimeout(() => void captureSelection(false), 0)}
          onKeyUp={(event) => {
            if (event.shiftKey) window.setTimeout(() => void captureSelection(true), 0);
          }}
        >
          {viewMode === 'pdf' && pdfAvailable ? (
            <PdfReader
              ref={pdfRef}
              url={pdfUrl}
              zoom={zoom}
              indexedPages={pdfIndex.pages}
              highlights={visibleHighlights}
              targetPage={pdfTargetPage}
              onDocument={onPdfDocument}
              onFirstPage={onPdfFirstPage}
              onPageChange={onVisiblePage}
              onError={onPdfError}
              onRetry={retryPDF}
            />
          ) : structuredReady && metadata?.artifactId ? (
            <StructuredReader
              ref={structuredRef}
              sourcePath={documentFile.path}
              artifactId={metadata.artifactId}
              annotations={activeAnnotations}
              highlightBlockId={structuredHighlightBlock}
              onVisibleBlock={onStructuredVisible}
            />
          ) : !metadata && !metadataError ? (
            <div className="structured-reader-state"><span /><p>Vérification de l’artefact Docling…</p></div>
          ) : (
            <div className="structured-reader-state error">
              <FiFileText aria-hidden="true" />
              <strong>Lecture structurée indisponible</strong>
              <p>{metadataError || readerStatus(metadata, metadataError)}</p>
              <span className="reader-recovery-actions">
                {metadataError && <button type="button" onClick={retryMetadata} disabled={!online}><FiRefreshCw aria-hidden="true" /> Réessayer</button>}
                <button type="button" onClick={onClose}>Revenir à la bibliothèque</button>
              </span>
            </div>
          )}
        </main>

        {assistantOpen && (
          <ReaderAssistant
            key={`${viewMode}:${pdfMode ? pdfRevision : metadata?.artifactId || ''}`}
            ref={assistantRef}
            document={{
              ...metadata,
              sourcePath: documentFile.path,
              pdfMode,
              sourceRevision: pdfRevision,
            }}
            pdfIndex={pdfIndex}
            getPDFContext={getPDFContext}
            selection={selection}
            onCitation={openCitation}
            onClose={() => setAssistantOpen(false)}
          />
        )}
      </div>

      {selection && (
        <div
          ref={selectionToolbarRef}
          className="reader-selection-toolbar"
          style={{ left: selection.position.left, top: selection.position.top }}
          role="toolbar"
          aria-orientation="horizontal"
          aria-label="Actions sur la sélection"
        >
          {ACTIONS.map((action) => (
            <button key={action.label} type="button" disabled={!ready} onClick={() => askSelection(action)}>{action.label}</button>
          ))}
          <button type="button" disabled={!ready || annotations.saving} onClick={() => void keepHighlight()}>Surligner</button>
          <button type="button" disabled={!ready || annotations.saving} onClick={startNote}>Ajouter une note</button>
          <button type="button" className="close" onClick={clearSelection} aria-label="Fermer les actions de sélection"><FiX aria-hidden="true" /></button>
        </div>
      )}
      {noteSelection && (
        <AnnotationComposer
          selection={noteSelection}
          saving={annotations.saving}
          error={annotations.error}
          onSave={saveNote}
          onClose={closeNote}
        />
      )}
    </div>
  );
}

function isMobileReader() {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(max-width: 760px)').matches);
}

function selectionElement(node) {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
}

function readerStatus(metadata, error) {
  if (error) return error;
  switch (metadata?.status) {
    case 'structured-ready': return 'Sélection IA et citations vérifiables';
    case 'conversion-pending': return 'Conversion structurée en préparation';
    case 'artifact-failed': return 'Structure indisponible pour ce fichier';
    case 'artifact-unavailable': return 'Service Docling temporairement indisponible';
    case 'artifact-oversized': return 'Document trop lourd pour la structure actuelle';
    default: return 'Vérification de la structure…';
  }
}
