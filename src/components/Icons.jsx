import { useId } from 'react';
import {
  FiAlignLeft,
  FiArchive,
  FiAward,
  FiBookOpen,
  FiBox,
  FiCode,
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

// Shared Finder-style paper silhouette, with a distinct glyph for each type.
const fileIcons = {
  pdf: [FiFileText, '#c33849'],
  image: [FiImage, '#146cb5'],
  audio: [FiMusic, '#a6428a'],
  video: [FiVideo, '#6745af'],
  text: [FiCode, '#52617c'],
  office: [FiAlignLeft, '#1b65b3'],
  model: [FiBox, '#087e73'],
  archive: [FiArchive, '#95602d'],
  file: [FiAlignLeft, '#62718b'],
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

function PaperIcon({ kind, size, className }) {
  const id = useId();
  const fileKind = Object.hasOwn(fileIcons, kind) ? kind : 'file';
  const [Glyph, accent] = fileIcons[fileKind];
  const page = 'M16 3h23l14 14v37a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6V9a6 6 0 0 1 6-6Z';
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={className} aria-hidden="true" data-file-icon={fileKind}>
      <defs>
        <linearGradient id={`${id}-paper`} x2="0" y2="1">
          <stop stopColor="#fff" />
          <stop offset=".58" stopColor="#fbfcff" />
          <stop offset="1" stopColor="#dce5f0" />
        </linearGradient>
        <linearGradient id={`${id}-fold`} x2="1" y2="1">
          <stop stopColor="#bcc9da" />
          <stop offset="1" stopColor="#f7faff" />
        </linearGradient>
      </defs>
      <path d={page} transform="translate(0 2)" fill="#22354e" opacity=".16" />
      <path d={page} fill={`url(#${id}-paper)`} stroke="#899bb2" strokeWidth="1.4" />
      <path d="M39 3v10a4 4 0 0 0 4 4h10Z" fill={`url(#${id}-fold)`} stroke="#899bb2" strokeWidth="1.2" strokeLinejoin="round" />
      <rect x="16" y="24" width="31" height="30" rx="8" fill={accent} fillOpacity=".11" />
      <g transform="translate(20.5 28)">
        <Glyph size={22} color={accent} />
      </g>
    </svg>
  );
}

export function FileTypeIcon({ kind, size = 20, className = '' }) {
  return kind === 'folder' ? <FolderIcon size={size} className={className} /> : <PaperIcon {...{ kind, size, className }} />;
}

export function NavigationIcon({ name, size = 18, className = '' }) {
  const Icon = navigationIcons[name] || FiBookOpen;
  return <Icon size={size} className={className} aria-hidden="true" />;
}
