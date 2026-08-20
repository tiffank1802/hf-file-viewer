import { useCallback, useEffect, useMemo, useState } from 'react';
import { FiHeart, FiHome, FiSearch } from 'react-icons/fi';
import CategoryGrid from './components/CategoryGrid';
import Explorer from './components/Explorer';
import Footer from './components/Footer';
import Header from './components/Header';
import Hero from './components/Hero';
import PreviewModal from './components/PreviewModal';
import SearchPalette from './components/SearchPalette';
import SideNav from './components/SideNav';
import CloudflareAnalytics from './components/CloudflareAnalytics';
import { useLibrary } from './hooks/useLibrary';
import { useIndexCatalog } from './hooks/useIndexCatalog';
import { useLocalStorage } from './hooks/useLocalStorage';
import './index.css';

export default function App() {
  const library = useLibrary();
  const catalog = useIndexCatalog();
  const [selectedFile, setSelectedFile] = useState(null);
  const [searchState, setSearchState] = useState({ open: false, mode: 'search' });
  const [storedFavorites, setStoredFavorites] = useLocalStorage('enise-docs:favorites', []);

  const favoriteItems = useMemo(
    () => (Array.isArray(storedFavorites) ? storedFavorites.filter((item) => item && typeof item === 'object' && item.path) : []),
    [storedFavorites],
  );
  const favoritePaths = useMemo(() => favoriteItems.map((item) => item.path), [favoriteItems]);

  const openSearch = useCallback((mode = 'search') => {
    setSearchState({ open: true, mode });
  }, []);
  const closeSearch = useCallback(() => {
    setSearchState((current) => ({ ...current, open: false }));
  }, []);
  const closePreview = useCallback(() => setSelectedFile(null), []);

  const toggleFavorite = useCallback((item) => {
    setStoredFavorites((current) => {
      const items = Array.isArray(current) ? current.filter((entry) => entry && typeof entry === 'object') : [];
      if (items.some((entry) => entry.path === item.path)) {
        return items.filter((entry) => entry.path !== item.path);
      }
      return [...items, item];
    });
  }, [setStoredFavorites]);

  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target;
      const isTyping = target instanceof HTMLElement && (
        target.matches('input, textarea, select') || target.isContentEditable
      );
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch('search');
      } else if (event.key === '/' && !isTyping) {
        event.preventDefault();
        openSearch('search');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openSearch]);

  const selectedIsFavorite = selectedFile ? favoritePaths.includes(selectedFile.path) : false;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Aller au contenu</a>
      <div className="page-aurora" aria-hidden="true">
        <span className="aurora-green" />
        <span className="aurora-yellow" />
        <span className="aurora-red" />
      </div>

      <Header navigate={library.navigate} onOpenSearch={() => openSearch('search')} />

      <main id="main-content">
        {library.path === '' && (
          <>
            <Hero onOpenSearch={() => openSearch('search')} navigate={library.navigate} catalog={catalog} />
            <CategoryGrid navigate={library.navigate} prefetch={library.prefetch} catalog={catalog} />
          </>
        )}

        <section className={`library-section ${library.path ? 'library-section-subpage' : ''}`} id="library" aria-label="Explorateur de documents">
          {library.path === '' && (
            <div className="section-heading-row library-intro">
              <div>
                <span className="section-kicker">La bibliothèque</span>
                <h2>Explorez toutes les ressources</h2>
              </div>
              <p>Naviguez par année, semestre ou matière. Ouvrez un aperçu avant de télécharger.</p>
            </div>
          )}
          <div className="library-layout">
            <SideNav
              path={library.path}
              navigate={library.navigate}
              favoriteCount={favoriteItems.length}
              onOpenSearch={() => openSearch('search')}
              onOpenFavorites={() => openSearch('favorites')}
            />
            <Explorer
              library={library}
              catalog={catalog}
              onOpenFile={setSelectedFile}
              favorites={favoritePaths}
              onToggleFavorite={toggleFavorite}
            />
          </div>
        </section>
      </main>

      <Footer />

      <nav className="mobile-bottom-nav" aria-label="Navigation mobile">
        <button type="button" className={!library.path ? 'active' : ''} onClick={() => library.navigate('', { scroll: false })}>
          <FiHome aria-hidden="true" /><span>Accueil</span>
        </button>
        <button type="button" onClick={() => openSearch('search')}>
          <FiSearch aria-hidden="true" /><span>Recherche</span>
        </button>
        <button type="button" onClick={() => openSearch('favorites')}>
          <span className="mobile-favorite-icon"><FiHeart aria-hidden="true" />{favoriteItems.length > 0 && <i>{favoriteItems.length}</i>}</span>
          <span>Favoris</span>
        </button>
      </nav>

      <SearchPalette
        open={searchState.open}
        mode={searchState.mode}
        onClose={closeSearch}
        onNavigate={library.navigate}
        onOpenFile={setSelectedFile}
        favoriteItems={favoriteItems}
        catalog={catalog}
      />

      <CloudflareAnalytics />
      <PreviewModal
        file={selectedFile}
        onClose={closePreview}
        favorite={selectedIsFavorite}
        onToggleFavorite={toggleFavorite}
      />
    </div>
  );
}
