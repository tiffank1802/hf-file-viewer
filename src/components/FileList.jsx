import React, { useState, useRef, useImperativeHandle, forwardRef } from 'react';
import { useHfFileSystem } from '../hooks/useHfFileSystem';
import { getFileCategory, getIcon, formatSize } from '../utils/fileUtils';

const FileList = forwardRef((props, ref) => {
  const { getFilesInDirectory, loading, error } = useHfFileSystem();
  const [files, setFiles] = useState([]);
  const [expandedDirs, setExpandedDirs] = useState(new Set());
  const [fileTree, setFileTree] = useState(null);

  useImperativeHandle(ref, () => ({
    loadRepoFiles: (tree) => {
      setFileTree(tree);
      const flatFiles = getFilesInDirectory(tree);
      setFiles(flatFiles);
    }
  }));

  const toggleDir = (dirPath) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  };

  const renderTree = (nodes, depth = 0) => {
    return nodes.map((node, index) => {
      if (node.type === 'file') {
        const { category, ext } = getFileCategory(node.name);
        const icon = getIcon(ext);
        
        return (
          <div 
            key={node.path}
            className={`file-item ${depth > 0 ? 'indented' : ''}`}
            style={{ paddingLeft: `${12 + depth * 16}px` }}
            onClick={() => props.onFileClick?.(node.path, node)}
          >
            <span className="file-icon">{icon}</span>
            <span className="file-name">{node.name}</span>
            <span className="file-meta">{category} · {formatSize(node.size)}</span>
          </div>
        );
      } else {
        const isExpanded = expandedDirs.has(node.path);
        return (
          <div key={node.path} style={{ paddingLeft: `${12 + depth * 16}px` }}>
            <div className="dir-header" onClick={() => toggleDir(node.path)}>
              <span className="dir-toggle">{isExpanded ? '▼' : '▶'}</span>
              <span className="dir-icon">📁</span>
              <span className="dir-name">{node.name}</span>
            </div>
            {isExpanded && node.children && (
              <div className="dir-children">
                {renderTree(node.children, depth + 1)}
              </div>
            )}
          </div>
        );
      }
    });
  };

  if (loading) {
    return (
      <div className="file-list">
        <div className="loading">
          <div className="spinner"></div>
          <div>Loading repository...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="file-list">
        <div className="error-msg">Error: {error}</div>
      </div>
    );
  }

  if (!fileTree || fileTree.length === 0) {
    return (
      <div className="file-list">
        <div className="empty">👆 Enter a repo name to browse files</div>
      </div>
    );
  }

  return (
    <div className="file-list">
      {renderTree(fileTree)}
    </div>
  );
});

FileList.displayName = 'FileList';
export default FileList;