import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FiChevronDown, FiChevronRight, FiDownload, FiEye, FiMoreHorizontal } from 'react-icons/fi';
import { useFolder } from '../../hooks/useFolder';
import { fileProxyUrl } from '../../services/api';
import { applyFolderCounts, formatBytes, formatDate, formatFolderCount, getBreadcrumbs, getName } from '../../utils/files';
import { canPreviewIcon, canPreviewInGallery, itemType, SORT_LABELS, sortExplorerItems } from '../../utils/explorer';
import { FileTypeIcon } from '../Icons';
import FolderIcon from './FolderIcon';

const compactQuery = '(max-width: 700px)';
function subscribeCompact(callback) {
  const media = window.matchMedia(compactQuery);
  media.addEventListener('change', callback);
  return () => media.removeEventListener('change', callback);
}
const isCompact = () => window.matchMedia(compactQuery).matches;

function FolderFeedback({ folder, compact = false }) {
  if (folder.loading) return <p className="finder-message" role="status">Chargement du dossier…</p>;
  if (folder.items.length) return null;
  return (
    <div className={`finder-empty ${compact ? 'is-compact' : ''}`}>
      {!compact && <FolderIcon size={68} />}
      <strong>{folder.error ? 'Contenu indisponible hors ligne' : 'Ce dossier est vide'}</strong>
      {folder.error && <button type="button" onClick={folder.retry}>Réessayer</button>}
    </div>
  );
}

function FolderOffline({ folder }) {
  return folder.error && folder.items.length > 0 ? (
    <p className="finder-message finder-offline">Aperçu local <button type="button" onClick={folder.retry}>Réessayer</button></p>
  ) : null;
}

function findNextButton(button, key, layout) {
  const group = button.closest('[data-finder-group]');
  if (!group) return null;
  const buttons = Array.from(group.querySelectorAll('[data-finder-item]'));
  const index = buttons.indexOf(button);
  if (key === 'Home') return buttons[0];
  if (key === 'End') return buttons.at(-1);
  if (layout === 'grid' && (key === 'ArrowUp' || key === 'ArrowDown')) {
    const rect = button.getBoundingClientRect();
    const center = rect.x + rect.width / 2;
    const candidates = buttons.map((candidate) => ({ candidate, rect: candidate.getBoundingClientRect() }))
      .filter(({ rect: next }) => key === 'ArrowUp' ? next.y < rect.y - 2 : next.y > rect.y + 2);
    candidates.sort((a, b) => Math.abs(a.rect.y - rect.y) - Math.abs(b.rect.y - rect.y)
      || Math.abs(a.rect.x + a.rect.width / 2 - center) - Math.abs(b.rect.x + b.rect.width / 2 - center));
    return candidates[0]?.candidate;
  }
  if (layout === 'columns' && (key === 'ArrowLeft' || key === 'ArrowRight')) {
    const column = group.closest('.finder-column');
    const target = key === 'ArrowLeft' ? column?.previousElementSibling : column?.nextElementSibling;
    return target?.querySelector('[aria-current="true"]') || target?.querySelector('[data-finder-item]');
  }
  if (layout === 'list' && (key === 'ArrowLeft' || key === 'ArrowRight')) return null;
  return buttons[index + (key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1)];
}

function EntryButton({ item, layout, siblings, actions, current = false, children }) {
  const selected = actions.selected.has(item.path);
  const name = actions.displayName(item);
  const tags = actions.tagsFor?.(item.path)?.filter((tag) => tag.active) ?? [];
  return (
    <button
      className="finder-entry-button"
      type="button"
      data-finder-item={item.path}
      aria-pressed={selected}
      aria-current={current || undefined}
      aria-label={tags.length ? `${name} — ${tags.map((tag) => tag.label).join(', ')}` : name}
      onClick={(event) => {
        if (event.detail === 0) {
          // A keyboard or assistive technology click activates the entry.
          if (layout === 'gallery' && event.nativeEvent.pointerType !== 'touch') actions.select(item, siblings, event);
          else actions.open(item);
          return;
        }
        const modified = event.shiftKey || event.metaKey || event.ctrlKey;
        const touch = event.nativeEvent.pointerType === 'touch' || window.matchMedia('(hover: none) and (pointer: coarse)').matches;
        if (!modified && ((layout === 'columns' && item.type === 'directory') || (touch && layout !== 'gallery' && !actions.preferTouchSelection))) {
          actions.open(item, { keepFocus: layout === 'columns' });
        } else {
          actions.select(item, siblings, event);
        }
      }}
      onDoubleClick={(event) => {
        if (!event.shiftKey && !event.metaKey && !event.ctrlKey) actions.open(item, { keepFocus: layout === 'columns' });
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        actions.showActions(item, siblings, event.currentTarget, event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key === ' ' && !event.altKey && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          if (item.type === 'file') actions.open(item);
          else actions.select(item, siblings, event);
        } else if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          actions.open(item, { keepFocus: layout === 'columns' });
        } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          actions.showActions(item, siblings, event.currentTarget);
        } else if (!event.metaKey && !event.ctrlKey && !event.altKey && ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
          const next = findNextButton(event.currentTarget, event.key, layout);
          if (!next) return;
          event.preventDefault();
          next.focus();
          const nextItem = siblings.find((entry) => entry.path === next.dataset.finderItem);
          if (nextItem) actions.select(nextItem, siblings, event);
        }
      }}
    >
      {children}
      {tags.length > 0 && <span className="finder-entry-tags" aria-hidden="true" title={tags.map((tag) => tag.label).join(', ')}>
        {tags.map((tag) => <i className="finder-tag-dot" key={tag.id} style={{ background: tag.color }} />)}
      </span>}
    </button>
  );
}

function EntryMenuButton({ item, siblings, actions }) {
  return (
    <button type="button" className="finder-more" aria-label={`Actions pour ${item.name}`} aria-haspopup="dialog"
      onClick={(event) => actions.showActions(item, siblings, event.currentTarget)}>
      <FiMoreHorizontal aria-hidden="true" />
    </button>
  );
}

function ItemVisual({ item, size, className, thumbnails }) {
  const [failed, setFailed] = useState(false);
  return thumbnails && !failed && canPreviewIcon(item)
    ? <img className={['finder-icon-thumbnail', className].filter(Boolean).join(' ')} width={size} height={size} src={fileProxyUrl(item.path)}
      loading="lazy" decoding="async" alt="" onError={() => setFailed(true)} />
    : <FileTypeIcon kind={item.kind} {...{ size, className }} />;
}

export function IconView({ folder, items, groups, actions, preferences }) {
  const { iconSize, gridSpacing, labelPosition, showIconPreview, showItemInfo } = preferences;
  if (!items.length || folder.loading) return <FolderFeedback folder={folder} />;
  return (
    <div data-finder-group aria-label="Éléments en icônes">
      {groups.map(({ key, title, items: entries }) => (
        <div key={key}>
          {title && <h3 className="finder-group-title">{title}</h3>}
          <ul className={`finder-grid finder-icons-${iconSize} finder-grid-spacing-${gridSpacing} finder-label-${labelPosition}`}>
            {entries.map((item) => (
              <li key={item.path} className="finder-icon-tile">
                <EntryButton item={item} siblings={items} actions={actions} layout="grid">
                  <ItemVisual item={item} className="finder-grid-icon" thumbnails={showIconPreview} />
                  <span className="finder-tile-copy">
                    <span className="finder-tile-name" title={item.name}>{actions.displayName(item)}</span>
                    {showItemInfo && <span className="finder-tile-info">{item.type === 'directory' ? formatFolderCount(item) : formatBytes(item.size)}</span>}
                  </span>
                </EntryButton>
                <EntryMenuButton item={item} siblings={items} actions={actions} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ListBranch({ reader, path, depth, preferences, counts, actions, expanded, onExpand }) {
  const folder = useFolder(reader, path);
  const items = sortExplorerItems(applyFolderCounts(folder.items, counts), preferences);
  return (
    <>
      <FolderOffline folder={folder} />
      <FolderFeedback folder={folder} compact />
      <ListRows {...{ reader, items, depth, preferences, counts, actions, expanded, onExpand }} />
    </>
  );
}

function ListRows({ reader, items, depth, preferences, counts, actions, expanded, onExpand, siblings = items }) {
  return items.map((item) => {
    const directory = item.type === 'directory';
    const open = directory && expanded.has(item.path);
    return (
      <div key={item.path}>
        <div className="finder-list-row" style={{ '--finder-indent': `${Math.min(depth, 10) * 16}px` }}>
          {directory && (
            <button className="finder-disclosure" type="button" aria-expanded={open} aria-label={`${open ? 'Replier' : 'Déplier'} ${item.name}`}
              onClick={() => onExpand(item.path)}>
              {open ? <FiChevronDown aria-hidden="true" /> : <FiChevronRight aria-hidden="true" />}
            </button>
          )}
          <EntryButton item={item} siblings={siblings} actions={actions} layout="list">
            <span className="finder-row-name" title={item.name}><ItemVisual item={item} size={27} className="finder-list-icon" thumbnails={preferences.showIconPreview} /><span>{actions.displayName(item)}</span></span>
            {preferences.listColumns.includes('date') && <span className="finder-list-date">{item.mtime ? formatDate(item.mtime) : '—'}</span>}
            {preferences.listColumns.includes('kind') && <span className="finder-list-type">{itemType(item)}</span>}
            {preferences.listColumns.includes('size') && <span className="finder-list-size">{directory ? '—' : formatBytes(item.size)}</span>}
          </EntryButton>
          <EntryMenuButton item={item} siblings={siblings} actions={actions} />
        </div>
        {open && <ListBranch reader={reader} path={item.path} depth={depth + 1} {...{ preferences, counts, actions, expanded, onExpand }} />}
      </div>
    );
  });
}

export function ListView({ folder, items, groups, onSort, ...props }) {
  if (!items.length || folder.loading) return <FolderFeedback folder={folder} />;
  const { preferences } = props;
  return (
    <div className={`finder-list finder-list-icons-${preferences.iconSize}`} data-finder-group
      data-show-date={preferences.listColumns.includes('date')} data-show-kind={preferences.listColumns.includes('kind')} data-show-size={preferences.listColumns.includes('size')}>
      <div className="finder-list-header" aria-label="Tri des colonnes">
        {Object.entries(SORT_LABELS).filter(([field]) => field === 'name' || preferences.listColumns.includes(field)).map(([field, label]) => (
          <button type="button" key={field} className={`finder-list-${field === 'kind' ? 'type' : field}`}
            aria-pressed={preferences.sort === field} onClick={() => onSort(field)}>
            {label}{preferences.sort === field && <span aria-label={preferences.direction === 'asc' ? 'Croissant' : 'Décroissant'}>{preferences.direction === 'asc' ? '↑' : '↓'}</span>}
          </button>
        ))}
      </div>
      {groups.map(({ key, title, items: entries }) => (
        <div key={key}>
          {title && <h3 className="finder-group-title">{title}</h3>}
          <ListRows items={entries} siblings={items} depth={0} {...props} />
        </div>
      ))}
    </div>
  );
}

function ColumnEntries({ folder, items, path, revealed, actions }) {
  return (
    <section className={`finder-column${revealed === null ? ' is-current' : ''}`} aria-label={getName(path)}>
      <h3 title={getName(path)}>{getName(path)}</h3>
      {revealed !== null && <FolderOffline folder={folder} />}
      <FolderFeedback folder={folder} compact />
      <ul data-finder-group aria-label={`Éléments de ${getName(path)}`}>
        {items.map((item) => (
          <li key={item.path}>
            <EntryButton item={item} siblings={items} actions={actions} current={item.path === revealed} layout="columns">
              <FileTypeIcon kind={item.kind} size={24} /> <span title={item.name}>{actions.displayName(item)}</span>
              {item.type === 'directory' && <FiChevronRight className="finder-column-arrow" aria-hidden="true" />}
            </EntryButton>
            <EntryMenuButton item={item} siblings={items} actions={actions} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function PathColumn({ reader, path, preferences, counts, activeFolder, activeItems, ...props }) {
  const loaded = useFolder(reader, path);
  const folder = activeFolder ?? loaded;
  const items = activeItems ?? sortExplorerItems(applyFolderCounts(folder.items, counts), preferences);
  return <ColumnEntries {...{ folder, items, path, ...props }} />;
}

export function ColumnView({ folder, items, path, reader, preferences, counts, actions }) {
  const compact = useSyncExternalStore(subscribeCompact, isCompact, () => false);
  const scrollRef = useRef(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
  }, [path]);
  if (compact) {
    return <div className="finder-columns"><ColumnEntries {...{ folder, items, path, actions }} revealed={null} /></div>;
  }
  const crumbs = getBreadcrumbs(path);
  return (
    <div className={`finder-columns finder-columns-${preferences.columnWidth}`} ref={scrollRef}>
      {crumbs.map((crumb, index) => {
        const revealed = crumbs[index + 1]?.path ?? null;
        return <PathColumn key={crumb.path} {...{ reader, preferences, counts, actions, revealed }} path={crumb.path}
          activeFolder={revealed === null ? folder : undefined} activeItems={revealed === null ? items : undefined} />;
      })}
    </div>
  );
}

function GalleryImage({ item }) {
  const [failed, setFailed] = useState(false);
  return canPreviewInGallery(item) && !failed
    ? <img className="finder-gallery-image" src={fileProxyUrl(item.path)} alt={item.name} onError={() => setFailed(true)} />
    : <FileTypeIcon kind={item.kind} size={106} />;
}

export function GalleryView({ folder, items, selection, actions, preferences }) {
  if (!items.length || folder.loading) return <FolderFeedback folder={folder} />;
  const index = Math.max(0, items.findIndex((entry) => entry.path === selection.current && selection.paths.has(entry.path)));
  const item = items[index];
  return (
    <div className="finder-gallery">
      <div className="finder-gallery-stage">
        <GalleryImage item={item} key={item.path} />
      </div>
      <div className="finder-gallery-caption">
        <div><strong>{item.name}</strong><p>{item.type === 'directory' ? formatFolderCount(item) : `${itemType(item)} · ${formatBytes(item.size)}`}</p></div>
        <div className="finder-gallery-actions">
          <button type="button" onClick={() => actions.open(item)}><FiEye aria-hidden="true" /> Ouvrir</button>
          {item.type === 'file' && <a href={fileProxyUrl(item.path, true)} download aria-label={`Télécharger ${item.name}`}><FiDownload aria-hidden="true" /></a>}
          <EntryMenuButton item={item} siblings={items} actions={actions} />
        </div>
      </div>
      {!preferences.showFilmstrip && <nav className="finder-gallery-pager" aria-label="Parcourir la galerie">
        <button type="button" disabled={index === 0} onClick={() => actions.select(items[index - 1], items)}>Vignette précédente</button>
        <span>{index + 1} / {items.length}</span>
        <button type="button" disabled={index === items.length - 1} onClick={() => actions.select(items[index + 1], items)}>Vignette suivante</button>
      </nav>}
      {preferences.showFilmstrip && <ul className={`finder-filmstrip finder-filmstrip-${preferences.galleryThumbSize}`} data-finder-group aria-label="Vignettes de la galerie">
        {items.map((entry) => (
          <li key={entry.path}>
            <EntryButton item={entry} current={entry.path === item.path} siblings={items} actions={actions} layout="gallery">
              <ItemVisual item={entry} size={35} thumbnails={preferences.showIconPreview} /> <span title={entry.name}>{actions.displayName(entry)}</span>
            </EntryButton>
          </li>
        ))}
      </ul>}
    </div>
  );
}
