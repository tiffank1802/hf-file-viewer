import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  FiAlertCircle, FiArrowDown, FiArrowLeft, FiArrowRight, FiArrowUp, FiChevronRight,
  FiColumns, FiExternalLink, FiFolder, FiGrid, FiImage, FiInfo, FiList, FiMoreHorizontal, FiRefreshCw, FiSearch, FiEye,
} from 'react-icons/fi';
import { huggingFaceFolderUrl } from '../services/api';
import { displayExplorerName, selectExplorerItem, SORT_LABELS, sortExplorerItems } from '../utils/explorer';
import { groupExplorerItems } from '../utils/explorerGroups';
import { applyFolderCounts, getBreadcrumbs, getName, parentPath } from '../utils/files';
import EntryActions from './explorer/EntryActions';
import ExplorerTabs from './explorer/ExplorerTabs';
import FinderPreview from './explorer/FinderPreview';
import FinderViewOptions from './explorer/FinderViewOptions';
import FolderActions from './explorer/FolderActions';
import { FINDER_COMMAND_EVENT, sendFinderCommand } from '../utils/finderCommands';
import { ColumnView, GalleryView, IconView, ListView } from './explorer/ExplorerViews';

const VIEWS = [
  { value: 'grid', label: 'Icônes', Icon: FiGrid },
  { value: 'list', label: 'Liste', Icon: FiList },
  { value: 'columns', label: 'Colonnes', Icon: FiColumns },
  { value: 'gallery', label: 'Galerie', Icon: FiImage },
];
const VIEW_LABELS = Object.fromEntries(VIEWS.map(({ value, label }) => [value, label]));
const EMPTY_SELECTION = { paths: new Set(), anchor: null, current: null, item: null };
const EMPTY_EXPANDED = new Set();

function ExplorerContent({ library, catalog, settings, onOpenFile, onReadFile, onOpenSearch, favorites, onToggleFavorite, personal, menuButton }) {
  const { preferences, onSort, setPreference } = settings;
  const [perTab, setPerTab] = useState({});
  const [menu, setMenu] = useState(null);
  const [folderMenu, setFolderMenu] = useState(null);
  const heading = useRef(null);
  const scrollArea = useRef(null);
  const scrollByTab = useRef(new Map());
  const { activeId, path, tabs } = library;
  const tabState = perTab[activeId]?.path === path ? perTab[activeId] : null;
  const selection = tabState?.selection ?? EMPTY_SELECTION;
  const expanded = tabState?.expanded ?? EMPTY_EXPANDED;
  const updateTab = (makePatch, targetPath = path) => setPerTab((previous) => {
    const current = previous[activeId]?.path === targetPath ? previous[activeId] : {};
    return { ...previous, [activeId]: { ...current, path: targetPath, ...makePatch(current) } };
  });
  useEffect(() => {
    setMenu(null);
    setFolderMenu(null);
    setPerTab((previous) => Object.fromEntries(Object.entries(previous).filter(([id, value]) =>
      tabs.some((tab) => tab.id === id && tab.path === value.path))));
    for (const [id, value] of scrollByTab.current) {
      if (!tabs.some((tab) => tab.id === id && tab.path === value.path)) scrollByTab.current.delete(id);
    }
  }, [activeId, path, tabs]);
  useLayoutEffect(() => {
    if (library.loading || !scrollArea.current) return;
    const region = scrollArea.current.querySelector('.finder-column.is-current') || scrollArea.current;
    const saved = scrollByTab.current.get(activeId);
    region.scrollTop = saved?.path === path ? saved.top : 0;
  }, [activeId, library.loading, path, preferences.view]);
  const items = useMemo(() => sortExplorerItems(applyFolderCounts(library.items, catalog?.counts), preferences), [library.items, catalog?.counts, preferences]);
  const groups = useMemo(() => groupExplorerItems(items, ['list', 'grid'].includes(preferences.view) ? preferences.group : 'none', personal?.labels, personal?.tags),
    [items, personal?.labels, personal?.tags, preferences.group, preferences.view]);
  const visibleOrder = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const folderCount = items.filter((item) => item.type === 'directory').length;
  const fileCount = items.length - folderCount;
  const clearSelection = () => updateTab(() => ({ selection: EMPTY_SELECTION }));
  const select = (item, siblings, modifiers = {}, targetPath = path) => {
    const extend = modifiers.shiftKey;
    const toggle = modifiers.metaKey || modifiers.ctrlKey;
    updateTab((previous) => {
      const next = selectExplorerItem(previous.selection ?? EMPTY_SELECTION, siblings.map((entry) => entry.path), item.path, { extend, toggle });
      const active = next.paths.has(item.path) ? item : siblings.find((entry) => next.paths.has(entry.path));
      return { selection: { ...next, current: active?.path ?? null, item: active ?? null } };
    }, targetPath);
  };
  const selectFromColumn = (item, siblings, modifiers, columnPath) => {
    if (item.type === 'directory' || columnPath === path) { select(item, siblings, modifiers); return; }
    // A file selected in a parent column replaces the revealed child branch.
    library.navigate(columnPath, { scroll: false });
    select(item, siblings, modifiers, columnPath);
  };
  const open = (item, { keepFocus = false } = {}) => {
    if (item.type === 'directory') {
      clearSelection();
      if (!keepFocus || window.matchMedia('(max-width: 700px)').matches) heading.current?.focus({ preventScroll: true });
      library.navigate(item.path, { scroll: false });
    } else onOpenFile(item);
  };
  const showActions = (item, siblings, trigger, x, y, info = false) => {
    if (!selection.paths.has(item.path)) select(item, siblings);
    const rect = trigger?.getBoundingClientRect();
    setFolderMenu(null);
    setMenu({ path, activeId, item, trigger, x: x ?? rect?.left, y: y ?? rect?.bottom, info });
  };
  const onExpand = (itemPath) => {
    const next = new Set(expanded);
    if (next.has(itemPath)) {
      for (const entry of next) if (entry === itemPath || entry.startsWith(`${itemPath}/`)) next.delete(entry);
      if ([...selection.paths].some((entry) => entry.startsWith(`${itemPath}/`))) clearSelection();
    } else next.add(itemPath);
    updateTab(() => ({ expanded: next }));
  };
  const actions = { selected: selection.paths, select, selectFromColumn, open, showActions, tagsFor: preferences.showTags ? personal?.tagsFor : undefined,
    preferTouchSelection: preferences.showPreview, displayName: (item) => displayExplorerName(item, preferences.showExtensions) };
  const sharedProps = { folder: library, items: visibleOrder, groups, preferences, actions };
  const selectedItem = selection.paths.has(selection.current) ? selection.item : null;
  const showFolderMenu = (trigger, x, y) => {
    const rect = trigger?.getBoundingClientRect();
    setMenu(null);
    setFolderMenu({ path, activeId, trigger, x: x ?? rect?.left ?? 8, y: y ?? rect?.bottom ?? 8 });
  };
  const command = useEffectEvent((event) => {
    const nativeCommand = event.detail;
    const view = VIEWS.find(({ value }) => nativeCommand === `view-${value}`);
    if (view) { setPreference('view', view.value); return; }
    switch (nativeCommand) {
      case 'preview': setPreference('showPreview', !preferences.showPreview); break;
      case 'sidebar': setPreference('showSidebar', !preferences.showSidebar); break;
      case 'view-options': menuButton.current?.parentElement?.querySelector('.finder-view-options summary')?.click(); break;
      case 'folder-actions': showFolderMenu(menuButton.current); break;
      case 'new-tab': library.addTab(); break;
      case 'close-tab': library.closeTab(); break;
      case 'root': library.navigate(''); document.getElementById('library')?.scrollIntoView(); break;
      case 'parent': if (path) library.navigate(parentPath(path), { scroll: false }); break;
      case 'back': library.goBack(); break;
      case 'forward': library.goForward(); break;
      case 'refresh': library.retry(); break;
      case 'open': if (selectedItem) open(selectedItem); break;
      case 'info':
      case 'entry-actions':
        if (selectedItem) showActions(selectedItem, visibleOrder, document.activeElement, undefined, undefined, nativeCommand === 'info');
        break;
      default: break;
    }
  });
  useEffect(() => {
    const listener = (event) => command(event);
    window.addEventListener(FINDER_COMMAND_EVENT, listener);
    return () => window.removeEventListener(FINDER_COMMAND_EVENT, listener);
  }, []);
  const contextGroups = [
    { label: 'Dossier', items: [
      { label: 'Nouvel onglet', action: () => library.addTab(), disabled: !library.canAddTab },
      { label: 'Dossier parent', action: () => library.navigate(parentPath(path), { scroll: false }), disabled: !path },
      { label: 'Actualiser le dossier', action: library.retry },
      { label: 'Rechercher dans ce dossier', action: () => onOpenSearch(path) },
    ] },
    { label: 'Présentation', items: [
      ...VIEWS.map(({ label, value }) => ({ label, active: preferences.view === value, action: () => setPreference('view', value) })),
      { label: 'Prévisualisation', active: preferences.showPreview, action: () => setPreference('showPreview', !preferences.showPreview) },
      { label: 'Barre latérale', active: preferences.showSidebar, action: () => setPreference('showSidebar', !preferences.showSidebar) },
    ] },
  ];
  const name = path ? getName(path) : 'Toute la bibliothèque';
  const info = library.loading ? 'Chargement…' : `${folderCount} dossier${folderCount === 1 ? '' : 's'} · ${fileCount} fichier${fileCount === 1 ? '' : 's'}`;

  return (
    <>
      <div className="finder-title-line">
        <div><span className="finder-eyebrow"><FiFolder aria-hidden="true" /> Bibliothèque ENISE</span><h2 id="explorer-title" ref={heading} tabIndex={-1}>{name}</h2></div>
        {library.error ? <span className="finder-source is-offline">Aperçu local</span> : !library.loading && <span className="finder-source">Hugging Face</span>}
      </div>
      <div className="finder-navigation" aria-label="Navigation des dossiers">
        <div className="finder-button-group">
          <button type="button" onClick={() => { library.goBack(); }} disabled={!library.canGoBack} title="Précédent" aria-label="Précédent"><FiArrowLeft aria-hidden="true" /></button>
          <button type="button" onClick={() => { library.goForward(); }} disabled={!library.canGoForward} title="Suivant" aria-label="Suivant"><FiArrowRight aria-hidden="true" /></button>
          <button type="button" onClick={() => { library.navigate(parentPath(path), { scroll: false }); }} disabled={!path} title="Dossier parent" aria-label="Dossier parent"><FiArrowUp aria-hidden="true" /></button>
        </div>
        {preferences.showPath && <nav className="finder-path" aria-label="Fil d’Ariane">
          {getBreadcrumbs(path).map((crumb, index) => (
            <span key={crumb.path}>
              {index > 0 && <FiChevronRight aria-hidden="true" />}
              <button type="button" title={crumb.label} aria-current={crumb.path === path ? 'page' : undefined} onClick={() => {
                if (crumb.path !== path) { library.navigate(crumb.path, { scroll: false }); }
              }}>{crumb.label}</button>
            </span>
          ))}
        </nav>}
        <button type="button" className="finder-search-button" onClick={() => onOpenSearch(path)} aria-label="Rechercher depuis ce dossier" title="Rechercher"><FiSearch aria-hidden="true" /><span>Rechercher</span></button>
      </div>
      {library.error && (
        <div className="finder-offline-banner" role="status">
          <FiAlertCircle aria-hidden="true" /><span>Le service distant est indisponible. Seules les ressources locales sont affichées.</span>
          {items.length > 0 && <button type="button" onClick={library.retry}><FiRefreshCw aria-hidden="true" /> Réessayer</button>}
        </div>
      )}
      <div className={`finder-content-layout${preferences.showPreview ? ' finder-with-preview' : ''}`}>
      <div className={`finder-content finder-mode-${preferences.view} finder-text-${preferences.textSize} finder-background-${preferences.background}`} ref={scrollArea} aria-busy={library.loading}
        onContextMenu={(event) => {
          if (event.defaultPrevented || event.target.closest('button, a, input, select, textarea')) return;
          event.preventDefault();
          showFolderMenu(menuButton.current, event.clientX, event.clientY);
        }}
        onScrollCapture={(event) => {
          const region = event.target;
          if (!library.loading && (region === event.currentTarget || region.classList?.contains('is-current'))) {
            scrollByTab.current.set(activeId, { path, top: region.scrollTop });
          }
        }} onKeyDown={(event) => {
        if (event.key === 'Escape' && !menu) clearSelection();
      }}>
        {preferences.view === 'grid' && <IconView {...sharedProps} />}
        {preferences.view === 'list' && <ListView {...sharedProps} {...{ onSort, expanded, onExpand }} key={path} counts={catalog?.counts} reader={library.reader} />}
        {preferences.view === 'columns' && <ColumnView {...sharedProps} {...{ path }} reader={library.reader} counts={catalog?.counts} />}
        {preferences.view === 'gallery' && <GalleryView {...sharedProps} selection={selection} />}
      </div>
      {preferences.showPreview && <FinderPreview item={selectedItem} gallery={preferences.view === 'gallery'} showDetails={preferences.showPreviewDetails}
        onClose={() => { setPreference('showPreview', false); heading.current?.focus({ preventScroll: true }); }} onOpen={open} onRead={onReadFile} />}
      </div>
      {preferences.showStatus && <footer className="finder-status">
        <span role="status">{selection.paths.size ? `${selection.paths.size} sélectionné${selection.paths.size === 1 ? '' : 's'}` : info}</span>
        <div className="finder-status-actions">
          {selectedItem && <>
            <button type="button" onClick={() => open(selectedItem)}>Ouvrir</button>
            <button type="button" aria-label="Lire les informations" title="Lire les informations"
              onClick={(event) => showActions(selectedItem, items, event.currentTarget, undefined, undefined, true)}><FiInfo aria-hidden="true" /></button>
            <button type="button" aria-label="Actions de la sélection" aria-haspopup="dialog" title="Actions"
              onClick={(event) => showActions(selectedItem, items, event.currentTarget)}><FiMoreHorizontal aria-hidden="true" /></button>
          </>}
          <a href={huggingFaceFolderUrl(path)} target="_blank" rel="noreferrer" title="Voir la source sur Hugging Face"><FiExternalLink aria-hidden="true" /> Source</a>
        </div>
      </footer>}
      {menu?.path === path && menu.activeId === activeId && <EntryActions menu={menu} favorite={favorites.includes(menu.item.path)} onToggleFavorite={onToggleFavorite}
        onOpen={open} onOpenInTab={library.canAddTab ? (item) => library.addTab(item.path) : undefined} onClose={() => setMenu(null)} tags={personal?.tagsFor(menu.item.path)} onToggleTag={personal?.toggleTag} onAttachTag={personal?.attachTag} canCreateTag={personal?.canCreateTag} />}
      {folderMenu?.path === path && folderMenu.activeId === activeId && <FolderActions anchor={folderMenu} groups={contextGroups} heading="Actions du dossier" onClose={() => setFolderMenu(null)} />}
    </>
  );
}

export default function Explorer(props) {
  const { settings, library } = props;
  const { preferences, setPreference, onSort } = settings;
  const menuButton = useRef(null);
  return (
    <section className="explorer-panel finder-panel glass-panel" aria-labelledby="explorer-title">
      <div className="finder-toolbar" aria-label="Ruban de l’explorateur">
        <div className="finder-ribbon-group" role="group" aria-label="Mode d’affichage">
          <span className="finder-ribbon-label" aria-hidden="true">Affichage</span>
          <div className="finder-button-group finder-views">
          {VIEWS.map(({ value, label, Icon }) => (
            <button type="button" key={value} aria-pressed={preferences.view === value} title={label} aria-label={`Affichage : ${label}`} onClick={() => setPreference('view', value)}>
              <Icon aria-hidden="true" /><span>{label}</span>
            </button>
          ))}
          </div>
        </div>
        <div className="finder-ribbon-group" role="group" aria-label="Classement">
          <span className="finder-ribbon-label" aria-hidden="true">Classement</span>
          <div className="finder-preferences">
          <select value={preferences.sort} aria-label="Trier par" onChange={(event) => onSort(event.target.value)}>
            {Object.entries(SORT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button type="button" className="finder-sort-direction" title={preferences.direction === 'asc' ? 'Tri croissant : inverser' : 'Tri décroissant : inverser'}
            aria-label={preferences.direction === 'asc' ? 'Tri croissant : inverser' : 'Tri décroissant : inverser'} onClick={() => onSort(preferences.sort)}>
            {preferences.direction === 'asc' ? <FiArrowUp aria-hidden="true" /> : <FiArrowDown aria-hidden="true" />}
          </button>
          </div>
        </div>
        <div className="finder-ribbon-group" role="group" aria-label="Présentation et actions">
          <span className="finder-ribbon-label" aria-hidden="true">Présentation</span>
          <div className="finder-preferences">
          {preferences.view === 'grid' && <select value={preferences.iconSize} aria-label="Taille des icônes" title="Taille des icônes" onChange={(event) => setPreference('iconSize', event.target.value)}>
            <option value="small">Petites</option><option value="medium">Moyennes</option><option value="large">Grandes</option>
          </select>}
          <button type="button" className="finder-sort-direction finder-preview-toggle" aria-label="Prévisualisation"
            aria-pressed={preferences.showPreview} title={preferences.showPreview ? 'Masquer la prévisualisation' : 'Afficher la prévisualisation'}
            onClick={() => setPreference('showPreview', !preferences.showPreview)}><FiEye aria-hidden="true" /></button>
          <FinderViewOptions settings={settings} views={VIEW_LABELS} library={library} />
          <button className="finder-sort-direction" ref={menuButton} type="button" aria-label="Actions du dossier" title="Actions du dossier" aria-haspopup="dialog"
            onClick={() => sendFinderCommand('folder-actions')}><FiMoreHorizontal aria-hidden="true" /></button>
          </div>
        </div>
      </div>
      {(preferences.showTabs || library.tabs.length > 1) && <ExplorerTabs library={library} />}
      <div role={preferences.showTabs || library.tabs.length > 1 ? 'tabpanel' : undefined} id="finder-tab-panel"
        aria-labelledby={preferences.showTabs || library.tabs.length > 1 ? `tab-${library.activeId}` : undefined}>
        <ExplorerContent {...props} menuButton={menuButton} />
      </div>
    </section>
  );
}
