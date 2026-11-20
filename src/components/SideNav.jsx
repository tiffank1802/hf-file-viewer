import { FiClock, FiDownload, FiHeart, FiInfo, FiSearch, FiSliders, FiSmartphone } from 'react-icons/fi';
import { SIDE_LINKS } from '../config';
import { isTauriRuntime } from '../utils/runtime';
import { NavigationIcon } from './Icons';
import FolderIcon from './explorer/FolderIcon';
import PinnedFolders from './explorer/PinnedFolders';

function isActiveLink(currentPath, linkPath) {
  if (!linkPath) return currentPath === '';
  return currentPath === linkPath || currentPath.startsWith(`${linkPath}/`);
}

export default function SideNav({
  path,
  navigate,
  favoriteCount,
  onOpenSearch,
  onOpenFavorites,
  onOpenDownload,
  spaces = [],
  pinned = [],
  onMovePinned,
  recentCount = 0,
  searches = [],
  onOpenRecent,
  onOpenTag,
  tags = [],
  onOpenSaved,
}) {
  // Dossiers présents dans le bucket mais absents des liens fixes : ils
  // apparaissent ici dès que l’index les découvre.
  const otherSpaces = spaces.filter((space) => space.dynamic);
  const inTauri = isTauriRuntime();

  return (
    <aside className="library-sidebar finder-sidebar glass-panel" aria-label="Navigation de la bibliothèque">
      <div className="sidebar-section sidebar-locations">
        <span className="sidebar-label">Emplacements</span>
        <nav className="sidebar-links" aria-label="Emplacements">
          {SIDE_LINKS.map((link) => (
            <button
              type="button"
              key={link.path || 'home'}
              className={isActiveLink(path, link.path) ? 'active' : ''}
              aria-current={path === link.path ? 'page' : undefined}
              onClick={() => navigate(link.path)}
            >
              <span>{link.path ? <FolderIcon size={24} /> : <NavigationIcon name={link.icon} />}</span>
              {link.label}
            </button>
          ))}
        </nav>
      </div>

      {otherSpaces.length > 0 && (
        <div className="sidebar-section sidebar-locations">
          <span className="sidebar-label">Autres dossiers</span>
          <nav className="sidebar-links" aria-label="Autres dossiers">
            {otherSpaces.map((space) => (
              <button
                type="button"
                key={space.path}
                className={isActiveLink(path, space.path) ? 'active' : ''}
                aria-current={path === space.path ? 'page' : undefined}
                onClick={() => navigate(space.path)}
              >
                <span><FolderIcon size={24} /></span>
                {space.title}
              </button>
            ))}
          </nav>
        </div>
      )}

      <div className="sidebar-section sidebar-personal">
        <span className="sidebar-label">Mon espace</span>
        <button className="sidebar-utility" type="button" onClick={onOpenFavorites}>
          <span><FiHeart aria-hidden="true" /></span>
          Mes favoris
          <em>{favoriteCount}</em>
        </button>
        <button className="sidebar-utility" type="button" onClick={onOpenRecent}>
          <span><FiClock aria-hidden="true" /></span>
          Récents
          {recentCount > 0 && <em>{recentCount}</em>}
        </button>
        <button className="sidebar-utility" type="button" onClick={onOpenSearch}>
          <span><FiSearch aria-hidden="true" /></span>
          Recherche globale
        </button>
        <PinnedFolders folders={pinned} path={path} navigate={navigate} onMove={onMovePinned} />
        {onOpenDownload && (
          <button className="sidebar-utility sidebar-utility--app" type="button" onClick={onOpenDownload}>
            <span>{inTauri ? <FiSmartphone aria-hidden="true" /> : <FiDownload aria-hidden="true" />}</span>
            {inTauri ? 'Autres appareils' : 'Télécharger l’app'}
            {!inTauri && <em className="sidebar-app-badge">App</em>}
          </button>
        )}
      </div>

      <div className="sidebar-section sidebar-tags">
        <span className="sidebar-label">Tags</span>
        <nav className="sidebar-links finder-personal-list" aria-label="Tags">
          {tags.map((tag) => <button type="button" key={tag.id} onClick={() => onOpenTag(tag.id)}>
            <span><i className="finder-tag-dot" style={{ background: tag.color }} aria-hidden="true" /></span><span>{tag.label}</span>
          </button>)}
        </nav>
      </div>
      {searches.length > 0 && <div className="sidebar-section sidebar-saved">
        <span className="sidebar-label">Dossiers intelligents</span>
        <nav className="sidebar-links finder-personal-list" aria-label="Dossiers intelligents">
          {searches.map((entry) => <button type="button" key={entry.id} title={entry.label} onClick={() => onOpenSaved(entry)}>
            <span><FiSliders aria-hidden="true" /></span><span>{entry.label}</span>
          </button>)}
        </nav>
      </div>}

      <div className="partner-card">
        <div className="partner-logos">
          <img className="partner-enspy" src="/assets/enspy.png" alt="Logo ENSPY" />
          <span aria-hidden="true">×</span>
          <img className="partner-flag" src="/assets/cameroon-flag.svg" alt="Drapeau du Cameroun" />
        </div>
        <strong>Ponts entre campus</strong>
        <p>Un projet étudiant pour faciliter le partage et la réussite.</p>
        <button
          className="partner-about-button"
          type="button"
          onClick={() => document.getElementById('about')?.scrollIntoView({ behavior: 'smooth' })}
        >
          <FiInfo aria-hidden="true" /> En savoir plus
        </button>
      </div>
    </aside>
  );
}
