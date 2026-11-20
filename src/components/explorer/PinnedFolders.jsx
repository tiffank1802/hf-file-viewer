import { useRef } from 'react';
import { FiChevronDown, FiChevronUp } from 'react-icons/fi';
import FolderIcon from './FolderIcon';

export default function PinnedFolders({ folders, path, navigate, onMove }) {
  const source = useRef(null);
  if (!folders.length) return null;
  return (
    <nav className="sidebar-links finder-personal-list finder-pinned" aria-label="Dossiers favoris">
      {folders.map((entry, index) => (
        <div className="finder-pinned-row" key={entry.path} draggable={folders.length > 1}
          onDragStart={(event) => {
            source.current = entry.path;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-enise-pinned-folder', entry.path);
          }} onDragEnd={() => { source.current = null; }}
          onDragOver={(event) => {
            if (source.current && source.current !== entry.path) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }
          }} onDrop={(event) => {
            if (!source.current) return;
            event.preventDefault();
            if (event.dataTransfer.getData('application/x-enise-pinned-folder') === source.current) onMove(source.current, entry.path);
            source.current = null;
          }}>
          <button type="button" title={entry.path} aria-current={path === entry.path ? 'page' : undefined}
            onClick={() => navigate(entry.path)}><span><FolderIcon size={22} /></span><span>{entry.name}</span></button>
          {folders.length > 1 && <div className="finder-pinned-controls">
            <button type="button" aria-label={`Monter ${entry.name}`} title="Monter" disabled={index === 0}
              onClick={() => onMove(entry.path, folders[index - 1]?.path)}><FiChevronUp aria-hidden="true" /></button>
            <button type="button" aria-label={`Descendre ${entry.name}`} title="Descendre" disabled={index === folders.length - 1}
              onClick={() => onMove(entry.path, folders[index + 1]?.path)}><FiChevronDown aria-hidden="true" /></button>
          </div>}
        </div>
      ))}
    </nav>
  );
}
