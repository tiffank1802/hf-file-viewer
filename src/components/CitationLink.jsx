export default function CitationLink({ citation, onOpen, compact = false }) {
  if (!citation) return null;
  const section = Array.isArray(citation.headingPath) ? citation.headingPath.at(-1) : '';
  const page = Number(citation.page) > 0 ? Number(citation.page) : null;
  const detail = [section, page ? `page ${page}` : ''].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      className="library-chat-citation"
      title={detail || 'Ouvrir la source'}
      onClick={() => onOpen?.(citation)}
    >
      [{citation.citationId}]
      {!compact && detail && <span>{detail}</span>}
    </button>
  );
}
