export function parseMarkdownTable(markdown = '') {
  const rows = String(markdown)
    .split(/\r?\n/)
    .map(splitMarkdownRow)
    .filter((row) => row.some(Boolean));
  if (rows.length === 0) return { headers: [], rows: [] };
  if (rows.length > 1 && rows[1].every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')))) {
    return { headers: rows[0], rows: rows.slice(2) };
  }
  return { headers: [], rows };
}

function splitMarkdownRow(line) {
  const cells = [];
  let cell = '';
  let escaped = false;
  for (const character of String(line).trim()) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  if (cells[0] === '') cells.shift();
  if (cells.at(-1) === '') cells.pop();
  return cells;
}
