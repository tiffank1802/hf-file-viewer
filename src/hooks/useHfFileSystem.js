import { useState, useCallback, useRef, useEffect } from 'react';
import { listFiles, downloadFile } from '@huggingface/hub';

export function useHfFileSystem() {
  const [currentRepo, setCurrentRepo] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const repoFilesRef = useRef(new Map());

  // Initialize token from localStorage on mount
  useEffect(() => {
    const savedToken = localStorage.getItem('hf_token');
    if (savedToken) {
      setToken(savedToken);
    }
  }, []);

  // Save token
  const saveToken = useCallback((newToken) => {
    setToken(newToken);
    if (newToken) {
      localStorage.setItem('hf_token', newToken);
    } else {
      localStorage.removeItem('hf_token');
    }
  }, []);

  // Fetch repository files
  const loadRepoFiles = useCallback(async (repoId, revision = 'main') => {
    setLoading(true);
    setError(null);
    setCurrentRepo({ repoId, revision });

    try {
      const repo = { type: 'model', name: repoId };
      const options = { revision };
      if (token) {
        options.accessToken = token;
      }
      
      const files = [];
      for await (const fileInfo of listFiles(repo, options)) {
        files.push(fileInfo);
      }
      
      // Build file tree from flat list
      const fileTree = buildFileTree(files);
      repoFilesRef.current.set(`${repoId}@${revision}`, fileTree);
      
      setLoading(false);
      return fileTree;
    } catch (err) {
      setError(err.message);
      setLoading(false);
      return [];
    }
  }, [token]);

  // Build file tree from flat file list
  const buildFileTree = (files) => {
    const root = { name: '', path: '', type: 'directory', children: [] };
    
    files.forEach(file => {
      const path = file.path || file.rfilename || '';
      if (!path) return;
      
      const parts = path.split('/');
      let current = root;
      
      parts.forEach((part, index) => {
        const isFile = index === parts.length - 1;
        const currentPath = parts.slice(0, index + 1).join('/');
        
        let child = current.children.find(c => c.name === part);
        
        if (!child) {
          child = {
            name: part,
            path: currentPath,
            type: isFile ? 'file' : 'directory',
            children: isFile ? undefined : [],
            size: isFile ? (file.size || 0) : undefined,
            lfs: isFile ? file.lfs : undefined
          };
          current.children.push(child);
        }
        
        if (!isFile) {
          current = child;
        }
      });
    });
    
    // Sort: directories first, then files, both alphabetically
    const sortTree = (node) => {
      if (node.children) {
        node.children.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        node.children.forEach(sortTree);
      }
    };
    
    sortTree(root);
    return root.children;
  };

  // Get file content as text
  const getFileContent = useCallback(async (repoId, filePath, revision = 'main') => {
    try {
      const repo = { type: 'model', name: repoId };
      const options = { revision, path: filePath };
      if (token) {
        options.accessToken = token;
      }
      
      const response = await downloadFile(repo, options);
      return await response.text();
    } catch (err) {
      throw new Error(`Failed to load file: ${err.message}`);
    }
  }, [token]);

  // Get file as blob URL for images, PDFs, etc.
  const getFileUrl = useCallback(async (repoId, filePath, revision = 'main') => {
    try {
      const repo = { type: 'model', name: repoId };
      const options = { revision, path: filePath };
      if (token) {
        options.accessToken = token;
      }
      
      const response = await downloadFile(repo, options);
      const blob = await response.blob();
      return URL.createObjectURL(blob);
    } catch (err) {
      throw new Error(`Failed to get file URL: ${err.message}`);
    }
  }, [token]);

  // Get flat file list for a directory
  const getFilesInDirectory = useCallback((tree, dirPath = '') => {
    const files = [];
    
    const traverse = (nodes, currentPath) => {
      nodes.forEach(node => {
        const fullPath = currentPath ? `${currentPath}/${node.name}` : node.name;
        
        if (node.type === 'file') {
          files.push({
            name: node.name,
            path: fullPath,
            ext: node.name.split('.').pop().toLowerCase(),
            category: getFileCategory(node.name),
            size: node.size || 0
          });
        } else if (node.type === 'directory') {
          traverse(node.children, fullPath);
        }
      });
    };
    
    traverse(tree, dirPath);
    return files;
  }, []);

  return {
    currentRepo,
    token,
    loading,
    error,
    saveToken,
    loadRepoFiles,
    getFileContent,
    getFileUrl,
    getFilesInDirectory,
    buildFileTree
  };
}

// Helper to categorize files
function getFileCategory(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  
  const categories = {
    code: ['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'cpp', 'c', 'h', 'cs', 'php', 'rb', 'go', 'rs', 'swift', 'kt', 'scala', 'html', 'css', 'scss', 'vue', 'svelte'],
    data: ['json', 'csv', 'xml', 'yaml', 'yml', 'toml', 'sql', 'parquet', 'arrow'],
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff'],
    document: ['md', 'txt', 'pdf', 'doc', 'docx', 'rst', 'tex'],
    config: ['config', 'ini', 'env', 'toml', 'yaml', 'yml', 'lock'],
    archive: ['zip', 'tar', 'gz', 'rar', '7z'],
    model: ['bin', 'safetensors', 'pt', 'pth', 'onnx', 'h5', 'pb', 'tflite'],
    audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a'],
    video: ['mp4', 'webm', 'mov', 'avi', 'mkv']
  };
  
  for (const [cat, exts] of Object.entries(categories)) {
    if (exts.includes(ext)) return cat;
  }
  return 'other';
}

export function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function getIcon(ext) {
  const icons = {
    js: '📜', jsx: '⚛️', ts: '📘', tsx: '⚛️', py: '🐍', json: '📋',
    md: '📝', txt: '📄', pdf: '📕', html: '🌐', css: '🎨', scss: '🎨',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️',
    zip: '📦', tar: '📦', gz: '📦', bin: '🤖', safetensors: '🤖',
    pt: '🤖', pth: '🤖', onnx: '🤖', h5: '🤖',
    mp3: '🎵', wav: '🎵', mp4: '🎬', webm: '🎬'
  };
  return icons[ext] || '📄';
}