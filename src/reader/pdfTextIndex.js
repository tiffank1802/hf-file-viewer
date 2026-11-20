const MAX_PAGES = 600;
const MAX_PAGE_CHARS = 40000;
const MAX_INDEX_CHARS = 6_000_000;

export function pdfPageText(content) {
  return (content?.items || [])
    .filter((item) => typeof item?.str === 'string')
    .map((item) => `${item.str}${item.hasEOL ? '\n' : ' '}`)
    .join('')
    .replace(/[\t\r ]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .trim();
}

export async function indexPDFPages(pdf, { signal, onPage } = {}) {
  const pages = new Map();
  let chars = 0;
  let truncated = false;
  const totalPages = Math.max(0, Number(pdf?.numPages) || 0);
  const limit = Math.min(totalPages, MAX_PAGES);
  for (let page = 1; page <= limit; page += 1) {
    if (signal?.aborted) break;
    const pdfPage = await pdf.getPage(page);
    const text = pdfPageText(await pdfPage.getTextContent());
    if (signal?.aborted) break;
    const remaining = Math.max(0, MAX_INDEX_CHARS - chars);
    const accepted = text.slice(0, Math.min(MAX_PAGE_CHARS, remaining));
    if (accepted.length < text.length) truncated = true;
    pages.set(page, accepted);
    chars += accepted.length;
    onPage?.({ page, text: accepted, indexedPages: pages.size, totalPages, truncated });
    if (chars >= MAX_INDEX_CHARS) break;
    // Yield between pages so canvas rendering and touch interactions stay responsive.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { pages, totalPages, indexedPages: pages.size, complete: pages.size === totalPages && !truncated, truncated: truncated || pages.size < totalPages };
}

function tokens(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .match(/[\p{L}\p{N}]{3,}/gu)?.filter((word) => !new Set(['les', 'des', 'une', 'est', 'dans', 'pour', 'que', 'avec', 'sur', 'document', 'cette']).has(word)) || [];
}

function excerpt(text, terms, max = 1800) {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const first = terms.map((term) => normalized.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0];
  const start = Math.max(0, (first ?? 0) - 250);
  // Rune-counted limits are enforced by Go; JS slicing is conservative for astral characters.
  return text.slice(start, start + max).trim();
}

export function searchPDFIndex(index, question, limit = 6) {
  const entries = [...(index?.pages || new Map()).entries()].filter(([, text]) => text.trim());
  const terms = [...new Set(tokens(question))];
  const summary = /r[eé]sum|synth[eè]se|ensemble|tout le document/i.test(String(question));
  let selected;
  if (summary || terms.length === 0) {
    const count = Math.min(limit, entries.length);
    selected = Array.from({ length: count }, (_, i) => entries[Math.floor(i * entries.length / count)]);
  } else {
    const ranked = entries.map(([page, text]) => {
      const words = tokens(text);
      const counts = new Map();
      for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
      const score = terms.reduce((sum, term) => sum + Math.min(5, counts.get(term) || 0), 0);
      return { page, text, score };
    }).sort((a, b) => b.score - a.score || a.page - b.page);
    const matches = ranked.filter((item) => item.score > 0).slice(0, limit);
    selected = (matches.length ? matches : ranked.slice(0, Math.min(limit, 3))).map(({ page, text }) => [page, text]);
  }
  return {
    indexedPages: index?.indexedPages || 0,
    totalPages: index?.totalPages || 0,
    complete: Boolean(index?.complete),
    passages: selected.map(([page, text]) => ({ page, text: excerpt(text, terms), origin: 'pdf-text' })),
  };
}
