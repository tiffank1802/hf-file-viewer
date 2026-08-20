import React, { useRef, useState, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import Viewer from './components/Viewer';
import './index.css';

function App() {
  const sidebarRef = useRef(null);
  const viewerRef = useRef(null);
  
  const [selectedFile, setSelectedFile] = useState(null);
  const [currentRepo, setCurrentRepo] = useState(null);

  const handleRepoLoad = useCallback(async (repoPath, revision = 'main') => {
    if (!repoPath) return;
    
    setCurrentRepo({ repoId: repoPath, revision });
    
    // The sidebar will handle loading the repo files
    if (sidebarRef.current?.loadRepo) {
      sidebarRef.current.loadRepo(repoPath, revision);
    }
  }, []);

  const handleTokenSave = useCallback((token) => {
    // Token is saved inside the Sidebar component
  }, []);

  const handleFileClick = useCallback((filePath, fileName, fileSize, category, ext) => {
    setSelectedFile({
      path: filePath,
      name: fileName,
      size: fileSize,
      category,
      ext
    });
  }, []);

  return (
    <div className="app">
      <Sidebar 
        ref={sidebarRef}
        onRepoLoad={handleRepoLoad}
        onTokenSave={handleTokenSave}
        onFileClick={handleFileClick}
      />
      <div className="main">
        {selectedFile && currentRepo ? (
          <Viewer
            ref={viewerRef}
            filePath={selectedFile.path}
            fileName={selectedFile.name}
            fileSize={selectedFile.size}
            repoId={currentRepo.repoId}
            revision={currentRepo.revision}
          />
        ) : (
          <div className="viewer-placeholder">
            <div className="icon">👈</div>
            <div>Select a file from the sidebar to view its contents</div>
            <div className="hint">Enter a repository name (e.g., microsoft/phi-2) and click Open</div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;