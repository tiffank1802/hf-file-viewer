export default function CitationLink({ citation, onOpen, compact = false }) {
  if (!citation) return null;
  const section = Array.isArray(citation.headingPath) ? citation.headingPath.at(-1) : '';
  const page = Number(citation.page) > 0 ? Number(citation.page) : null;
  const origin = citation.verified === true ? 'Docling vérifié' : citation.verified === false ? 'Extrait du lecteur non vérifié' : '';
  const detail = [section, page ? `page ${page}` : '', origin].filter(Boolean).join(' · ');
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
