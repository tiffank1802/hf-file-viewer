import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { FiArrowUp, FiLoader, FiMessageCircle, FiRefreshCw, FiX } from 'react-icons/fi';
import CitationLink from '../components/CitationLink';
import { streamChat } from '../services/chat';
import { emitReaderMetric } from './readerMetrics';

const ReaderAssistant = forwardRef(function ReaderAssistant({
  document,
  selection,
  pdfIndex,
  getPDFContext,
  onCitation,
  onClose,
  onShowNotes,
  open = true,
  currentPage,
}, ref) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState(null);
  const [coverage, setCoverage] = useState(null);
  const [announcement, setAnnouncement] = useState('');
  const [presetIntent, setPresetIntent] = useState('');
  const [scopeChoice, setScopeChoice] = useState('');
  const [attachedAnchor, setAttachedAnchor] = useState(null);
  const [following, setFollowing] = useState(true);
  const logRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const idRef = useRef(0);
  const pdfMode = Boolean(document?.pdfMode);
  const ready = pdfMode ? Boolean(document?.sourceRevision) : document?.status === 'structured-ready';

  const anchorForComposer = selection?.anchor || attachedAnchor;
  const composerScope = scopeChoice === 'selection' && !anchorForComposer ? 'document' : scopeChoice || (anchorForComposer ? 'selection' : 'document');

  const ask = useCallback(async (question, intent = 'explain-selection', anchor, requestedPage) => {
    const text = String(question || '').trim();
    if (!text || busy || abortRef.current || !ready || !document?.sourcePath) return;
    const startedAt = performance.now();
    setFollowing(true);
    setCoverage(null);
    setScope(null);
    const sentScope = anchor ? selectionLabel(anchor) : requestedPage ? `Page ${requestedPage}` : 'Document';
    setAnnouncement('Recherche des preuves dans le document.');
    idRef.current += 1;
    const userID = `reader-user-${idRef.current}`;
    idRef.current += 1;
    const assistantID = `reader-assistant-${idRef.current}`;
    const history = pdfMode ? [] : messages
      .filter((message) => message.text && !message.pending)
      .slice(-6)
      .map((message) => ({ role: message.role, content: message.text }));
    setMessages((current) => [
      ...current,
      { id: userID, role: 'user', text, selection: anchor?.quote || '', sentScope },
      { id: assistantID, role: 'assistant', text: '', pending: true, citations: [] },
    ]);
    setInput('');
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const patch = (recipe) => {
      setMessages((current) => current.map((message) => (
        message.id === assistantID ? recipe(message) : message
      )));
    };
    try {
      const pdfContext = pdfMode && !anchor ? await getPDFContext?.(text, requestedPage) : undefined;
      if (controller.signal.aborted) return;
      await streamChat({
        message: text,
        intent,
        scope: {
          type: 'document',
          sourcePath: document.sourcePath,
          artifactId: pdfMode ? undefined : document.artifactId || undefined,
          sourceRevision: pdfMode ? document.sourceRevision : undefined,
          pdfContext,
          page: pdfMode && !anchor ? requestedPage : undefined,
          anchor: anchor ? (pdfMode ? { ...anchor, prefix: undefined, suffix: undefined } : anchor) : undefined,
        },
        history,
        contextPath: document.sourcePath.split('/').slice(0, -1).join('/'),
        signal: controller.signal,
        onEvent: ({ event, data }) => {
          if (controller.signal.aborted) return;
          if (event === 'scope') {
            setScope(data);
            patch((message) => ({ ...message, scope: data }));
          }
          if (event === 'citations') {
            if (data.coverage) setCoverage(data.coverage);
            patch((message) => ({ ...message, citations: data.citations || [], coverage: data.coverage }));
          }
          if (event === 'thinking') patch((message) => ({ ...message, thinking: true }));
          if (event === 'delta') {
            patch((message) => ({ ...message, text: `${message.text}${data.text || ''}`, thinking: false }));
          }
          if (event === 'done') {
            if (data.scope) setScope(data.scope);
            if (data.coverage) setCoverage(data.coverage);
            setAnnouncement('La réponse de l’assistant est prête.');
            emitReaderMetric('assistant', {
              action: intent,
              outcome: 'success',
              durationMs: performance.now() - startedAt,
            });
            patch((message) => ({
              ...message,
              text: data.answer || message.text,
              citations: data.citations || message.citations || [],
              coverage: data.coverage || message.coverage,
              pending: false,
              thinking: false,
              error: false,
            }));
          }
          if (event === 'error') {
            setAnnouncement('La réponse a échoué. Vous pouvez réessayer.');
            emitReaderMetric('assistant', {
              action: intent,
              outcome: 'error',
              durationMs: performance.now() - startedAt,
            });
            patch((message) => ({
              ...message,
              text: data.error || 'L’assistant n’a pas pu répondre.',
              pending: false,
              thinking: false,
              error: true,
              retry: { question: text, intent, anchor, requestedPage },
            }));
          }
        },
      });
      patch((message) => (message.pending ? { ...message, pending: false } : message));
    } catch (error) {
      if (error.name === 'AbortError') {
        setAnnouncement('Demande annulée.');
        patch((message) => ({ ...message, text: message.text || 'Demande annulée.', pending: false, thinking: false }));
      } else {
        setAnnouncement('La réponse a échoué. Vous pouvez réessayer.');
        emitReaderMetric('assistant', {
          action: intent,
          outcome: 'error',
          durationMs: performance.now() - startedAt,
        });
        patch((message) => ({
          ...message,
          text: error.message || 'L’assistant n’a pas pu répondre.',
          pending: false,
          thinking: false,
          error: true,
          retry: { question: text, intent, anchor, requestedPage },
        }));
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  }, [busy, document, getPDFContext, messages, pdfMode, ready]);

  useImperativeHandle(ref, () => ({
    ask,
    focusSelection(anchor, action) {
      setAttachedAnchor(anchor);
      setScopeChoice('selection');
      setInput(action?.question || '');
      setPresetIntent(action?.intent || '');
      inputRef.current?.focus({ preventScroll: true });
    },
  }), [ask]);

  useLayoutEffect(() => {
    if (open && following && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [following, messages, open]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <aside id="reader-assistant-panel" className="reader-assistant" hidden={!open} aria-label="Assistant du document">
      <header className="reader-assistant-head">
        <div><FiMessageCircle aria-hidden="true" /></div>
        <span>
          <strong>Assistant du document</strong>
          <small>{scopeLabel(scope, ready, pdfMode)}</small>
        </span>
        <button type="button" className="reader-dock-tab" onClick={onShowNotes}>Notes</button>
        <button type="button" className="reader-panel-close" onClick={onClose} aria-label="Fermer l’assistant">
          <FiX aria-hidden="true" />
        </button>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
      </header>
      <div className="reader-assistant-context">
        <label>Périmètre de la question
          <select value={composerScope} onChange={(event) => setScopeChoice(event.target.value)}>
            <option value="document">Document</option>
            {pdfMode && <option value="page">Page {currentPage || 1}</option>}
            {anchorForComposer && <option value="selection">Sélection</option>}
          </select>
        </label>
        {composerScope === 'selection' && anchorForComposer?.quote && <div className="reader-selection-card">
          <span>{selectionLabel(anchorForComposer)}</span>
          <blockquote>{anchorForComposer.quote}</blockquote>
        </div>}
      </div>
      <div className="reader-assistant-log" ref={logRef} onScroll={(event) => {
        const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
        setFollowing(scrollHeight - scrollTop - clientHeight < 48);
      }}>
        {pdfMode && (
          <p className="reader-assistant-disclosure">
            {pdfIndex?.totalPages > 0 ? `Index local : ${pdfIndex.indexedPages}/${pdfIndex.totalPages} pages${pdfIndex.complete ? '' : ' (incomplet)'}. ` : ''}
            La question et les extraits retenus sont transmis au service IA lors de l’envoi. Les extraits issus de PDF.js ne sont pas vérifiés par le serveur.
            {coverage && coverage.kind !== 'whole-document' && ' Les passages fournis ne constituent pas une lecture exhaustive.'}
            {pdfIndex?.error && ` ${pdfIndex.error}`}
          </p>
        )}
        {messages.length === 0 && (
          <div className="reader-assistant-empty">
            <strong>{ready ? 'Posez votre question' : 'Assistant indisponible'}</strong>
            <p>{pdfMode
              ? (ready ? 'Sélectionnez un passage dans le PDF ou posez une question sur les pages indexées.' : 'La version du PDF doit être vérifiée avant l’envoi.')
              : (ready ? 'Demandez une explication ancrée dans les sections et pages structurées.' : 'La structure de ce document doit être disponible avant l’envoi.')}</p>
          </div>
        )}
        {messages.map((message) => (
          <article key={message.id} className={`reader-message ${message.role}${message.error ? ' error' : ''}`}>
            {message.sentScope && <small>{message.sentScope}{message.selection && ` · « ${clip(message.selection, 100)} »`}</small>}
            {message.text ? (
              <ReaderAnswer
                text={message.text}
                citations={message.citations}
                onCitation={onCitation}
              />
            ) : message.pending ? (
              <span className="reader-thinking"><FiLoader aria-hidden="true" /> {message.thinking ? 'Le modèle réfléchit…' : 'Recherche des preuves…'}</span>
            ) : null}
            {pdfMode && message.coverage?.selectedChunks > 0 && (
              <small className="reader-citation-coverage">{message.coverage.selectedChunks} extrait{message.coverage.selectedChunks > 1 ? 's' : ''} utilisé{message.coverage.selectedChunks > 1 ? 's' : ''} · couverture non exhaustive</small>
            )}
            {message.citations?.length > 0 && (
              <div className="reader-answer-citations">
                {message.citations.map((citation) => (
                  <CitationLink key={citation.citationId} citation={citation} onOpen={onCitation} />
                ))}
              </div>
            )}
            {message.retry && (
              <button
                type="button"
                className="reader-assistant-retry"
                disabled={busy}
                onClick={() => void ask(message.retry.question, message.retry.intent, message.retry.anchor, message.retry.requestedPage)}
              >
                <FiRefreshCw aria-hidden="true" /> Réessayer
              </button>
            )}
          </article>
        ))}
      </div>
      <div className="reader-assistant-compose">
        {!following && <button type="button" className="reader-assistant-retry reader-jump-latest" onClick={() => setFollowing(true)}>Derniers messages</button>}
        <form
          className="reader-assistant-form"
          onSubmit={(event) => {
            event.preventDefault();
            void ask(input, composerScope === 'selection' ? presetIntent || 'explain-selection' : 'explain',
              composerScope === 'selection' ? anchorForComposer : undefined, composerScope === 'page' ? currentPage : undefined);
          }}
        >
          <textarea
            ref={inputRef}
            rows={2}
            maxLength={2000}
            aria-label="Question à l’assistant du document"
            value={input}
            disabled={!ready}
            placeholder={!ready ? (pdfMode ? 'Vérification du PDF…' : 'Structure requise') : (composerScope === 'selection' ? 'Posez une question sur la sélection…' : composerScope === 'page' ? 'Posez une question sur cette page…' : 'Posez une question sur ce document…')}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {busy ? (
            <button type="button" onClick={() => abortRef.current?.abort()} aria-label="Annuler la réponse"><FiX aria-hidden="true" /></button>
          ) : (
            <button type="submit" disabled={!ready || !input.trim()} aria-label="Envoyer la question"><FiArrowUp aria-hidden="true" /></button>
          )}
        </form>
      </div>
    </aside>
  );
});

function ReaderAnswer({ text, citations = [], onCitation }) {
  return String(text || '').split(/\n{2,}/).map((paragraph, index) => {
    const value = paragraph.replace(/^#{1,3}\s+/, '').trim();
    if (!value) return null;
    return <p key={index}>{renderInline(value, citations, onCitation)}</p>;
  });
}

function renderInline(text, citations, onCitation) {
  return text.split(/(\[S\d+\])/g).map((part, index) => {
    if (/^\[S\d+\]$/.test(part)) {
      const citation = citations.find((item) => `[${item.citationId}]` === part);
      if (citation) return <CitationLink key={index} citation={citation} onOpen={onCitation} compact />;
      return <span key={index} className="reader-unverified-citation">[citation non vérifiée]</span>;
    }
    return part;
  });
}

function selectionLabel(anchor) {
  const end = anchor.segments?.at(-1)?.page;
  if (end > anchor.page) return `Sélection · pages ${anchor.page}–${end}`;
  return anchor.page > 0 ? `Sélection · page ${anchor.page}` : 'Sélection · passage structuré';
}

function scopeLabel(scope, ready, pdfMode) {
  if (pdfMode) {
    if (!ready) return 'Vérification du PDF';
    if (scope?.knowledgeSource === 'docling') return 'Docling · révision du PDF vérifiée';
    if (scope?.knowledgeSource === 'pdf-reader') return 'PDF.js · extraits non vérifiés';
    return 'PDF original · sélection, page ou document';
  }
  if (scope?.anchor?.verified) return 'Sélection vérifiée par Docling';
  if (scope?.status === 'structured-ready' || ready) return 'Structure Docling prête';
  if (scope?.knowledgeSource === 'source-fallback') return 'Lecture source partielle';
  return 'Sélection et citations vérifiables';
}

function clip(value, max) {
  const chars = Array.from(String(value || ''));
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`;
}

export default ReaderAssistant;
