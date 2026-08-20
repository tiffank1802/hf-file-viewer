import { useMemo, useState } from 'react';
import {
  FiAlertCircle,
  FiArrowLeft,
  FiCheckCircle,
  FiChevronRight,
  FiExternalLink,
  FiFolder,
  FiGrid,
  FiList,
  FiRefreshCw,
  FiWifiOff,
} from 'react-icons/fi';
import { huggingFaceFolderUrl } from '../services/api';
import {
  applyFolderCounts,
  getBreadcrumbs,
  getName,
  parentPath,
  sortItems,
} from '../utils/files';
import FileItem from './FileItem';

function LoadingGrid({ view }) {
  return (
    <div className={`files-container ${view === 'list' ? 'list-view' : 'grid-view'}`} aria-label="Chargement des documents">
      {Array.from({ length: view === 'list' ? 7 : 8 }, (_, index) => (
        <div className={`file-skeleton ${view === 'list' ? 'row-skeleton' : ''}`} key={index}>
          <span />
          <div><i /><i /></div>
        </div>
      ))}
    </div>
  );
}

export default function Explorer({
  library,
  catalog,
  onOpenFile,
  favorites,
  onToggleFavorite,
}) {
  const [view, setView] = useState('grid');
  const [sortBy, setSortBy] = useState('name');
  const breadcrumbs = useMemo(() => getBreadcrumbs(library.path), [library.path]);
  const sortedItems = useMemo(
    () => applyFolderCounts(sortItems(library.items, sortBy), catalog?.counts),
    [library.items, sortBy, catalog?.counts],
  );
  const folderCount = library.items.filter((item) => item.type === 'directory').length;
  const fileCount = library.items.length - folderCount;
  const title = library.path ? getName(library.path) : 'Toute la bibliothèque';
  const cacheHit = ['HIT', 'KV-HIT', 'BROWSER'].includes(library.cacheStatus);

  return (
    <section className="explorer-panel glass-panel" aria-labelledby="explorer-title">
      <div className="explorer-header">
        <nav className="breadcrumbs" aria-label="Fil d’Ariane">
          {breadcrumbs.map((crumb, index) => (
            <span key={crumb.path || 'root'}>
              {index > 0 && <FiChevronRight aria-hidden="true" />}
              <button
                type="button"
                onClick={() => library.navigate(crumb.path, { scroll: false })}
                aria-current={index === breadcrumbs.length - 1 ? 'page' : undefined}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>

        <div className="explorer-title-row">
          <div className="explorer-title-wrap">
            {library.path && (
              <button
                className="back-button"
                type="button"
                onClick={() => library.navigate(parentPath(library.path), { scroll: false })}
                aria-label="Dossier précédent"
              >
                <FiArrowLeft aria-hidden="true" />
              </button>
            )}
            <div>
              <h2 id="explorer-title">{title}</h2>
              <p>
                {library.loading
                  ? 'Connexion à la bibliothèque…'
                  : `${folderCount ? `${folderCount} dossier${folderCount > 1 ? 's' : ''}` : ''}${folderCount && fileCount ? ' · ' : ''}${fileCount ? `${fileCount} fichier${fileCount > 1 ? 's' : ''}` : ''}${!folderCount && !fileCount ? 'Aucun élément' : ''}`}
              </p>
            </div>
          </div>

          <div className={`source-status ${library.source === 'fallback' ? 'is-offline' : ''}`}>
            {library.source === 'fallback' ? <FiWifiOff aria-hidden="true" /> : <FiCheckCircle aria-hidden="true" />}
            <span>
              <strong>{library.source === 'fallback' ? 'Aperçu local' : cacheHit ? 'Cache actif' : 'À jour'}</strong>
              <small>{library.source === 'fallback' ? 'API indisponible' : cacheHit ? 'Servi sans appel HF' : 'Synchronisé avec HF'}</small>
            </span>
          </div>
        </div>

        <div className="explorer-toolbar">
          <div className="toolbar-left">
            <span className="content-label"><FiFolder aria-hidden="true" /> Contenu</span>
            <a href={huggingFaceFolderUrl(library.path)} target="_blank" rel="noreferrer">
              Voir la source <FiExternalLink aria-hidden="true" />
            </a>
          </div>
          <div className="toolbar-right">
            <label className="sort-control">
              <span>Trier par</span>
              <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                <option value="name">Nom</option>
                <option value="date">Ajout récent</option>
                <option value="size">Taille</option>
              </select>
            </label>
            <div className="view-toggle" aria-label="Mode d’affichage">
              <button
                type="button"
                className={view === 'grid' ? 'active' : ''}
                onClick={() => setView('grid')}
                aria-label="Affichage en grille"
                aria-pressed={view === 'grid'}
              >
                <FiGrid aria-hidden="true" />
              </button>
              <button
                type="button"
                className={view === 'list' ? 'active' : ''}
                onClick={() => setView('list')}
                aria-label="Affichage en liste"
                aria-pressed={view === 'list'}
              >
                <FiList aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {library.error && (
        <div className="offline-banner" role="status">
          <FiAlertCircle aria-hidden="true" />
          <p><strong>Le service distant ne répond pas.</strong> Les éléments disponibles sont affichés en mode aperçu.</p>
          <button type="button" onClick={library.retry}><FiRefreshCw aria-hidden="true" /> Réessayer</button>
        </div>
      )}

      <div className="explorer-content">
        {view === 'list' && !library.loading && sortedItems.length > 0 && (
          <div className="list-head" aria-hidden="true">
            <span>Nom</span><span>Modification</span><span>Taille</span><span />
          </div>
        )}
        {library.loading ? (
          <LoadingGrid view={view} />
        ) : sortedItems.length ? (
          <div className={`files-container ${view === 'list' ? 'list-view' : 'grid-view'}`}>
            {sortedItems.map((item) => (
              <FileItem
                key={item.path}
                item={item}
                view={view}
                onOpen={onOpenFile}
                onNavigate={(path) => library.navigate(path, { scroll: false })}
                favorite={favorites.includes(item.path)}
                onToggleFavorite={onToggleFavorite}
                indexing={Boolean(catalog?.loading)}
              />
            ))}
          </div>
        ) : (
          <div className="empty-folder">
            <span><FiFolder aria-hidden="true" /></span>
            <h3>Ce dossier semble vide</h3>
            <p>Il n’y a pas encore de ressource visible ici, ou la connexion est interrompue.</p>
            <button type="button" onClick={() => library.navigate(parentPath(library.path), { scroll: false })}>
              <FiArrowLeft aria-hidden="true" /> Revenir au dossier précédent
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
