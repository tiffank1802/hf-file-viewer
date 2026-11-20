import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FiDownload, FiHeart, FiHome, FiSearch } from 'react-icons/fi';
import AppDownloadModal from './components/AppDownloadModal';
import AppUpdateBanner from './components/AppUpdateBanner';
import CategoryGrid from './components/CategoryGrid';
import Explorer from './components/Explorer';
import Footer from './components/Footer';
import Header from './components/Header';
import Hero from './components/Hero';
import LibraryChat from './components/LibraryChat';
import PreviewModal from './components/PreviewModal';
import { canOpenStructuredReader, readerFileFromRoute } from './reader/route';
import SearchPalette from './components/SearchPalette';
import SideNav from './components/SideNav';
import AuthPanel from './components/AuthPanel';
import CloudflareAnalytics from './components/CloudflareAnalytics';
import { useLibrary } from './hooks/useLibrary';
import { useFinderPreferences } from './hooks/useFinderPreferences';
import { useIndexCatalog } from './hooks/useIndexCatalog';
import { buildHomeCards } from './utils/spaces';
import { useAuth } from './hooks/useAuth';
import { useFavorites } from './hooks/useFavorites';
import { useExplorerPersonal } from './hooks/useExplorerPersonal';
import { getName, normalizeBucketItem } from './utils/files';
import { orderPinnedFolders } from './utils/explorerPersonal';
import { isTauriRuntime } from './utils/runtime';
import './index.css';
import './components/explorer/explorer.css';

const DocumentWorkspace = lazy(() => import('./reader/DocumentWorkspace'));

export default function App() {
  const library = useLibrary();
  const finderSettings = useFinderPreferences(library.path);
  const catalog = useIndexCatalog();
  // Les cartes d’accueil et la barre latérale sont dérivées de l’index et du
  // listage racine (`/api/tree`, l’en-tête du bucket) : un dossier ajouté
  // apparaît sans redéploiement, même s’il est encore vide.
  const home = useMemo(
    () => buildHomeCards(catalog, { rootItems: library.path === '' ? library.items : [] }),
    [catalog, library.path, library.items],
  );
  const [selectedFile, setSelectedFile] = useState(null);
  const [studyFile, setStudyFile] = useState(null);
  const [readerFile, setReaderFile] = useState(() => readerFileFromRoute(window.location.pathname, window.location.search));
  const readerReturnUrl = useRef('/');
  const readerOpenedHere = useRef(false);
  const [searchState, setSearchState] = useState({ open: false, mode: 'search', sequence: 0 });
  const [authPanel, setAuthPanel] = useState({ open: false, mode: 'signin' });
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [dismissedAlertKey, setDismissedAlertKey] = useState(null);
  const inTauri = isTauriRuntime();
  const auth = useAuth();
  const personal = useExplorerPersonal(auth.user?.id);
  const recordRecent = personal.record;
  const authStatus = auth.status;
  const currentPath = library.path;
  const favorites = useFavorites(auth.user);
  const favoriteItems = favorites.items;
  const favoritePaths = favorites.paths;
  const pinned = useMemo(() => orderPinnedFolders(favoriteItems.filter((item) => item.type === 'directory'), personal.pinnedOrder), [favoriteItems, personal.pinnedOrder]);
  const favoritesAlert = favorites.sync.actionError
    || (['write-failed', 'read-failed', 'unprovisioned', 'import', 'disabled'].includes(favorites.sync.state) ? favorites.sync.error : null);
  const favoritesAlertKey = favoritesAlert ? `${favorites.sync.state}::${favoritesAlert}` : null;

  const openSearch = useCallback((mode = 'search', options = {}) => {
    setSearchState((previous) => ({ open: true, mode, sequence: previous.sequence + 1, ...options }));
  }, []);
  const openFile = useCallback((item) => {
    if (authStatus !== 'loading') recordRecent(item);
    setSelectedFile(item);
  }, [authStatus, recordRecent]);

  useEffect(() => {
    if (authStatus !== 'loading' && currentPath) recordRecent({ path: currentPath, name: getName(currentPath), type: 'directory' });
  }, [authStatus, currentPath, recordRecent]);
  const openAuth = useCallback((mode = 'signin') => setAuthPanel({ open: true, mode }), []);
  const closeAuth = useCallback(() => setAuthPanel((current) => ({ ...current, open: false })), []);
  const openDownload = useCallback(() => setDownloadOpen(true), []);
  const closeDownload = useCallback(() => setDownloadOpen(false), []);
  const closeSearch = useCallback(() => {
    setSearchState((current) => ({ ...current, open: false }));
  }, []);
  const closePreview = useCallback(() => setSelectedFile(null), []);
  const studySelectedFile = useCallback((file) => {
    setSelectedFile(null);
    setStudyFile(file);
  }, []);
  const openReader = useCallback((file) => {
    const item = normalizeBucketItem(file);
    if (!item.path || !canOpenStructuredReader(item.path)) return;
    readerReturnUrl.current = `${window.location.pathname}${window.location.search}`;
    const params = new URLSearchParams({ path: item.path });
    if (Number(item.previewPage) > 1) params.set('page', String(item.previewPage));
    window.history.pushState({ reader: true }, '', `/read?${params}`);
    readerOpenedHere.current = true;
    setSelectedFile(null);
    setReaderFile(item);
  }, []);
  const closeReader = useCallback(() => {
    setReaderFile(null);
    if (readerOpenedHere.current) {
      readerOpenedHere.current = false;
      window.history.back();
      return;
    }
    const target = readerReturnUrl.current && !readerReturnUrl.current.startsWith('/read')
      ? readerReturnUrl.current
      : '/';
    window.history.replaceState({}, '', target);
  }, []);

  const toggleFavorite = favorites.toggle;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('recover') === '1') openAuth('recover');
    else if (params.get('verify') === '1') openAuth('signin');
    else if (params.get('download') === '1' || params.get('app') === '1' || window.location.hash === '#download') {
      openDownload();
    }
  }, [openAuth, openDownload]);

  useEffect(() => {
    const onPopState = () => setReaderFile(readerFileFromRoute(window.location.pathname, window.location.search));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.isComposing || searchState.open || authPanel.open || selectedFile || document.querySelector('.finder-dialog[open]')) return;
      const target = event.target;
      const isTyping = target instanceof HTMLElement && (
        target.matches('input, textarea, select') || target.isContentEditable
      );
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch('search');
      } else if (event.key === '/' && !isTyping && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        openSearch('search');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [authPanel.open, openSearch, searchState.open, selectedFile]);

  const selectedIsFavorite = selectedFile ? favoritePaths.includes(selectedFile.path) : false;

  if (readerFile) {
    const params = new URLSearchParams(window.location.search);
    return (
      <>
        <Suspense fallback={<div className="reader-route-loading">Préparation du lecteur interactif…</div>}>
          {/* Discard the previous account's private reader state on account changes. */}
          <DocumentWorkspace
            key={`${readerFile.path}:${auth.user?.id || 'anonymous'}`}
            file={readerFile}
            initialPage={Number(params.get('page')) || Number(readerFile.previewPage) || 1}
            authenticated={auth.isAuthenticated}
            onRequireAuth={() => openAuth('signin')}
            onClose={closeReader}
          />
        </Suspense>
        <AuthPanel
          open={authPanel.open}
          mode={authPanel.mode}
          onModeChange={(mode) => setAuthPanel({ open: true, mode })}
          onClose={closeAuth}
        />
      </>
    );
  }

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
        onOpenDownload={openDownload}
        favoriteCount={favoriteItems.length}
      />

      {favoritesAlertKey && favoritesAlertKey !== dismissedAlertKey && (
        <div className="favorites-alert" role="alert">
          <p><strong>Favoris :</strong> {favoritesAlert}</p>
          <span className="favorites-alert-actions">
            {auth.isAuthenticated ? (
              <button type="button" onClick={() => void favorites.sync.retry()}>Réessayer</button>
            ) : (
              <button type="button" onClick={() => openAuth('signin')}>Se connecter</button>
            )}
            <button type="button" onClick={() => { favorites.sync.clearActionError(); setDismissedAlertKey(favoritesAlertKey); }}>Fermer</button>
          </span>
        </div>
      )}

      <AppUpdateBanner suspended={Boolean(selectedFile || readerFile || studyFile || authPanel.open || searchState.open || downloadOpen)} />
      <main id="main-content">
        {library.path === '' && (
          <>
            <Hero
              onOpenSearch={() => openSearch('search')}
              onOpenDownload={openDownload}
              navigate={library.navigate}
              catalog={catalog}
              spaceCount={home.spaces.length}
            />
            <CategoryGrid
              navigate={library.navigate}
              prefetch={library.prefetch}
              catalog={catalog}
              cards={home.cards}
            />
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
          <div className={`library-layout${finderSettings.preferences.showSidebar ? '' : ' finder-sidebar-hidden'}`}>
            {finderSettings.preferences.showSidebar && <SideNav
              path={library.path}
              navigate={library.navigate}
              favoriteCount={favoriteItems.length}
              onOpenSearch={() => openSearch('search')}
              onOpenFavorites={() => openSearch('favorites')}
              onOpenDownload={openDownload}
              spaces={home.spaces}
              pinned={pinned}
              onMovePinned={(from, to) => personal.movePinned(pinned.map((item) => item.path), from, to)}
              recentCount={personal.recent.length}
              searches={personal.searches}
              onOpenRecent={() => openSearch('recent')}
              onOpenTag={(tag) => openSearch('search', { filters: { tag } })}
              onOpenSaved={(search) => openSearch('search', { filters: search.filters, query: search.query, savedId: search.id })}
            />}
            <Explorer
              settings={finderSettings}
              library={library}
              catalog={catalog}
              onOpenFile={openFile}
              onOpenSearch={(folder) => openSearch('search', { filters: { folder } })}
              personal={authStatus === 'loading' ? null : personal}
              favorites={favoritePaths}
              onToggleFavorite={toggleFavorite}
            />
          </div>
        </section>
      </main>

      <Footer onOpenDownload={openDownload} />

      <nav className={`mobile-bottom-nav ${!inTauri ? 'has-app-tab' : ''}`} aria-label="Navigation mobile">
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
        {!inTauri && (
          <button type="button" onClick={openDownload}>
            <FiDownload aria-hidden="true" /><span>Installer</span>
          </button>
        )}
      </nav>

      <AppDownloadModal open={downloadOpen} onClose={closeDownload} />

      <AuthPanel
        open={authPanel.open}
        mode={authPanel.mode}
        onModeChange={(mode) => setAuthPanel({ open: true, mode })}
        onClose={closeAuth}
      />

      {searchState.open && <SearchPalette
        key={`${personal.key}:${searchState.sequence}`}
        mode={searchState.mode}
        onClose={closeSearch}
        onNavigate={library.navigate}
        onOpenFile={openFile}
        favoriteItems={favoriteItems}
        catalog={catalog}
        library={library}
        personal={personal}
        initialFilters={searchState.filters}
        initialQuery={searchState.query}
        initialSavedId={searchState.savedId}
      />}

      <LibraryChat
        path={library.path}
        catalog={catalog}
        onNavigate={library.navigate}
        onOpenFile={openFile}
        onOpenAuth={openAuth}
        studyDocument={studyFile}
        onClearStudy={() => setStudyFile(null)}
      />
      <CloudflareAnalytics />
      <PreviewModal
        file={selectedFile}
        onClose={closePreview}
        favorite={selectedIsFavorite}
        onToggleFavorite={toggleFavorite}
        onStudy={studySelectedFile}
        onRead={openReader}
      />
    </div>
  );
}
