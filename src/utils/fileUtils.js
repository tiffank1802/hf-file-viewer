export const FILE_EXTENSIONS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff'],
  video: ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv'],
  audio: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'],
  pdf: ['pdf'],
  excel: ['xlsx', 'xls', 'csv', 'tsv'],
  word: ['docx', 'doc'],
  text: ['txt', 'md', 'json', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'ts', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'toml', 'cfg', 'ini', 'env', 'sh', 'bash', 'log'],
};

export const FILE_ICONS = {
  image: '🖼️', video: '🎬', audio: '🎵', pdf: '📕',
  excel: '📊', word: '📝',
  json: '📋', md: '📖', txt: '📄',
  py: '🐍', js: '🟨', ts: '🔷', rs: '🦀', go: '🔵',
  html: '🌐', css: '🎨', sh: '⚡',
  zip: '📦', gz: '📦', tar: '📦',
  safetensors: '🧠', bin: '⚙️', pt: '🧠', pth: '🧠', onnx: '🧠',
  lock: '🔒', gitignore: '🙈',
};

export function getFileCategory(filename) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  
  for (const [category, extensions] of Object.entries(FILE_EXTENSIONS)) {
    if (extensions.includes(ext)) {
      return { category, ext };
    }
  }
  
  if (['zip', 'gz', 'tar', '7z', 'rar'].includes(ext)) {
    return { category: 'archive', ext };
  }
  
  if (['safetensors', 'pt', 'pth', 'onnx', 'bin', 'h5', 'keras'].includes(ext)) {
    return { category: 'model', ext };
  }
  
  return { category: 'unknown', ext };
}

export function getIcon(ext) {
  return FILE_ICONS[ext] || '📄';
}

export function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}