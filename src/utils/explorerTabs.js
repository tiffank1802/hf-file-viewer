export const MAX_EXPLORER_TABS = 8;

export function initialExplorerTabs(path) {
  return { activeId: 'finder-1', tabs: [{ id: 'finder-1', path }] };
}

export function activateExplorerTab(state, id, path) {
  const tab = state.tabs.find((entry) => entry.id === id);
  if (!tab || (id === state.activeId && (path === undefined || path === tab.path))) return state;
  return {
    activeId: id,
    tabs: path === undefined || tab.path === path ? state.tabs : state.tabs.map((entry) => entry.id === id ? { ...entry, path } : entry),
  };
}

export function addExplorerTab(state, id, path) {
  if (state.tabs.length >= MAX_EXPLORER_TABS || state.tabs.some((entry) => entry.id === id)) return state;
  const active = state.tabs.find((entry) => entry.id === state.activeId);
  return { activeId: id, tabs: [...state.tabs, { id, path: path ?? active.path }] };
}

export function closeExplorerTab(state) {
  if (state.tabs.length <= 1) return state;
  const index = state.tabs.findIndex((entry) => entry.id === state.activeId);
  const tabs = state.tabs.filter((entry) => entry.id !== state.activeId);
  return { tabs, activeId: tabs[Math.max(index - 1, 0)].id };
}
