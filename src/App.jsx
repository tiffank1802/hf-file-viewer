import { useCallback, useEffect, useState } from 'react';
import { FiHeart, FiHome, FiSearch } from 'react-icons/fi';
import CategoryGrid from './components/CategoryGrid';
import Explorer from './components/Explorer';
import Footer from './components/Footer';
import Header from './components/Header';
import Hero from './components/Hero';
import PreviewModal from './components/PreviewModal';
import SearchPalette from './components/SearchPalette';
import SideNav from './components/SideNav';
import AuthPanel from './components/AuthPanel';
import CloudflareAnalytics from './components/CloudflareAnalytics';
import { useLibrary } from './hooks/useLibrary';
import { useIndexCatalog } from './hooks/useIndexCatalog';
import { useAuth } from './hooks/useAuth';
import { useFavorites } from './hooks/useFavorites';
import './index.css';

export default function App() {
  const library = useLibrary();
  const catalog = useIndexCatalog();
  const auth = useAuth();
  const [selectedFile, setSelectedFile] = useState(null);
  const [searchState, setSearchState] = useState({ open: false, mode: 'search' });
  const [authPanel, setAuthPanel] = useState({ open: false, mode: 'signin' });
  const favorites = useFavorites(auth.user);
  const favoriteItems = favorites.items;
  const favoritePaths = favorites.paths;

  const openSearch = useCallback((mode = 'search') => {
    setSearchState({ open: true, mode });
  }, []);
  const closeSearch = useCallback(() => {
    setSearchState((current) => ({ ...current, open: false }));
  }, []);
  const closePreview = useCallback(() => setSelectedFile(null), []);

  const toggleFavorite = favorites.toggle;

  // Une écriture de favori refusée ne doit pas rester muette : le compte est la
  // seule source, donc un cœur qui revient en arrière s'explique à l'écran.
  const favoritesAlert = favorites.sync.actionError
    || (['write-failed', 'forbidden', 'read-failed', 'unprovisioned', 'import']
      .includes(favorites.sync.state) ? favorites.sync.error : null);
  const favoritesAlertKey = favoritesAlert ? `${favorites.sync.state}::${favoritesAlert}` : null;
  const [dismissedAlertKey, setDismissedAlertKey] = useState(null);
  const openAuth = useCallback((mode = 'signin') => setAuthPanel({ open: true, mode }), []);
  const closeAuth = useCallback(() => setAuthPanel((current) => ({ ...current, open: false })), []);

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

      <Header
        navigate={library.navigate}
        onOpenSearch={() => openSearch('search')}
        onOpenAuth={openAuth}
        onOpenFavorites={() => openSearch('favorites')}
        favoriteCount={favoriteItems.length}
      />

      <main id="main-content">
        {favoritesAlertKey && favoritesAlertKey !== dismissedAlertKey && (
          <div className="favorites-alert" role="alert">
            <p>
              <strong>Favoris&nbsp;:</strong> {favoritesAlert}
            </p>
            <span className="favorites-alert-actions">
              <button type="button" onClick={() => void favorites.sync.retry()}>Réessayer</button>
              <button type="button" onClick={() => openAuth('profile')}>Voir le compte</button>
              <button type="button" aria-label="Masquer cet avertissement" onClick={() => { favorites.sync.clearActionError(); setDismissedAlertKey(favoritesAlertKey); }}>×&nbsp;<span className="sr-only">fermer</span></button>
            </span>
          </div>
        )}
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

      <AuthPanel
        open={authPanel.open}
        mode={authPanel.mode}
        onModeChange={(mode) => setAuthPanel({ open: true, mode })}
        onClose={closeAuth}
        favorites={favorites}
      />

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
