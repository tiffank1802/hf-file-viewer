// Resolve metadata against the text layer PDF.js already drew, never against
// Docling's layout coordinates. Require a unique match on the target page.
export function findPDFTextRange(layer, excerpt) {
  const tokens = (text) => [...text.matchAll(/\S+/gu)];
  const canonical = (word) => word.normalize('NFKC').toLowerCase();
  const query = tokens(String(excerpt || '').replace(/…$/, '')).map(([word]) => canonical(word));
  if (!layer || query.join('').length < 4 || query.length > 100) return null;
  const doc = layer.ownerDocument;
  const scanner = doc.createTreeWalker(layer, 4); // NodeFilter.SHOW_TEXT
  const words = [];
  let node;
  while ((node = scanner.nextNode())) {
    if ((node.parentElement?.closest('span') == null) || !node.textContent.trim()) continue;
    for (const { 0: word, index } of tokens(node.textContent)) {
      words.push({ node, offset: index, end: index + word.length, value: canonical(word) });
      if (words.length > 16000) return null;
    }
  }
  let start = -1;
  for (let index = 0; index <= words.length - query.length; index += 1) {
    if (query[0] !== words[index].value || !query.every((word, offset) => word === words[index + offset].value)) continue;
    if (start !== -1) return null;
    start = index;
  }
  if (start === -1) return null;
  const first = words[start];
  const last = words[start + query.length - 1];
  const range = doc.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.end);
  return range;
}
