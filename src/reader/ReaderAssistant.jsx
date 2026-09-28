import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
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
  onCitation,
  onClose,
}, ref) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState(null);
  const [announcement, setAnnouncement] = useState('');
  const abortRef = useRef(null);
  const idRef = useRef(0);
  const ready = document?.status === 'structured-ready';

  const ask = useCallback(async (question, intent = 'explain-selection', anchor = selection?.anchor) => {
    const text = String(question || '').trim();
    if (!text || busy || !ready || !document?.sourcePath) return;
    const startedAt = performance.now();
    setAnnouncement('Recherche des preuves dans le document.');
    idRef.current += 1;
    const userID = `reader-user-${idRef.current}`;
    idRef.current += 1;
    const assistantID = `reader-assistant-${idRef.current}`;
    const history = messages
      .filter((message) => message.text && !message.pending)
      .slice(-6)
      .map((message) => ({ role: message.role, content: message.text }));
    setMessages((current) => [
      ...current,
      { id: userID, role: 'user', text, selection: anchor?.quote || '' },
      { id: assistantID, role: 'assistant', text: '', pending: true, citations: [] },
    ]);
    setInput('');
    setBusy(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const patch = (recipe) => {
      setMessages((current) => current.map((message) => (
        message.id === assistantID ? recipe(message) : message
      )));
    };
    try {
      await streamChat({
        message: text,
        intent,
        scope: {
          type: 'document',
          sourcePath: document.sourcePath,
          artifactId: document.artifactId || undefined,
          anchor: anchor || undefined,
        },
        history,
        contextPath: document.sourcePath.split('/').slice(0, -1).join('/'),
        signal: controller.signal,
        onEvent: ({ event, data }) => {
          if (event === 'scope') {
            setScope(data);
            patch((message) => ({ ...message, scope: data }));
          }
          if (event === 'citations') {
            patch((message) => ({ ...message, citations: data.citations || [] }));
          }
          if (event === 'thinking') patch((message) => ({ ...message, thinking: true }));
          if (event === 'delta') {
            patch((message) => ({ ...message, text: `${message.text}${data.text || ''}`, thinking: false }));
          }
          if (event === 'done') {
            if (data.scope) setScope(data.scope);
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
              retry: { question: text, intent, anchor },
            }));
          }
        },
      });
      patch((message) => (message.pending ? { ...message, pending: false } : message));
    } catch (error) {
      if (error.name !== 'AbortError') {
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
          retry: { question: text, intent, anchor },
        }));
      }
    } finally {
      setBusy(false);
    }
  }, [busy, document, messages, ready, selection]);

  useImperativeHandle(ref, () => ({ ask }), [ask]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <aside id="reader-assistant-panel" className="reader-assistant" aria-label="Assistant du document">
      <header className="reader-assistant-head">
        <div><FiMessageCircle aria-hidden="true" /></div>
        <span>
          <strong>Assistant du document</strong>
          <small>{scopeLabel(scope, ready)}</small>
        </span>
        <button type="button" className="reader-panel-close" onClick={onClose} aria-label="Fermer l’assistant">
          <FiX aria-hidden="true" />
        </button>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
      </header>
      {selection?.anchor?.quote && (
        <div className="reader-selection-card">
          <span>{selection.anchor.page > 0 ? `Sélection · page ${selection.anchor.page}` : 'Sélection · passage structuré'}</span>
          <blockquote>{selection.anchor.quote}</blockquote>
        </div>
      )}
      <div className="reader-assistant-log">
        {messages.length === 0 && (
          <div className="reader-assistant-empty">
            <strong>{ready ? 'Sélectionnez un passage' : 'Assistant structuré indisponible'}</strong>
            <p>{ready
              ? 'Demandez une explication ancrée dans les sections et pages Docling du document.'
              : 'Le PDF reste lisible, mais aucune question ne sera envoyée tant que son artefact Docling prêt n’est pas disponible.'}</p>
          </div>
        )}
        {messages.map((message) => (
          <article key={message.id} className={`reader-message ${message.role}${message.error ? ' error' : ''}`}>
            {message.selection && <small>À propos de « {clip(message.selection, 100)} »</small>}
            {message.text ? (
              <ReaderAnswer
                text={message.text}
                citations={message.citations}
                onCitation={onCitation}
              />
            ) : message.pending ? (
              <span className="reader-thinking"><FiLoader aria-hidden="true" /> {message.thinking ? 'Le modèle réfléchit…' : 'Recherche des preuves…'}</span>
            ) : null}
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
                onClick={() => void ask(message.retry.question, message.retry.intent, message.retry.anchor)}
              >
                <FiRefreshCw aria-hidden="true" /> Réessayer
              </button>
            )}
          </article>
        ))}
      </div>
      <form
        className="reader-assistant-form"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(input, selection ? 'explain-selection' : 'explain', selection?.anchor);
        }}
      >
        <textarea
          rows={2}
          maxLength={2000}
          aria-label="Question à l’assistant du document"
          value={input}
          disabled={!ready}
          placeholder={!ready ? 'Artefact Docling requis' : (selection ? 'Posez une question sur la sélection…' : 'Posez une question sur ce document…')}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button type="submit" disabled={!ready || busy || !input.trim()} aria-label="Envoyer la question">
          <FiArrowUp aria-hidden="true" />
        </button>
      </form>
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

function scopeLabel(scope, ready) {
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
