import { FiArrowUpRight } from 'react-icons/fi';
import { formatCount } from '../utils/files';
import { NavigationIcon } from './Icons';

function spaceCountLabel(catalog, space) {
  if (space?.library) {
    return Number.isFinite(space.count)
      ? `${formatCount(space.count)} ressource${space.count === 1 ? '' : 's'}`
      : 'Toute la bibliothèque';
  }
  if (!catalog || catalog.loading) return 'Indexation…';
  if (!Number.isFinite(space?.count)) return 'Nombre indisponible';
  const value = space.count;
  return `${formatCount(value)} ressource${value === 1 ? '' : 's'}`;
}

export default function CategoryGrid({ navigate, prefetch, catalog, cards = [] }) {
  return (
    <section className="featured-section" aria-labelledby="featured-title">
      <div className="section-heading-row">
        <div>
          <span className="section-kicker">Accès rapide</span>
          <h2 id="featured-title">Choisissez votre espace</h2>
        </div>
        <p>Les parcours les plus consultés, accessibles en un clic.</p>
      </div>
      <div className="category-grid">
        {cards.map((space, index) => (
          <button
            className={`category-card category-${space.tone}`}
            type="button"
            key={space.path || 'library-root'}
            onClick={() => navigate(space.path)}
            onMouseEnter={() => prefetch(space.path)}
            onFocus={() => prefetch(space.path)}
          >
            <span className="category-index">{String(index + 1).padStart(2, '0')}</span>
            {space.badge && <span className="category-badge">{space.badge}</span>}
            <span className="category-icon"><NavigationIcon name={space.icon} size={24} /></span>
            <span className="category-copy">
              <strong>{space.title}</strong>
              <small>{space.description}</small>
            </span>
            <span className="category-meta">
              {spaceCountLabel(catalog, space)}
              <span><FiArrowUpRight aria-hidden="true" /></span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
