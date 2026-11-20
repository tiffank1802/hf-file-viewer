import { useEffect, useMemo, useRef, useState } from 'react';
import { FiArrowRight, FiClock, FiCommand, FiHeart, FiLoader, FiSearch, FiWifiOff, FiX } from 'react-icons/fi';
import { FEATURED_SPACES } from '../config';
import { applyFolderCounts, formatBytes, formatCount, formatFolderCount, getName, normalizeBucketItem, searchItems } from '../utils/files';
import { DEFAULT_FILTERS, hasExplorerFilters, normalizeFilters, searchExplorerCatalog, TAGS } from '../utils/explorerPersonal';
import { FileTypeIcon } from './Icons';

const EMPTY = [];
const NO_LABELS = new Map();
const KINDS = { folder: 'Dossiers', pdf: 'PDF', office: 'Bureautique', image: 'Images', model: 'CAO et 3D', audio: 'Audio', video: 'Vidéo', text: 'Texte', archive: 'Archives', file: 'Autres fichiers' };

function SearchFilters({ filters, onChange, folders, personal, savedId, setSavedId, canSave, onSave, onRemove }) {
  return (
    <div className="finder-search-filters" role="group" aria-label="Filtres de recherche">
      <select aria-label="Emplacement de recherche" value={filters.folder} onChange={(event) => onChange('folder', event.target.value)}>
        <option value="">Toute la bibliothèque</option>
        {folders.map((folder) => <option key={folder} value={folder}>{getName(folder)} et sous-dossiers</option>)}
      </select>
      <select aria-label="Type de fichier" value={filters.kind} onChange={(event) => onChange('kind', event.target.value)}>
        <option value="">Tous les types</option>{Object.entries(KINDS).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select>
      <select aria-label="Date de modification" value={filters.date} onChange={(event) => onChange('date', event.target.value)}>
        <option value="">Toutes les dates</option><option value="7">7 derniers jours</option><option value="30">30 derniers jours</option><option value="365">12 derniers mois</option>
      </select>
      <select aria-label="Taille du fichier" value={filters.size} onChange={(event) => onChange('size', event.target.value)}>
        <option value="">Toutes les tailles</option><option value="small">Moins de 1 Mo</option><option value="large">1 Mo ou plus</option>
      </select>
      <select aria-label="Tag" value={filters.tag} onChange={(event) => onChange('tag', event.target.value)}>
        <option value="">Tous les tags</option>{TAGS.map((tag) => <option key={tag.id} value={tag.id}>{tag.label}</option>)}
      </select>
      {personal.searches.length > 0 && <select aria-label="Dossiers intelligents" value={savedId} onChange={(event) => setSavedId(event.target.value)}>
        <option value="">Dossiers intelligents…</option>{personal.searches.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </select>}
      {canSave && <button type="button" onClick={onSave}>Enregistrer la recherche</button>}
      {savedId && <button type="button" onClick={onRemove}>Retirer ce dossier intelligent</button>}
    </div>
  );
}

export default function SearchPalette({
  mode = 'search', onClose, onNavigate, onOpenFile, favoriteItems, catalog, library, personal, initialFilters, initialQuery = '', initialSavedId = '',
}) {
  const [query, setQuery] = useState(initialQuery);
  const [filters, setFilters] = useState(() => normalizeFilters(initialFilters));
  const [savedId, setSavedId] = useState(initialSavedId);
  const [saving, setSaving] = useState(false);
  const [label, setLabel] = useState('');
  const [message, setMessage] = useState('');
  const inputRef = useRef(null);
  const resultsRef = useRef(null);
  const saveRef = useRef(null);
  const isSearch = mode === 'search';

  useEffect(() => {
    const originalFocus = document.activeElement;
    document.body.classList.add('modal-open');
    const focusId = window.requestAnimationFrame(() => inputRef.current?.focus());
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusId);
      document.body.classList.remove('modal-open');
      window.removeEventListener('keydown', onKeyDown);
      originalFocus?.focus?.({ preventScroll: true });
    };
  }, [onClose]);

  useEffect(() => { if (saving) saveRef.current?.focus(); }, [saving]);
  const counts = catalog?.counts;
  const indexItems = useMemo(() => {
    const merged = new Map((catalog?.items ?? EMPTY).map((item) => [item.path, item]));
    // The live folder can contain new or empty folders not in the index yet.
    for (const item of library.items) merged.set(item.path, item);
    return [...merged.values()];
  }, [catalog?.items, library.items]);
  const featured = useMemo(() => FEATURED_SPACES.map((space) => normalizeBucketItem({ type: 'directory', path: space.path })), []);
  const labels = personal?.labels ?? NO_LABELS;
  const base = mode === 'favorites' ? favoriteItems : personal.recent;
  const hasFilters = hasExplorerFilters(filters);
  const results = useMemo(() => applyFolderCounts(isSearch
    ? query.trim() || hasFilters ? searchExplorerCatalog(indexItems, query, filters, labels) : featured
    : query.trim() ? searchItems(base, query, 60) : base, counts), [base, counts, featured, filters, hasFilters, indexItems, isSearch, labels, query]);
  const folders = [...new Set([library.path, filters.folder].filter(Boolean))];
  const currentSearch = personal.searches.find((entry) => entry.id === savedId);
  const title = mode === 'favorites' ? 'Mes favoris' : mode === 'recent' ? 'Récents' : currentSearch?.label || (query.trim() ? `Résultats pour « ${query.trim()} »` : hasFilters ? 'Résultats filtrés' : 'Accès rapides');

  const chooseItem = (item) => {
    onClose();
    if (item.type === 'directory') onNavigate(item.path);
    else onOpenFile(item);
  };
  const changeFilter = (key, value) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setSavedId('');
    setMessage('');
  };
  function restoreSearch(id) {
    setSavedId(id);
    const entry = personal.searches.find((search) => search.id === id);
    setQuery(entry?.query ?? '');
    setFilters(entry?.filters ?? DEFAULT_FILTERS);
    setMessage('');
  }
  const emptyText = mode === 'favorites' && !base.length ? 'Aucun favori pour le moment' : mode === 'recent' && !base.length ? 'Aucun élément récent' : 'Aucun résultat trouvé';

  return (
    <div className="search-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="search-palette" role="dialog" aria-modal="true" aria-labelledby="search-title" onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled), input, select, a[href]')].filter((node) => node.getClientRects().length);
        const target = event.shiftKey && event.target === controls[0] ? controls.at(-1) : !event.shiftKey && event.target === controls.at(-1) ? controls[0] : null;
        if (target) { event.preventDefault(); target.focus(); }
      }}>
        <div className="search-input-row">
          <FiSearch aria-hidden="true" />
          <label className="sr-only" htmlFor="global-search">{isSearch ? 'Rechercher dans la bibliothèque' : `Filtrer — ${title}`}</label>
          <input ref={inputRef} id="global-search" value={query} autoComplete="off"
            onChange={(event) => { setQuery(event.target.value); setSavedId(''); setMessage(''); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && results[0]) chooseItem(results[0]);
              if (event.key === 'ArrowDown') resultsRef.current?.querySelector('button')?.focus();
            }}
            placeholder={mode === 'favorites' ? 'Filtrer mes favoris…' : mode === 'recent' ? 'Filtrer les éléments récents…' : 'Rechercher un cours, un fichier, un semestre…'} />
          <button type="button" aria-label="Fermer la recherche" onClick={onClose}><FiX aria-hidden="true" /></button>
        </div>
        {isSearch && <SearchFilters {...{ filters, folders, personal, savedId }} onChange={changeFilter} setSavedId={restoreSearch}
          canSave={!saving && !savedId && Boolean(query.trim() || hasFilters)} onSave={() => { setLabel(query.trim().slice(0, 60)); setSaving(true); }}
          onRemove={() => { personal.removeSearch(savedId); setSavedId(''); setMessage('Dossier intelligent retiré.'); }} />}
        {saving && <form className="finder-search-filters" onSubmit={(event) => {
          event.preventDefault();
          if (!label.trim()) return;
          personal.saveSearch(label, query.trim(), filters);
          setSaving(false);
          setMessage('Dossier intelligent enregistré sur cet appareil.');
          inputRef.current?.focus();
        }}>
          <input ref={saveRef} aria-label="Nom du dossier intelligent" value={label} maxLength={60} onChange={(event) => setLabel(event.target.value)} required />
          <button type="submit">Enregistrer</button><button type="button" onClick={() => { setSaving(false); inputRef.current?.focus(); }}>Annuler</button>
        </form>}
        <div className="search-palette-heading">
          <div>{mode === 'favorites' ? <FiHeart aria-hidden="true" /> : mode === 'recent' ? <FiClock aria-hidden="true" /> : <FiCommand aria-hidden="true" />}<h2 id="search-title">{title}</h2></div>
          {isSearch && <span>
            {catalog?.loading && <><FiLoader className="spinning" aria-hidden="true" /> Indexation…</>}
            {!catalog?.loading && catalog?.source === 'fallback' && <><FiWifiOff aria-hidden="true" /> Index local</>}
            {!catalog?.loading && catalog?.source !== 'fallback' && `${formatCount(indexItems.length)} éléments indexés`}
          </span>}
        </div>
        {message && <p className="finder-search-filters" role="status">{message}</p>}
        <div className="search-results" ref={resultsRef}>
          {results.length ? results.map((item) => (
            <button type="button" className="search-result" key={item.path} onClick={() => chooseItem(item)} onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const next = event.key === 'ArrowDown' ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling || inputRef.current;
                next?.focus();
              }
            }}>
              <span className={`search-result-icon kind-${item.kind}`}><FileTypeIcon kind={item.kind} size={25} /></span>
              <span className="search-result-copy">
                <strong>{item.name || getName(item.path)}</strong>
                <small>{item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : 'Racine de la bibliothèque'}</small>
              </span>
              <span className="search-result-meta">{item.type === 'directory' ? formatFolderCount(item, catalog?.loading) : formatBytes(item.size)}</span>
              <FiArrowRight className="result-arrow" aria-hidden="true" />
            </button>
          )) : (
            <div className="search-empty">
              <span><FiSearch aria-hidden="true" /></span><h3>{emptyText}</h3>
              <p>{mode === 'favorites' && !base.length ? 'Connectez-vous pour retrouver les favoris de votre compte.' : mode === 'recent' && !base.length ? 'Les dossiers et fichiers ouverts apparaîtront ici.' : 'Essayez un autre mot ou retirez un filtre.'}</p>
            </div>
          )}
        </div>
        <footer className="search-footer">
          <span><kbd>↵</kbd> ouvrir</span><span><kbd>esc</kbd> fermer</span>
          <em>{isSearch ? 'Recherche par nom, chemin et métadonnées' : mode === 'recent' ? 'Historique sur cet appareil' : 'Favoris du compte'}</em>
        </footer>
      </section>
    </div>
  );
}
