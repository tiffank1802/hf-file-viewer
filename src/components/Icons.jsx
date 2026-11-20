import {
  FiArchive,
  FiAward,
  FiBookOpen,
  FiBox,
  FiCode,
  FiFile,
  FiFileText,
  FiGlobe,
  FiHeadphones,
  FiHome,
  FiImage,
  FiLayers,
  FiMusic,
  FiSettings,
  FiTool,
  FiVideo,
} from 'react-icons/fi';
import FolderIcon from './explorer/FolderIcon';

const fileIcons = {
  pdf: FiFileText,
  image: FiImage,
  audio: FiMusic,
  video: FiVideo,
  text: FiCode,
  office: FiFileText,
  model: FiBox,
  archive: FiArchive,
  file: FiFile,
};

const navigationIcons = {
  home: FiHome,
  settings: FiSettings,
  book: FiBookOpen,
  globe: FiGlobe,
  box: FiBox,
  layers: FiLayers,
  tool: FiTool,
  award: FiAward,
  headphones: FiHeadphones,
};

export function FileTypeIcon({ kind, size = 20, className = '' }) {
  if (kind === 'folder') return <FolderIcon size={size} className={className} />;
  const Icon = fileIcons[kind] || FiFile;
  return <Icon size={size} className={className} aria-hidden="true" />;
}

export function NavigationIcon({ name, size = 18, className = '' }) {
  const Icon = navigationIcons[name] || FiBookOpen;
  return <Icon size={size} className={className} aria-hidden="true" />;
}
