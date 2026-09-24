import { useEffect, useId, useRef, useState } from 'react';
import { FiMessageCircle, FiSend, FiX } from 'react-icons/fi';
import { catalogHint, fetchChatStatus, streamChat } from '../services/chat';
import { getFileKind, normalizeBucketItem, parentPath } from '../utils/files';

const SUGGESTIONS = [
  'Où sont les polys de mécanique en 3A ?',
  'Je cherche les tutos SolidWorks',
  'Quels documents pour le TOEIC ?',
  'Résume un cours d’anglais',
];

const KIND_LABEL = {
  folder: 'Dossier',
  pdf: 'PDF',
  office: 'Office',
  text: 'Texte',
  image: 'Image',
  audio: 'Audio',
  video: 'Vidéo',
  model: '3D',
  archive: 'Archive',
  file: 'Fichier',
};

export default function LibraryChat({ path = '', catalog, onNavigate, onOpenFile }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState('');
  const inputRef = useRef(null);
  const endRef = useRef(null);
  const abortRef = useRef(null);
  const idRef = useRef(0);
  const panelId = useId();
  const titleId = useId();
  const inputId = useId();

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!open || status || statusError) return undefined;
    const controller = new AbortController();
    fetchChatStatus(controller.signal)
      .then(setStatus)
      .catch((error) => {
        if (error.name === 'AbortError') return;
        setStatusError(error.message || 'Assistant indisponible.');
      });
    return () => controller.abort();
  }, [open, status, statusError]);

  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, open, busy]);

  function openDocument(doc) {
    const item = normalizeBucketItem(doc);
    if (!item.path) return;
    if (item.type === 'directory') {
      onNavigate(item.path);
      return;
    }
    onNavigate(parentPath(item.path));
    onOpenFile(item);
  }

  async function ask(text) {
    const question = text.trim();
    if (!question || busy) return;
    const history = messages
      .filter((item) => item.text && !item.pending)
      .slice(-6)
      .map((item) => ({ role: item.role, content: item.text }));
    idRef.current += 1;
    const userId = `m${idRef.current}`;
    idRef.current += 1;
    const assistantId = `m${idRef.current}`;
    setMessages((current) => [
      ...current,
      { id: userId, role: 'user', text: question },
      { id: assistantId, role: 'assistant', text: '', documents: [], pending: true },
    ]);
    setInput('');
    setBusy(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const patch = (recipe) => {
      setMessages((current) => current.map((item) => (item.id === assistantId ? recipe(item) : item)));
    };
    try {
      await streamChat({
        message: question,
        history,
        contextPath: path,
        catalog: catalogHint(catalog, status),
        signal: controller.signal,
        onEvent: ({ event, data }) => {
          if (event === 'sources') patch((item) => ({ ...item, documents: data.documents || [] }));
          if (event === 'delta') patch((item) => ({ ...item, text: `${item.text}${data.text || ''}` }));
          if (event === 'done') {
            patch((item) => ({
              ...item,
              text: data.answer || item.text,
              documents: data.documents || item.documents,
              engine: data.engine,
              pending: false,
            }));
          }
          if (event === 'error') {
            patch((item) => ({ ...item, text: data.error || item.text, pending: false, error: true }));
          }
        },
      });
      patch((item) => (item.pending ? { ...item, pending: false } : item));
    } catch (error) {
      if (error.name === 'AbortError') return;
      patch((item) => ({
        ...item,
        text: error.message || 'L’assistant n’a pas pu répondre.',
        pending: false,
        error: true,
      }));
    } finally {
      setBusy(false);
    }
  }

  const engineLabel = status?.engine === 'nvidia' ? 'NVIDIA' : 'Bibliothèque';

  return (
    <>
      <button
        type="button"
        className={`library-chat-launcher ${open ? 'open' : ''}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        <FiMessageCircle aria-hidden="true" />
        <span>{open ? 'Fermer' : 'Assistant'}</span>
        <i aria-hidden="true" />
      </button>

      {open && (
        <section className="library-chat-panel" id={panelId} role="dialog" aria-labelledby={titleId}>
          <header className="library-chat-head">
            <div>
              <strong id={titleId}>Assistant bibliothèque</strong>
              <p>{path ? `Dossier ouvert : ${path}` : 'Toute la bibliothèque'}</p>
            </div>
            <span className="library-chat-pill">{statusError ? 'Hors ligne' : engineLabel}</span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Fermer l’assistant">
              <FiX aria-hidden="true" />
            </button>
          </header>

          <div className="library-chat-log" aria-live="polite">
            {messages.length === 0 && (
              <article className="library-chat-bubble assistant">
                <AnswerText text="Je parcours la bibliothèque pour te proposer un document, le résumer et t’y emmener. Pose une question sur un cours, une année ou TOEIC." />
              </article>
            )}
            {statusError && <p className="library-chat-note">{statusError}</p>}
            {messages.length === 0 && (
              <div className="library-chat-suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion} type="button" disabled={busy} onClick={() => ask(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
            {messages.map((message) => (
              <article key={message.id} className={`library-chat-bubble ${message.role}${message.error ? ' error' : ''}`}>
                {message.role === 'assistant' && message.pending && !message.text && (
                  <span className="library-chat-pending" aria-label="Recherche en cours"><i /><i /><i /></span>
                )}
                {message.text && (
                  <AnswerText text={message.text} documents={message.documents} onOpen={openDocument} />
                )}
                {message.documents?.length > 0 && (
                  <div className="library-chat-docs">
                    {message.documents.map((doc) => (
                      <DocumentCard key={doc.path} doc={doc} onOpen={openDocument} />
                    ))}
                  </div>
                )}
                {message.engine && !message.pending && (
                  <p className="library-chat-engine">
                    {message.engine === 'nvidia'
                      ? 'Rédigé avec NVIDIA, à partir des documents de la bibliothèque.'
                      : 'Recherche dans la bibliothèque.'}
                  </p>
                )}
              </article>
            ))}
            <span ref={endRef} />
          </div>

          <form
            className="library-chat-form"
            onSubmit={(event) => {
              event.preventDefault();
              ask(input);
            }}
          >
            <label className="sr-only" htmlFor={inputId}>Question à l’assistant</label>
            <textarea
              id={inputId}
              ref={inputRef}
              rows={2}
              maxLength={2000}
              value={input}
              placeholder="Un cours, une année, un examen…"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button type="submit" disabled={busy || !input.trim()} aria-label="Envoyer">
              <FiSend aria-hidden="true" />
            </button>
          </form>
          <p className="library-chat-trust">Les cartes viennent de la bibliothèque. Rien n’est inventé comme fichier.</p>
        </section>
      )}
    </>
  );
}

function DocumentCard({ doc, onOpen }) {
  const kind = getFileKind(doc.path, doc.type || 'file');
  return (
    <button type="button" className="library-chat-doc" onClick={() => onOpen(doc)}>
      <span>{KIND_LABEL[kind] || 'Fichier'}</span>
      <strong>{doc.name || doc.path}</strong>
      <em>{doc.path}</em>
      {doc.reason && <small>{doc.reason}</small>}
      {doc.excerpt && <p>{doc.excerpt}</p>}
      <b>Ouvrir</b>
    </button>
  );
}

function AnswerText({ text, documents = [], onOpen }) {
  return text.split('\n').map((line, index) => (
    <p key={`${index}-${line.slice(0, 12)}`}>{renderInline(line, documents, onOpen)}</p>
  ));
}

function renderInline(line, documents, onOpen) {
  const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const value = part.slice(1, -1);
      const doc = documents.find((item) => item.path === value || item.name === value);
      if (doc && onOpen) {
        return (
          <button key={index} type="button" className="library-chat-path" onClick={() => onOpen(doc)}>
            {value}
          </button>
        );
      }
      return <code key={index}>{value}</code>;
    }
    return <span key={index}>{part}</span>;
  });
}
