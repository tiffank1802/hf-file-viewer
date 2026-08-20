import React, { useState, useEffect, useRef } from 'react';
import { useHfFileSystem } from '../hooks/useHfFileSystem';
import { getFileCategory, getIcon, formatSize, escapeHtml } from '../utils/fileUtils';

const Viewer = ({ filePath, fileName, fileSize, repoId, revision }) => {
  const { getFileContent, getFileUrl } = useHfFileSystem();
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fileUrl, setFileUrl] = useState(null);
  const fileUrlRef = useRef(null);
  
  const { category, ext } = getFileCategory(fileName);
  const icon = getIcon(ext);

  useEffect(() => {
    if (!filePath || !repoId) return;
    
    const loadFile = async () => {
      setLoading(true);
      setError(null);
      setContent(null);
      
      // Clean up previous object URL
      if (fileUrlRef.current) {
        URL.revokeObjectURL(fileUrlRef.current);
        fileUrlRef.current = null;
      }
      
      try {
        // For binary files (images, video, audio, pdf), get a URL
        if (['image', 'video', 'audio', 'pdf'].includes(category)) {
          const url = await getFileUrl(repoId, filePath, revision);
          setFileUrl(url);
          fileUrlRef.current = url;
        } else {
          // For text-based files, get content
          const textContent = await getFileContent(repoId, filePath, revision);
          setContent(textContent);
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    
    loadFile();
    
    return () => {
      if (fileUrlRef.current) {
        URL.revokeObjectURL(fileUrlRef.current);
      }
    };
  }, [filePath, fileName, repoId, revision, category, getFileContent, getFileUrl]);

  if (loading) {
    return (
      <div className="viewer loading">
        <div className="spinner"></div>
        <div>Loading {fileName}...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="viewer error">
        <div className="error-icon">⚠️</div>
        <div className="error-msg">Failed to load file</div>
        <div className="error-detail">{error}</div>
      </div>
    );
  }

  if (!content && !fileUrl) {
    return (
      <div className="viewer empty">
        <div className="empty-icon">{icon}</div>
        <div className="empty-msg">No content to display</div>
      </div>
    );
  }

  // Render based on file category
  switch (category) {
    case 'image':
      return (
        <div className="viewer image-viewer">
          <img 
            src={fileUrl} 
            alt={fileName}
            onLoad={() => {}}
          />
        </div>
      );
      
    case 'video':
      return (
        <div className="viewer video-viewer">
          <video controls src={fileUrl} />
        </div>
      );
      
    case 'audio':
      return (
        <div className="viewer audio-viewer">
          <audio controls src={fileUrl} />
        </div>
      );
      
    case 'pdf':
      return (
        <div className="viewer pdf-viewer">
          <iframe 
            src={fileUrl}
            title={fileName}
            style={{ width: '100%', height: '100%', border: 'none' }}
          />
        </div>
      );
      
    case 'code':
    case 'data':
    case 'text':
    case 'config':
    case 'document':
      return (
        <div className="viewer text-viewer">
          <pre className={`code-content language-${ext}`}>
            {ext === 'json' ? JSON.stringify(JSON.parse(content), null, 2) : escapeHtml(content)}
          </pre>
        </div>
      );
      
    default:
      return (
        <div className="viewer binary-viewer">
          <div className="binary-info">
            <span className="binary-icon">{icon}</span>
            <div>
              <div className="binary-name">{fileName}</div>
              <div className="binary-meta">
                {category} · {formatSize(fileSize)} · .{ext}
              </div>
            </div>
          </div>
          <div className="binary-actions">
            <a 
              href={fileUrl} 
              download={fileName}
              className="download-btn"
              target="_blank"
              rel="noopener noreferrer"
            >
              📥 Download
            </a>
          </div>
        </div>
      );
  }
};

export default Viewer;