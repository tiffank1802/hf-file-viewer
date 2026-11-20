import { useMemo } from 'react';
import { useLocalStorage } from './useLocalStorage.js';
import { changeExplorerSort, DEFAULT_PREFERENCES, explorerPreferences, folderPresentation, FOLDER_PRESENTATION_KEYS } from '../utils/explorer.js';

const MAX_FOLDER_OVERRIDES = 100;
const EMPTY = [];

function findFolder(list, path) {
  return Array.isArray(list) ? list.find((entry) => Array.isArray(entry) && entry[0] === path && entry[1] && typeof entry[1] === 'object') : undefined;
}

function saveFolder(list, path, value) {
  const remaining = Array.isArray(list) ? list.filter((entry) => Array.isArray(entry) && entry[0] !== path) : EMPTY;
  return value ? [[path, folderPresentation(value)], ...remaining].slice(0, MAX_FOLDER_OVERRIDES) : remaining;
}

export function useFinderPreferences(path) {
  const [stored, setStored] = useLocalStorage('enise-explorer-preferences-v1', DEFAULT_PREFERENCES);
  const [folders, setFolders] = useLocalStorage('enise-finder-folder-presentation-v1', EMPTY);
  const defaults = useMemo(() => explorerPreferences(stored), [stored]);
  const override = findFolder(folders, path);
  const preferences = useMemo(() => override ? { ...defaults, ...folderPresentation(override[1]) } : defaults, [defaults, override]);

  const update = (makeChange, byFolder = Boolean(override)) => {
    if (byFolder) setFolders((current) => {
      const previous = findFolder(current, path);
      return saveFolder(current, path, makeChange(previous ? { ...defaults, ...folderPresentation(previous[1]) } : defaults));
    });
    else setStored((current) => makeChange(explorerPreferences(current)));
  };
  return {
    preferences,
    customFolder: Boolean(override),
    setPreference: (key, value) => update((current) => ({ ...current, [key]: value }), Boolean(override) && FOLDER_PRESENTATION_KEYS.includes(key)),
    onSort: (field) => update((current) => changeExplorerSort(current, field)),
    setCustomFolder: (enabled) => setFolders((current) => saveFolder(current, path, enabled ? preferences : null)),
    useAsDefaults: () => setStored((current) => ({ ...explorerPreferences(current), ...folderPresentation(preferences) })),
    resetDefaults: () => {
      setStored(DEFAULT_PREFERENCES);
      setFolders((current) => saveFolder(current, path, null));
    },
  };
}
