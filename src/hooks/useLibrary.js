import { useCallback, useEffect, useRef, useState } from 'react';
import { createFolderReader } from '../services/folderReader.js';
import { activateExplorerTab, addExplorerTab, closeExplorerTab, initialExplorerTabs, MAX_EXPLORER_TABS } from '../utils/explorerTabs.js';
import { hrefFromLibraryPath, pathFromHash, pathFromLocation } from '../utils/routes.js';
import { useFolder } from './useFolder.js';

const HISTORY_KEY = 'eniseLibraryHistory';
const sessionId = () => `${Date.now()}-${Math.random()}`;
const activePath = (state) => state.tabs.find(({ id }) => id === state.activeId).path;
const historyEntry = (session) => ({ id: session.id, cursor: session.cursor, tabId: session.route.activeId });

function stampEntry(session, href) {
  window.history.replaceState({ ...window.history.state, [HISTORY_KEY]: historyEntry(session) }, '', href);
}

function adoptHistoryEntry(session) {
  if (window.history.state?.[HISTORY_KEY]?.id === session.id) return;
  // Don't send Explorer's buttons to unrelated pages. A native hash jump may
  // also create an entry not owned by the explorer (e.g. the skip link).
  session.id = sessionId();
  session.cursor = 0;
  session.end = 0;
  stampEntry(session);
}

export function useLibrary() {
  const [route, setRoute] = useState(() => initialExplorerTabs(pathFromLocation()));
  const [reader] = useState(createFolderReader);
  const [history, setHistory] = useState({ cursor: 0, end: 0 });
  const session = useRef({ id: '', cursor: 0, end: 0, nextTab: 1, route });
  const path = activePath(route);
  const folder = useFolder(reader, path, { autoRefresh: true });

  useEffect(() => {
    const state = session.current;
    state.id ||= sessionId();
    stampEntry(state);
    const syncPath = () => {
      const entry = window.history.state?.[HISTORY_KEY];
      const found = entry?.id === state.id;
      if (found) state.cursor = entry.cursor;
      else adoptHistoryEntry(state);
      const target = found && state.route.tabs.some((tab) => tab.id === entry.tabId) ? entry.tabId : state.route.activeId;
      state.route = activateExplorerTab(state.route, target, pathFromLocation());
      if (target !== entry?.tabId) stampEntry(state);
      setRoute(state.route);
      setHistory({ cursor: state.cursor, end: state.end });
    };
    const onHashChange = () => {
      if (pathFromHash() !== null) syncPath();
    };
    window.addEventListener('popstate', syncPath);
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('popstate', syncPath);
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  const commit = useCallback((next, { replace = false, keepUrl = false } = {}) => {
    const state = session.current;
    if (state.route === next) return;
    adoptHistoryEntry(state);
    state.route = next;
    const href = keepUrl ? undefined : hrefFromLibraryPath(activePath(next));
    if (replace) stampEntry(state, href);
    else {
      state.cursor += 1;
      state.end = state.cursor;
      window.history.pushState({ [HISTORY_KEY]: historyEntry(state) }, '', href);
    }
    setRoute(next);
    setHistory({ cursor: state.cursor, end: state.end });
  }, []);

  const navigate = useCallback((nextPath = '', options = {}) => {
    const normalized = nextPath.replace(/^\/+|\/+$/g, '');
    const { route: current } = session.current;
    if (normalized !== pathFromLocation() || normalized !== activePath(current)) {
      commit(activateExplorerTab(current, current.activeId, normalized));
    } else if (pathFromHash() && window.location.pathname === '/') {
      stampEntry(session.current, hrefFromLibraryPath(normalized));
    }
    if (options.scroll !== false) {
      window.requestAnimationFrame(() => {
        document.getElementById('library')?.scrollIntoView({
          behavior: options.instant ? 'auto' : 'smooth', block: 'start',
        });
      });
    }
  }, [commit]);

  const addTab = useCallback(() => {
    const state = session.current;
    if (state.route.tabs.length >= MAX_EXPLORER_TABS) return;
    state.nextTab += 1;
    commit(addExplorerTab(state.route, `finder-${state.nextTab}`), { keepUrl: true });
  }, [commit]);
  const switchTab = useCallback((id) => {
    const { route: current } = session.current;
    if (id === current.activeId) return;
    const next = activateExplorerTab(current, id);
    commit(next, { keepUrl: activePath(current) === activePath(next) });
  }, [commit]);
  const closeTab = useCallback(() => {
    const { route: current } = session.current;
    const next = closeExplorerTab(current);
    commit(next, { replace: true, keepUrl: activePath(current) === activePath(next) });
  }, [commit]);

  const prefetch = useCallback((nextPath) => {
    const { result, release } = reader.acquire(nextPath.replace(/^\/+|\/+$/g, ''));
    result.catch(() => {}).finally(release);
  }, [reader]);

  const goBack = useCallback(() => { if (session.current.cursor > 0) window.history.back(); }, []);
  const goForward = useCallback(() => { if (session.current.cursor < session.current.end) window.history.forward(); }, []);

  return {
    path, ...folder, reader, navigate, prefetch, goBack, goForward,
    canGoBack: history.cursor > 0, canGoForward: history.cursor < history.end,
    ...route, canAddTab: route.tabs.length < MAX_EXPLORER_TABS, addTab, switchTab, closeTab,
  };
}
