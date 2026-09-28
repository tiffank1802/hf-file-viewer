import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  FiBookOpen,
  FiChevronLeft,
  FiColumns,
  FiMinus,
  FiPlus,
  FiSidebar,
  FiX,
} from 'react-icons/fi';
import { fileProxyUrl } from '../services/api';
import { fetchReaderDocument, fetchReaderPage } from '../services/reader';
import { normalizeBucketItem } from '../utils/files';
import PdfReader from './PdfReader';
import ReaderAssistant from './ReaderAssistant';
import {
  buildSelectionAnchor,
  normalizedSelectionRects,
} from './selectionAnchor';

const ACTIONS = [
  { label: 'Expliquer', intent: 'explain-selection', question: 'Explique clairement ce passage, son rôle dans la section et les prérequis nécessaires.' },
  { label: 'Simplifier', intent: 'explain-selection', question: 'Reformule ce passage simplement sans perdre les termes techniques importants.' },
  { label: 'Traduire', intent: 'translate-selection', question: 'Traduis ce passage en français s’il est dans une autre langue, sinon en anglais.' },
];

export default function DocumentWorkspace({ file, initialPage = 1, onClose }) {
  const documentFile = normalizeBucketItem(file || {});
  const [metadata, setMetadata] = useState(null);
  const [metadataError, setMetadataError] = useState('');
  const [page, setPage] = useState(Math.max(1, Number(initialPage) || 1));
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1.15);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [selection, setSelection] = useState(null);
  const [highlights, setHighlights] = useState([]);
  const pageBlocks = useRef(new Map());
  const pageRequests = useRef(new Map());
  const pdfRef = useRef(null);
  const assistantRef = useRef(null);

  useEffect(() => {
    document.body.classList.add('reader-open');
    return () => document.body.classList.remove('reader-open');
  }, []);

  useEffect(() => {
    if (!documentFile.path) return undefined;
    const controller = new AbortController();
    setMetadata(null);
    setMetadataError('');
    fetchReaderDocument(documentFile.path, '', controller.signal)
      .then((value) => {
        setMetadata(value);
        if (Number(value.pageCount) > 0) setPageCount(Number(value.pageCount));
      })
      .catch((error) => {
        if (error.name !== 'AbortError') setMetadataError(error.message);
      });
    return () => controller.abort();
  }, [documentFile.path]);

  useEffect(() => {
    const params = new URLSearchParams();
    params.set('path', documentFile.path);
    if (page > 1) params.set('page', String(page));
    window.history.replaceState({ reader: true }, '', `/read?${params}`);
  }, [documentFile.path, page]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (selection) setSelection(null);
      else onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, selection]);

  const changePage = useCallback((nextPage) => {
    const target = Math.min(Math.max(1, Number(nextPage) || 1), pageCount || Number.MAX_SAFE_INTEGER);
    setPage(target);
    pdfRef.current?.scrollToPage(target);
  }, [pageCount]);

  const onPdfDocument = useCallback((pdf) => {
    setPageCount(pdf.numPages);
  }, []);

  const onVisiblePage = useCallback((visiblePage) => {
    setPage((current) => (current === visiblePage ? current : visiblePage));
  }, []);

  const loadPageBlocks = useCallback(async (pageNumber) => {
    if (!metadata?.artifactId || metadata.status !== 'structured-ready') return [];
    if (pageBlocks.current.has(pageNumber)) return pageBlocks.current.get(pageNumber);
    if (pageRequests.current.has(pageNumber)) return pageRequests.current.get(pageNumber);
    const request = fetchReaderPage(documentFile.path, metadata.artifactId, pageNumber)
      .then((payload) => {
        const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
        pageBlocks.current.set(pageNumber, blocks);
        pageRequests.current.delete(pageNumber);
        return blocks;
      })
      .catch(() => {
        pageRequests.current.delete(pageNumber);
        return [];
      });
    pageRequests.current.set(pageNumber, request);
    return request;
  }, [documentFile.path, metadata]);

  const captureSelection = useCallback(async () => {
    const browserSelection = window.getSelection();
    if (!browserSelection || browserSelection.isCollapsed || browserSelection.rangeCount === 0) return;
    const range = browserSelection.getRangeAt(0);
    const node = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const pageElement = node?.closest?.('[data-reader-page]');
    if (!pageElement) return;
    const quote = browserSelection.toString().replace(/\s+/g, ' ').trim();
    if (quote.length < 2 || Array.from(quote).length > 2000) return;
    const pageNumber = Number(pageElement.dataset.readerPage);
    const pageRect = pageElement.getBoundingClientRect();
    const rects = normalizedSelectionRects(range.getClientRects(), pageRect);
    if (rects.length === 0) return;
    const blocks = await loadPageBlocks(pageNumber);
    const anchor = buildSelectionAnchor({
      quote,
      page: pageNumber,
      rects,
      pageText: pageElement.innerText || pageElement.textContent || '',
      blocks,
    });
    if (!anchor) return;
    const rangeRect = range.getBoundingClientRect();
    setSelection({
      anchor,
      position: {
        left: Math.min(window.innerWidth - 330, Math.max(12, rangeRect.left + rangeRect.width / 2 - 150)),
        top: Math.max(64, rangeRect.top - 52),
      },
    });
    setHighlights((current) => [
      ...current.filter((item) => item.kind !== 'selection'),
      { page: pageNumber, rects, blockId: anchor.blockId, kind: 'selection' },
    ]);
    setAssistantOpen(true);
  }, [loadPageBlocks]);

  const askSelection = useCallback((action) => {
    if (!selection?.anchor) return;
    assistantRef.current?.ask(action.question, action.intent, selection.anchor);
    setAssistantOpen(true);
  }, [selection]);

  const keepHighlight = useCallback(() => {
    if (!selection?.anchor) return;
    setHighlights((current) => current.map((item) => (
      item.kind === 'selection' ? { ...item, kind: 'saved' } : item
    )));
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }, [selection]);

  const openCitation = useCallback((citation) => {
    const targetPage = Number(citation?.page) || 1;
    setPage(targetPage);
    pdfRef.current?.scrollToPage(targetPage);
    const selected = highlights.find((item) => (
      item.page === targetPage
      && (!citation?.blockIds?.length || citation.blockIds.includes(item.blockId))
    ));
    const marker = selected || {
      page: targetPage,
      blockId: citation?.blockIds?.[0] || '',
      bbox: citation?.bbox || null,
    };
    setHighlights((current) => [
      ...current.filter((item) => item.kind !== 'citation'),
      { ...marker, kind: 'citation' },
    ]);
  }, [highlights]);

  const ready = metadata?.status === 'structured-ready';

  return (
    <div className={`document-workspace${sidebarOpen ? ' sidebar-open' : ''}${assistantOpen ? ' assistant-open' : ''}`}>
      <header className="reader-header">
        <button type="button" onClick={onClose} aria-label="Revenir à la bibliothèque"><FiChevronLeft aria-hidden="true" /></button>
        <div className="reader-title">
          <FiBookOpen aria-hidden="true" />
          <span><strong>{metadata?.title || documentFile.name}</strong><small>{documentFile.path}</small></span>
        </div>
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
          <button type="button" onClick={() => setZoom((value) => Math.max(0.7, value - 0.1))} aria-label="Réduire le zoom"><FiMinus /></button>
          <span>{Math.round(zoom * 100)} %</span>
          <button type="button" onClick={() => setZoom((value) => Math.min(2.2, value + 0.1))} aria-label="Augmenter le zoom"><FiPlus /></button>
        </div>
        <div className="reader-header-actions">
          <button type="button" className={sidebarOpen ? 'active' : ''} onClick={() => setSidebarOpen((value) => !value)} aria-label="Afficher le plan"><FiSidebar /></button>
          <button type="button" className={assistantOpen ? 'active' : ''} onClick={() => setAssistantOpen((value) => !value)} aria-label="Afficher l’assistant"><FiColumns /></button>
          <button type="button" onClick={onClose} aria-label="Fermer le lecteur"><FiX /></button>
        </div>
      </header>

      <div className="reader-body">
        {sidebarOpen && (
          <aside className="reader-sidebar" aria-label="Plan du document">
            <div className={`reader-docling-state ${ready ? 'ready' : 'fallback'}`}>
              <i />
              <span><strong>{ready ? 'Structure Docling prête' : 'Lecture originale'}</strong><small>{readerStatus(metadata, metadataError)}</small></span>
            </div>
            <nav>
              <h2>Plan du document</h2>
              {metadata?.outline?.length > 0 ? metadata.outline.map((item) => (
                <button
                  key={item.blockId}
                  type="button"
                  className={item.page === page ? 'current' : ''}
                  style={{ paddingLeft: `${12 + Math.min(item.level, 4) * 8}px` }}
                  onClick={() => changePage(item.page || 1)}
                >
                  <span>{item.label}</span>
                  {item.page > 0 && <small>{item.page}</small>}
                </button>
              )) : (
                <p>{metadataError || 'Le plan apparaîtra lorsque la structure sera disponible.'}</p>
              )}
            </nav>
          </aside>
        )}

        <main
          className="reader-document"
          onPointerUp={() => window.setTimeout(captureSelection, 0)}
          onKeyUp={(event) => {
            if (event.shiftKey) window.setTimeout(captureSelection, 0);
          }}
        >
          <PdfReader
            ref={pdfRef}
            url={fileProxyUrl(documentFile.path)}
            zoom={zoom}
            highlights={highlights}
            targetPage={Math.max(1, Number(initialPage) || 1)}
            onDocument={onPdfDocument}
            onPageChange={onVisiblePage}
          />
        </main>

        {assistantOpen && (
          <ReaderAssistant
            ref={assistantRef}
            document={{
              ...metadata,
              sourcePath: documentFile.path,
            }}
            selection={selection}
            onCitation={openCitation}
          />
        )}
      </div>

      {selection && (
        <div
          className="reader-selection-toolbar"
          style={{ left: selection.position.left, top: selection.position.top }}
          role="toolbar"
          aria-label="Actions sur la sélection"
        >
          {ACTIONS.map((action) => (
            <button key={action.label} type="button" disabled={!ready} onClick={() => askSelection(action)}>{action.label}</button>
          ))}
          <button type="button" onClick={keepHighlight}>Surligner</button>
          <button type="button" className="close" onClick={() => setSelection(null)} aria-label="Fermer"><FiX /></button>
        </div>
      )}
    </div>
  );
}

function readerStatus(metadata, error) {
  if (error) return error;
  switch (metadata?.status) {
    case 'structured-ready': return 'Sélection IA et citations vérifiables';
    case 'conversion-pending': return 'Conversion structurée en préparation';
    case 'artifact-failed': return 'Structure indisponible pour ce fichier';
    case 'artifact-oversized': return 'Document trop lourd pour la structure actuelle';
    default: return 'Vérification de la structure…';
  }
}
