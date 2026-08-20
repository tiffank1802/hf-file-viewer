import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FiArrowRight,
  FiCommand,
  FiHeart,
  FiLoader,
  FiSearch,
  FiWifiOff,
  FiX,
} from 'react-icons/fi';
import { FEATURED_SPACES } from '../config';
import {
  applyFolderCounts,
  formatBytes,
  formatCount,
  getName,
  normalizeBucketItem,
  searchItems,
} from '../utils/files';
import { FileTypeIcon } from './Icons';

export default function SearchPalette({
  open,
  mode = 'search',
  onClose,
  onNavigate,
  onOpenFile,
  favoriteItems,
  catalog,
}) {
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setQuery('');
    document.body.classList.add('modal-open');
    window.requestAnimationFrame(() => inputRef.current?.focus());

    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.classList.remove('modal-open');
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  const counts = catalog?.counts;
  const indexItems = useMemo(
    () => applyFolderCounts(catalog?.items ?? [], counts),
    [catalog?.items, counts],
  );

  const featuredItems = useMemo(
    () =>
      applyFolderCounts(
        FEATURED_SPACES.map((space) => normalizeBucketItem({ type: 'directory', path: space.path })),
        counts,
      ),
    [counts],
  );

  const baseItems = mode === 'favorites' ? favoriteItems : indexItems;
  const results = useMemo(() => {
    if (!query.trim()) {
      if (mode === 'favorites') return favoriteItems;
      return featuredItems;
    }
    return applyFolderCounts(searchItems(baseItems, query, 45), counts);
  }, [baseItems, counts, favoriteItems, featuredItems, mode, query]);

  if (!open) return null;

  const chooseItem = (item) => {
    if (item.type === 'directory') onNavigate(item.path);
    else onOpenFile(item);
    onClose();
  };

  return (
    <div className="search-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="search-palette" role="dialog" aria-modal="true" aria-labelledby="search-title">
        <div className="search-input-row">
          <FiSearch aria-hidden="true" />
          <label className="sr-only" htmlFor="global-search">Recherche globale</label>
          <input
            ref={inputRef}
            id="global-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={mode === 'favorites' ? 'Filtrer mes favoris…' : 'Rechercher un cours, un fichier, un semestre…'}
            autoComplete="off"
          />
          {query && <button type="button" onClick={() => setQuery('')} aria-label="Effacer"><FiX aria-hidden="true" /></button>}
          <kbd>ESC</kbd>
        </div>

        <div className="search-palette-heading">
          <div>
            {mode === 'favorites' ? <FiHeart aria-hidden="true" /> : <FiCommand aria-hidden="true" />}
            <h2 id="search-title">
              {query ? `Résultats pour « ${query} »` : mode === 'favorites' ? 'Mes favoris' : 'Accès rapides'}
            </h2>
          </div>
          <span>
            {catalog?.loading && <><FiLoader className="spinning" aria-hidden="true" /> Indexation…</>}
            {!catalog?.loading && catalog?.source === 'fallback' && <><FiWifiOff aria-hidden="true" /> Index local</>}
            {!catalog?.loading && catalog?.source !== 'fallback' && `${formatCount(indexItems.length)} éléments indexés`}
          </span>
        </div>

        <div className="search-results">
          {results.length ? results.map((item) => (
            <button type="button" className="search-result" key={item.path} onClick={() => chooseItem(item)}>
              <span className={`search-result-icon kind-${item.kind}`}><FileTypeIcon kind={item.kind} size={21} /></span>
              <span className="search-result-copy">
                <strong>{item.name || getName(item.path)}</strong>
                <small>{item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : 'Racine de la bibliothèque'}</small>
              </span>
              <span className="search-result-meta">
                {item.type === 'directory'
                  ? Number.isFinite(Number(item.count))
                    ? `${formatCount(item.count)} ressources`
                    : catalog?.loading ? 'Indexation…' : ''
                  : formatBytes(item.size)}
              </span>
              <FiArrowRight className="result-arrow" aria-hidden="true" />
            </button>
          )) : (
            <div className="search-empty">
              <span><FiSearch aria-hidden="true" /></span>
              <h3>{mode === 'favorites' && !favoriteItems.length ? 'Aucun favori pour le moment' : 'Aucun résultat trouvé'}</h3>
              <p>{mode === 'favorites' && !favoriteItems.length ? 'Ajoutez un document avec l’icône cœur pour le retrouver ici.' : 'Essayez un mot plus court ou le nom d’une matière.'}</p>
            </div>
          )}
        </div>

        <footer className="search-footer">
          <span><kbd>↵</kbd> ouvrir</span>
          <span><kbd>esc</kbd> fermer</span>
          <em>Recherche locale dans l’index mis en cache</em>
        </footer>
      </section>
    </div>
  );
}
