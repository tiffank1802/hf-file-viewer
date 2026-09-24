import { useEffect, useId, useRef, useState } from 'react';
import { FiMessageCircle, FiSend, FiX } from 'react-icons/fi';
import { catalogHint, fetchChatStatus, listConversations, loadConversation, streamChat } from '../services/chat';
import { useAuth } from '../hooks/useAuth';
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

export default function LibraryChat({ path = '', catalog, onNavigate, onOpenFile, onOpenAuth }) {
  const auth = useAuth();
  const userId = auth.user?.id ?? null;
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [conversationId, setConversationId] = useState('');
  const [conversations, setConversations] = useState([]);
  const [pane, setPane] = useState('chat');
  const [historyNote, setHistoryNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState('');
  const conversationRef = useRef('');
  const inputRef = useRef(null);
  const endRef = useRef(null);
  const abortRef = useRef(null);
  const idRef = useRef(0);
  const panelId = useId();
  const titleId = useId();
  const inputId = useId();

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => { conversationRef.current = conversationId; }, [conversationId]);

  useEffect(() => {
    conversationRef.current = '';
    setMessages([]);
    setConversationId('');
    setConversations([]);
    setHistoryNote('');
    setPane('chat');
  }, [userId]);

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

  useEffect(() => {
    if (!open || !userId) return undefined;
    const controller = new AbortController();
    listConversations(controller.signal)
      .then((payload) => {
        if (payload.unprovisioned) {
          setHistoryNote(payload.error || 'Lance npm run appwrite:setup pour garder les conversations.');
          return;
        }
        const items = Array.isArray(payload.items) ? payload.items : [];
        setConversations(items);
      })
      .catch((error) => {
        if (error.name === 'AbortError') return;
        if (error.status !== 401) setHistoryNote(error.message || 'Historique illisible.');
      });
    return () => controller.abort();
  }, [open, userId]);

  function startFresh() {
    abortRef.current?.abort();
    setConversationId('');
    setMessages([]);
    setHistoryNote('');
    setBusy(false);
  }

  async function openStored(id) {
    if (!id || busy) return;
    setHistoryNote('');
    setBusy(true);
    try {
      const loaded = await loadConversation(id);
      setConversationId(id);
      setMessages(messagesFromPayload(loaded.messages));
    } catch (error) {
      setHistoryNote(error.message || 'Conversation illisible.');
    } finally {
      setBusy(false);
    }
  }

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
    const currentConversation = conversationRef.current;
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
        conversationId: currentConversation,
        contextPath: path,
        catalog: catalogHint(catalog, status),
        signal: controller.signal,
        onEvent: ({ event, data }) => {
          if (event === 'sources') patch((item) => ({ ...item, documents: data.documents || [] }));
          if (event === 'delta') patch((item) => ({ ...item, text: `${item.text}${data.text || ''}` }));
          if (event === 'done') {
            if (data.conversationId) {
              setConversationId(data.conversationId);
              setConversations((current) => {
                if (current.some((item) => item.id === data.conversationId)) return current;
                return [{ id: data.conversationId, title: question.slice(0, 80), preview: question.slice(0, 80) }, ...current];
              });
            }
            setHistoryNote(data.saveError || '');
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

          <div className="library-chat-tabs" role="tablist" aria-label="Assistant">
            <button type="button" role="tab" aria-selected={pane === 'chat'} className={pane === 'chat' ? 'active' : ''} onClick={() => setPane('chat')}>
              Discussion
            </button>
            <button type="button" role="tab" aria-selected={pane === 'history'} className={pane === 'history' ? 'active' : ''} onClick={() => setPane('history')}>
              Historique
              {conversations.length > 0 && <span>{conversations.length}</span>}
            </button>
          </div>
          {historyNote && <p className="library-chat-note">{historyNote}</p>}

          {pane === 'history' ? (
            <div className="library-chat-history" role="tabpanel">
              {!userId && (
                <div className="library-chat-empty">
                  <p>Connecte-toi pour retrouver les conversations de ton compte.</p>
                  {onOpenAuth && <button type="button" onClick={() => onOpenAuth('signin')}>Se connecter</button>}
                </div>
              )}
              {userId && (
                <button type="button" className="library-chat-new" onClick={startFresh} disabled={busy}>Nouvelle conversation</button>
              )}
              {userId && conversations.length === 0 && (
                <p className="library-chat-empty">Aucune conversation enregistrée pour le moment.</p>
              )}
              {userId && conversations.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`library-chat-thread${item.id === conversationId ? ' current' : ''}`}
                  disabled={busy}
                  onClick={() => void openStored(item.id)}
                >
                  <strong>{item.title || item.preview || 'Conversation'}</strong>
                  {item.preview && item.preview !== item.title && <em>{item.preview}</em>}
                  {item.updatedAt && <time dateTime={item.updatedAt}>{formatChatDate(item.updatedAt)}</time>}
                </button>
              ))}
            </div>
          ) : (
          <div className="library-chat-log" role="tabpanel" aria-live="polite">
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
                {message.role === 'assistant' && message.pending && !message.text && message.documents?.length > 0 && (
                  <p className="library-chat-engine">Lecture des documents…</p>
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
          )}

          {pane === 'chat' && (
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
          <p className="library-chat-trust">
            {userId
              ? 'Cette conversation est enregistrée dans ton compte.'
              : 'Connecte-toi pour garder cette conversation dans ton compte.'}
            {' '}Les cartes viennent de la bibliothèque.
          </p>
          )}
        </section>
      )}
    </>
  );
}

function formatChatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

function messagesFromPayload(list) {
  return (Array.isArray(list) ? list : []).map((item, index) => ({
    id: item.id || `stored-${index}`,
    role: item.role === 'assistant' ? 'assistant' : 'user',
    text: item.text || '',
    documents: Array.isArray(item.documents) ? item.documents : [],
  }));
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
  return parseAnswer(text).map((block, index) => {
    if (block.type === 'h') {
      return <h3 key={index}>{renderInline(block.text, documents, onOpen)}</h3>;
    }
    if (block.type === 'ul' || block.type === 'ol') {
      const List = block.type === 'ol' ? 'ol' : 'ul';
      return (
        <List key={index}>
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, documents, onOpen)}</li>
          ))}
        </List>
      );
    }
    return <p key={index}>{renderInline(block.text, documents, onOpen)}</p>;
  });
}

function parseAnswer(text) {
  const blocks = [];
  let list = null;
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      list = null;
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      list = null;
      blocks.push({ type: 'h', text: heading[2] });
      continue;
    }
    const bullet = /^[-*•]\s+(.+)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
    if (bullet || numbered) {
      const type = bullet ? 'ul' : 'ol';
      if (!list || list.type !== type) {
        list = { type, items: [] };
        blocks.push(list);
      }
      list.items.push((bullet || numbered)[1]);
      continue;
    }
    list = null;
    blocks.push({ type: 'p', text: trimmed });
  }
  return blocks;
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
value || item.name === value);
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
