import { useEffect, useRef } from 'react';
import { FiX } from 'react-icons/fi';

export default function FolderActions({ anchor, groups, onClose, heading }) {
  const dialog = useRef(null);
  const { x, y, trigger } = anchor;
  useEffect(() => {
    const node = dialog.current;
    node.showModal();
    return () => {
      node.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [trigger]);

  return <dialog ref={dialog} className="finder-dialog finder-dialog-anchored finder-folder-actions"
    style={{ left: `clamp(8px, ${x}px, calc(100vw - min(305px, 92vw) - 8px))`, top: `clamp(8px, ${y}px, calc(100dvh - min(550px, 86dvh) - 8px))` }}
    aria-label={heading} onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="finder-dialog-content">
      <div className="finder-dialog-heading"><h3>{heading}</h3><button type="button" aria-label="Fermer" onClick={onClose}><FiX aria-hidden="true" /></button></div>
      {groups.map(({ label, items }) => <div className="finder-context-group finder-action-list" role="group" aria-label={label} key={label}>
        <p>{label}</p>
        {items.map(({ label: name, action, disabled, active }) => <button key={name} type="button" disabled={disabled} aria-pressed={active} onClick={() => { onClose(); action(); }}>{name}</button>)}
      </div>)}
    </div>
  </dialog>;
}
