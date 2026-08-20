import { FiHeart, FiInfo, FiSearch } from 'react-icons/fi';
import { SIDE_LINKS } from '../config';
import { NavigationIcon } from './Icons';

function isActiveLink(currentPath, linkPath) {
  if (!linkPath) return currentPath === '';
  return currentPath === linkPath || currentPath.startsWith(`${linkPath}/`);
}

export default function SideNav({ path, navigate, favoriteCount, onOpenSearch, onOpenFavorites }) {
  return (
    <aside className="library-sidebar glass-panel" aria-label="Navigation de la bibliothèque">
      <div className="sidebar-section">
        <span className="sidebar-label">Explorer</span>
        <nav className="sidebar-links">
          {SIDE_LINKS.map((link) => (
            <button
              type="button"
              key={link.path || 'home'}
              className={isActiveLink(path, link.path) ? 'active' : ''}
              onClick={() => navigate(link.path)}
            >
              <span><NavigationIcon name={link.icon} /></span>
              {link.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="sidebar-section sidebar-personal">
        <span className="sidebar-label">Mon espace</span>
        <button className="sidebar-utility" type="button" onClick={onOpenFavorites}>
          <span><FiHeart aria-hidden="true" /></span>
          Mes favoris
          <em>{favoriteCount}</em>
        </button>
        <button className="sidebar-utility" type="button" onClick={onOpenSearch}>
          <span><FiSearch aria-hidden="true" /></span>
          Recherche globale
        </button>
      </div>

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
