import { FiArrowUpRight } from 'react-icons/fi';
import { FEATURED_SPACES } from '../config';
import { formatCount } from '../utils/files';
import { NavigationIcon } from './Icons';

export default function CategoryGrid({ navigate, prefetch }) {
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
        {FEATURED_SPACES.map((space, index) => (
          <button
            className={`category-card category-${space.tone}`}
            type="button"
            key={space.path}
            onClick={() => navigate(space.path)}
            onMouseEnter={() => prefetch(space.path)}
            onFocus={() => prefetch(space.path)}
          >
            <span className="category-index">0{index + 1}</span>
            <span className="category-icon"><NavigationIcon name={space.icon} size={24} /></span>
            <span className="category-copy">
              <strong>{space.title}</strong>
              <small>{space.description}</small>
            </span>
            <span className="category-meta">
              {formatCount(space.count)} ressources
              <span><FiArrowUpRight aria-hidden="true" /></span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
