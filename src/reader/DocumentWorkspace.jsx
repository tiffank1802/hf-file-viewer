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
  FiList,
  FiMinus,
  FiPlus,
  FiSidebar,
  FiX,
} from 'react-icons/fi';
import { fileProxyUrl } from '../services/api';
import { fetchReaderDocument, fetchReaderPage } from '../services/reader';
import { normalizeBucketItem } from '../utils/files';
import AnnotationComposer from './AnnotationComposer';
import AnnotationPanel from './AnnotationPanel';
import PdfReader from './PdfReader';
import ReaderAssistant from './ReaderAssistant';
import { useReaderAnnotations } from './useReaderAnnotations';
import {
  buildSelectionAnchor,
  normalizedSelectionRects,
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
  const [page, setPage] = useState(Math.max(1, Number(initialPage) || 1));
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1.15);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState('outline');
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [selection, setSelection] = useState(null);
  const [noteSelection, setNoteSelection] = useState(null);
  const [highlights, setHighlights] = useState([]);
  const pageBlocks = useRef(new Map());
  const pageRequests = useRef(new Map());
  const pdfRef = useRef(null);
  const assistantRef = useRef(null);
  const ready = metadata?.status === 'structured-ready';
  const annotations = useReaderAnnotations({
    sourcePath: documentFile.path,
    artifactId: metadata?.artifactId || '',
    ready,
    authenticated,
    onRequireAuth,
  });
  const annotationHighlights = useMemo(() => annotations.items
    .filter((item) => item.status === 'active' && item.artifactId === metadata?.artifactId)
    .map((item) => ({
      annotationId: item.id,
      page: Number(item.page || item.anchor?.page) || 1,
      blockId: item.blockId || item.anchor?.blockId || '',
      rects: item.anchor?.rects || [],
      kind: 'annotation',
      color: item.color || 'yellow',
    })), [annotations.items, metadata?.artifactId]);
  const visibleHighlights = useMemo(
    () => [...annotationHighlights, ...highlights],
    [annotationHighlights, highlights],
  );

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
      if (noteSelection) setNoteSelection(null);
      else if (selection) setSelection(null);
      else onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [noteSelection, onClose, selection]);

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

  const keepHighlight = useCallback(async () => {
    if (!selection?.anchor || !ready) return;
    const saved = await annotations.create({ anchor: selection.anchor, kind: 'highlight', color: 'yellow' });
    if (!saved) return;
    setHighlights((current) => current.filter((item) => item.kind !== 'selection'));
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    setSidebarOpen(true);
    setSidebarTab('annotations');
  }, [annotations, ready, selection]);

  const startNote = useCallback(() => {
    if (!selection?.anchor || !ready) return;
    if (!authenticated) {
      onRequireAuth?.();
      return;
    }
    setNoteSelection(selection);
  }, [authenticated, onRequireAuth, ready, selection]);

  const saveNote = useCallback(async ({ body, color }) => {
    if (!noteSelection?.anchor) return;
    const saved = await annotations.create({
      anchor: noteSelection.anchor,
      kind: 'note',
      color,
      body,
    });
    if (!saved) return;
    setHighlights((current) => current.filter((item) => item.kind !== 'selection'));
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    setNoteSelection(null);
    setSidebarOpen(true);
    setSidebarTab('annotations');
  }, [annotations, noteSelection]);

  const openAnnotation = useCallback((annotation) => {
    const targetPage = Number(annotation?.page || annotation?.anchor?.page) || 1;
    setPage(targetPage);
    pdfRef.current?.scrollToPage(targetPage);
    if (annotation?.status === 'needs-review') return;
    setHighlights((current) => [
      ...current.filter((item) => item.kind !== 'citation'),
      {
        page: targetPage,
        blockId: annotation?.blockId || annotation?.anchor?.blockId || '',
        rects: annotation?.anchor?.rects || [],
        kind: 'citation',
      },
    ]);
  }, []);

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
          <aside className="reader-sidebar" aria-label="Plan et annotations du document">
            <div className={`reader-docling-state ${ready ? 'ready' : 'fallback'}`}>
              <i />
              <span><strong>{ready ? 'Structure Docling prête' : 'Lecture originale'}</strong><small>{readerStatus(metadata, metadataError)}</small></span>
            </div>
            <div className="reader-sidebar-tabs" role="tablist" aria-label="Navigation du document">
              <button type="button" role="tab" aria-selected={sidebarTab === 'outline'} className={sidebarTab === 'outline' ? 'active' : ''} onClick={() => setSidebarTab('outline')}><FiList aria-hidden="true" /> Plan</button>
              <button type="button" role="tab" aria-selected={sidebarTab === 'annotations'} className={sidebarTab === 'annotations' ? 'active' : ''} onClick={() => setSidebarTab('annotations')}><FiEdit3 aria-hidden="true" /> Notes <i>{annotations.items.length}</i></button>
            </div>
            {sidebarTab === 'outline' ? (
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
            ) : (
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
              />
            )}
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
            highlights={visibleHighlights}
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
          <button type="button" disabled={!ready || annotations.saving} onClick={() => void keepHighlight()}>Surligner</button>
          <button type="button" disabled={!ready || annotations.saving} onClick={startNote}>Ajouter une note</button>
          <button type="button" className="close" onClick={() => setSelection(null)} aria-label="Fermer"><FiX /></button>
        </div>
      )}
      {noteSelection && (
        <AnnotationComposer
          selection={noteSelection}
          saving={annotations.saving}
          onSave={saveNote}
          onClose={() => setNoteSelection(null)}
        />
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
