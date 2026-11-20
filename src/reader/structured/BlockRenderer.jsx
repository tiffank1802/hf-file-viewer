import { createElement } from 'react';
import { readerAssetUrl } from '../../services/reader';
import { parseMarkdownTable } from './structuredBlocks';

const HEADING_TYPES = new Set(['title', 'section_header', 'heading']);
const LIST_TYPES = new Set(['list_item', 'list-item', 'checkbox_selected', 'checkbox_unselected']);
const FORMULA_TYPES = new Set(['formula', 'equation']);
const PICTURE_TYPES = new Set(['picture', 'figure', 'image']);

export default function BlockRenderer({
  block,
  sourcePath,
  artifactId,
  annotation,
  focused = false,
}) {
  const type = String(block?.type || 'text').toLowerCase();
  const color = annotation?.color || '';
  const className = [
    'structured-block',
    `type-${safeClass(type)}`,
    color ? `annotated color-${color}` : '',
    focused ? 'focused' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      id={`reader-block-${block.id}`}
      className={className}
      data-reader-block="true"
      data-block-id={block.id}
      data-page={Number(block.page) || 0}
      data-ordinal={Number(block.ordinal) || 0}
      tabIndex="-1"
    >
      {renderBlockContent(type, block, sourcePath, artifactId)}
      {annotation && <span className="structured-annotation-mark" title="Passage annoté" aria-label="Passage annoté" />}
      {block.page > 0 && <small className="structured-page-ref">Page {block.page}</small>}
    </div>
  );
}

function renderBlockContent(type, block, sourcePath, artifactId) {
  if (HEADING_TYPES.has(type)) {
    const level = Math.min(6, Math.max(1, Number(block.level) || (type === 'title' ? 1 : 2)));
    return createElement(`h${level}`, null, block.text || block.caption || 'Section');
  }
  if (type === 'table') return <TableBlock block={block} />;
  if (PICTURE_TYPES.has(type)) {
    return <FigureBlock block={block} sourcePath={sourcePath} artifactId={artifactId} />;
  }
  if (FORMULA_TYPES.has(type)) {
    const formula = block.text || block.markdown || block.caption || 'Formule';
    return <div className="structured-formula" role="math" aria-label={formula}><code>{formula}</code></div>;
  }
  if (LIST_TYPES.has(type)) {
    const checked = type === 'checkbox_selected' ? true : type === 'checkbox_unselected' ? false : null;
    return (
      <ul className="structured-list"><li>
        {checked !== null && <span aria-hidden="true">{checked ? '☑' : '☐'} </span>}
        {block.text || block.markdown}
      </li></ul>
    );
  }
  if (type === 'code') return <pre className="structured-code"><code>{block.text || block.markdown}</code></pre>;
  if (type === 'page_header' || type === 'page_footer') {
    return <p className="structured-running-text">{block.text}</p>;
  }
  if (type === 'caption') return <p className="structured-caption">{block.text || block.caption}</p>;
  const content = block.text || block.markdown || block.caption;
  return content ? <p>{content}</p> : <p className="structured-empty">Bloc documentaire sans représentation textuelle.</p>;
}

function TableBlock({ block }) {
  const table = parseMarkdownTable(block.markdown || block.text || '');
  if (table.rows.length === 0) {
    return (
      <figure className="structured-table-wrap">
        {block.caption && <figcaption>{block.caption}</figcaption>}
        <p>{block.text || 'Tableau sans contenu textuel exploitable.'}</p>
      </figure>
    );
  }
  return (
    <figure className="structured-table-wrap">
      {block.caption && <figcaption>{block.caption}</figcaption>}
      <div tabIndex="0" role="region" aria-label={block.caption || 'Tableau du document'}>
        <table>
          {table.headers.length > 0 && (
            <thead><tr>{table.headers.map((cell, index) => <th key={`${index}-${cell}`} scope="col">{cell}</th>)}</tr></thead>
          )}
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${cellIndex}-${cell}`}>{cell}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

function FigureBlock({ block, sourcePath, artifactId }) {
  const assetId = block.asset?.id;
  const caption = block.caption || block.asset?.caption || block.text;
  return (
    <figure className="structured-figure">
      {assetId ? (
        <img
          src={readerAssetUrl(sourcePath, artifactId, assetId)}
          alt={caption || 'Illustration extraite du document'}
          width={positiveDimension(block.asset?.width)}
          height={positiveDimension(block.asset?.height)}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div className="structured-figure-missing">Illustration non exportée</div>
      )}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

function positiveDimension(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 10000 ? number : undefined;
}

function safeClass(value) {
  return String(value).replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'text';
}
