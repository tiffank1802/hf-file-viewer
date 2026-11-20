import { useEffect, useRef } from 'react';
import { FiPlus, FiX } from 'react-icons/fi';
import { getName } from '../../utils/files';

export default function ExplorerTabs({ library }) {
  const { tabs, activeId, canAddTab, switchTab, addTab, closeTab } = library;
  const focusOnChange = useRef(false);
  const list = useRef(null);
  useEffect(() => {
    if (!focusOnChange.current) return;
    focusOnChange.current = false;
    list.current?.querySelector('[aria-selected="true"]')?.focus();
  }, [activeId]);

  const changeTab = (id) => {
    if (id === activeId) return;
    focusOnChange.current = true;
    switchTab(id);
  };
  return (
    <div className="finder-tabs-shell">
      <div className="finder-tabs" role="tablist" aria-label="Onglets de l’explorateur" ref={list}>
        {tabs.map(({ id, path }, index) => (
          <button type="button" role="tab" id={`tab-${id}`} key={id} tabIndex={id === activeId ? 0 : -1}
            aria-controls={id === activeId ? 'finder-tab-panel' : undefined} aria-selected={id === activeId}
            title={path || 'Bibliothèque'} onClick={() => changeTab(id)} onKeyDown={(event) => {
              let next;
              if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
              else if (event.key === 'ArrowLeft') next = tabs[(index + tabs.length - 1) % tabs.length];
              else if (event.key === 'Home') next = tabs[0];
              else if (event.key === 'End') next = tabs.at(-1);
              if (next) { event.preventDefault(); changeTab(next.id); }
            }}>{getName(path)}</button>
        ))}
      </div>
      <button type="button" aria-label="Nouvel onglet" title="Nouvel onglet" disabled={!canAddTab} onClick={() => {
        focusOnChange.current = true;
        addTab();
      }}><FiPlus aria-hidden="true" /></button>
      {tabs.length > 1 && <button type="button" aria-label="Fermer l’onglet actif" title="Fermer l’onglet actif" onClick={() => {
        focusOnChange.current = true;
        closeTab();
      }}><FiX aria-hidden="true" /></button>}
    </div>
  );
}
