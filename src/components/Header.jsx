import { useEffect, useState } from 'react';
import {
  FiExternalLink,
  FiMenu,
  FiSearch,
  FiUploadCloud,
  FiX,
} from 'react-icons/fi';
import { BUCKET_URL } from '../config';

export default function Header({ navigate, onOpenSearch }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const goTo = (path) => {
    navigate(path, { scroll: path !== '' });
    if (!path) window.scrollTo({ top: 0, behavior: 'smooth' });
    setMenuOpen(false);
  };

  const scrollToAbout = () => {
    document.getElementById('about')?.scrollIntoView({ behavior: 'smooth' });
    setMenuOpen(false);
  };

  return (
    <header className={`site-header ${scrolled ? 'is-scrolled' : ''}`}>
      <div className="header-inner">
        <button className="brand" type="button" onClick={() => goTo('')} aria-label="Retour à l’accueil">
          <img
            className="brand-logo"
            src="/assets/centrale-lyon-enise.webp"
            alt="Centrale Lyon ENISE"
          />
          <span className="brand-divider" aria-hidden="true" />
          <span className="product-name">
            <strong>DOCS</strong>
            <small>Bibliothèque étudiante</small>
          </span>
        </button>

        <nav className={`desktop-nav ${menuOpen ? 'mobile-open' : ''}`} aria-label="Navigation principale">
          <button type="button" onClick={() => goTo('')}>Accueil</button>
          <button type="button" onClick={() => goTo('GM')}>Cours</button>
          <button type="button" onClick={() => goTo('TOEIC')}>TOEIC</button>
          <button type="button" onClick={scrollToAbout}>À propos</button>
          <a className="mobile-contribute" href={BUCKET_URL} target="_blank" rel="noreferrer">
            Voir le dépôt <FiExternalLink aria-hidden="true" />
          </a>
        </nav>

        <div className="header-actions">
          <button className="header-search" type="button" onClick={onOpenSearch} aria-label="Rechercher dans la bibliothèque">
            <FiSearch aria-hidden="true" />
            <span>Rechercher</span>
            <kbd>⌘ K</kbd>
          </button>
          <a className="contribute-button" href={BUCKET_URL} target="_blank" rel="noreferrer">
            <FiUploadCloud aria-hidden="true" />
            <span>Contribuer</span>
          </a>
          <img className="header-flag" src="/assets/cameroon-flag.svg" alt="Cameroun" title="Cameroun" />
          <button
            className="menu-button"
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-label={menuOpen ? 'Fermer le menu' : 'Ouvrir le menu'}
          >
            {menuOpen ? <FiX aria-hidden="true" /> : <FiMenu aria-hidden="true" />}
          </button>
        </div>
      </div>
      {menuOpen && <button className="menu-scrim" type="button" onClick={() => setMenuOpen(false)} aria-label="Fermer le menu" />}
    </header>
  );
}
