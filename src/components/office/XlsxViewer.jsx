import { useEffect, useMemo, useState } from 'react';
import { FiChevronLeft, FiChevronRight, FiDownload } from 'react-icons/fi';
import { MAX_XLSX_CELLS, XLSX_PAGE_SIZE } from '../../config';
import { useOfficeFile } from '../../hooks/useOfficeFile';
import { ViewerError, ViewerLoader } from './common';

function isEmptyCell(value) {
  return value === '' || value === null || value === undefined;
}

function formatCell(value) {
  if (isEmptyCell(value)) return '';
  if (value instanceof Date) {
    const hasTime = value.getHours() !== 0 || value.getMinutes() !== 0 || value.getSeconds() !== 0;
    return hasTime ? value.toLocaleString('fr-FR') : value.toLocaleDateString('fr-FR');
  }
  if (typeof value === 'boolean') return value ? 'VRAI' : 'FAUX';
  return String(value);
}

/** Supprime les lignes/colonnes vides en fin de feuille pour un tableau net. */
function trimSheet(rows) {
  let lastRow = rows.length;
  while (lastRow > 0 && rows[lastRow - 1].every(isEmptyCell)) lastRow -= 1;
  const kept = rows.slice(0, lastRow);
  let width = 0;
  for (const row of kept) {
    for (let index = row.length - 1; index >= 0; index -= 1) {
      if (!isEmptyCell(row[index])) {
        width = Math.max(width, index + 1);
        break;
      }
    }
  }
  return kept.map((row) => row.slice(0, width));
}

function columnLabel(index) {
  let label = '';
  let value = index;
  do {
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return label;
}

function escapeCsvCell(value) {
  const text = formatCell(value);
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCsv(sheetName, rows) {
  const csv = `\ufeff${rows.map((row) => row.map(escapeCsvCell).join(';')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${sheetName || 'feuille'}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function parseWorkbook(XLSX, buffer) {
  const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true });
  let remaining = MAX_XLSX_CELLS;
  const sheets = workbook.SheetNames.map((name) => {
    const worksheet = workbook.Sheets[name];
    let rows = trimSheet(XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: true }));
    const width = Math.max(rows.reduce((max, row) => Math.max(max, row.length), 0), 1);
    let truncated = false;
    const maxRows = Math.max(1, Math.floor(remaining / width));
    if (rows.length > maxRows) {
      rows = rows.slice(0, maxRows);
      truncated = true;
    }
    remaining = Math.max(0, remaining - rows.length * width);
    return { name, rows, truncated };
  });
  return sheets;
}

/**
 * Aperçu local des classeurs `.xlsx` / `.xls` / `.xlsm`.
 *
 * `xlsx` (SheetJS Community) ne fait que la lecture : le tableau, les
 * onglets de feuilles et la pagination sont rendus par ce composant afin de
 * garder un bundle et une UI maîtrisés.
 */
export default function XlsxViewer({ file, onSwitchMode }) {
  const { buffer, loading, error } = useOfficeFile(file);
  const [sheets, setSheets] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const [sheetIndex, setSheetIndex] = useState(0);
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (!buffer) return undefined;

    let cancelled = false;
    setParsing(true);
    setParseError('');
    setSheets(null);
    setSheetIndex(0);
    setPage(0);

    import('xlsx')
      .then((XLSX) => {
        if (cancelled) return;
        const parsed = parseWorkbook(XLSX, buffer);
        if (parsed.length === 0) {
          setParseError('Aucune feuille n’a été trouvée dans ce classeur.');
          return;
        }
        setSheets(parsed);
      })
      .catch((parseIssue) => {
        console.error('Cannot parse spreadsheet locally', parseIssue);
        if (!cancelled) {
          setParseError(
            'Ce classeur n’a pas pu être lu localement '
            + '(format non pris en charge ou fichier endommagé).',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setParsing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [buffer]);

  const activeSheet = sheets && sheets[Math.min(sheetIndex, sheets.length - 1)];
  const totalPages = activeSheet ? Math.max(1, Math.ceil(activeSheet.rows.length / XLSX_PAGE_SIZE)) : 1;
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = useMemo(() => {
    if (!activeSheet) return [];
    return activeSheet.rows.slice(safePage * XLSX_PAGE_SIZE, (safePage + 1) * XLSX_PAGE_SIZE);
  }, [activeSheet, safePage]);
  const columnCount = activeSheet
    ? activeSheet.rows.reduce((max, row) => Math.max(max, row.length), 0)
    : 0;

  if (loading || (!buffer && !error)) {
    return <ViewerLoader message="Téléchargement du classeur…" />;
  }

  if (error || parseError) {
    return <ViewerError file={file} message={error || parseError} action={onSwitchMode} />;
  }

  if (parsing || !activeSheet) {
    return <ViewerLoader message="Lecture des feuilles…" />;
  }

  const firstRow = safePage * XLSX_PAGE_SIZE + 1;
  const lastRow = safePage * XLSX_PAGE_SIZE + pageRows.length;

  return (
    <div className="office-local-scroll xlsx-preview">
      <div className="xlsx-toolbar">
        {sheets.length > 1 && (
          <div className="xlsx-sheets" role="tablist" aria-label="Feuilles du classeur">
            {sheets.map((sheet, index) => (
              <button
                key={sheet.name}
                type="button"
                role="tab"
                aria-selected={index === sheetIndex}
                className={index === sheetIndex ? 'is-active' : ''}
                title={`${sheet.rows.length} ligne${sheet.rows.length > 1 ? 's' : ''}`}
                onClick={() => { setSheetIndex(index); setPage(0); }}
              >
                {sheet.name}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="xlsx-csv"
          onClick={() => downloadCsv(activeSheet.name, activeSheet.rows)}
          title="Exporter la feuille active au format CSV"
        >
          <FiDownload aria-hidden="true" /> CSV
        </button>
      </div>

      {activeSheet.truncated && (
        <p className="xlsx-notice">
          Affichage tronqué à {activeSheet.rows.length} lignes pour préserver les performances.
          Le fichier complet reste disponible au téléchargement.
        </p>
      )}

      {activeSheet.rows.length === 0 ? (
        <p className="xlsx-empty">Cette feuille est vide.</p>
      ) : (
        <div className="xlsx-table-wrap">
          <table className="xlsx-table">
            <thead>
              <tr>
                <th scope="col" className="xlsx-corner" aria-label="Numéros de ligne" />
                {Array.from({ length: columnCount }, (_, index) => (
                  <th key={columnLabel(index)} scope="col">{columnLabel(index)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row, rowIndex) => (
                <tr key={`${safePage}-${rowIndex}`}>
                  <th scope="row" className="xlsx-rownum">{safePage * XLSX_PAGE_SIZE + rowIndex + 1}</th>
                  {Array.from({ length: columnCount }, (_, colIndex) => (
                    <td key={columnLabel(colIndex)}>{formatCell(row[colIndex])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="xlsx-pager">
          <button
            type="button"
            disabled={safePage === 0}
            onClick={() => setPage(safePage - 1)}
            aria-label="Page précédente"
          >
            <FiChevronLeft aria-hidden="true" />
          </button>
          <span>Lignes {firstRow}–{lastRow} sur {activeSheet.rows.length}</span>
          <button
            type="button"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage(safePage + 1)}
            aria-label="Page suivante"
          >
            <FiChevronRight aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
