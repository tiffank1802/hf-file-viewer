import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import FileList from './FileList';
import { useHfFileSystem } from '../hooks/useHfFileSystem';

const Sidebar = forwardRef((props, ref) => {
  const { saveToken, loadRepoFiles, loading } = useHfFileSystem();
  const [repoInput, setRepoInput] = useState('coyotte508/test-model');
  const [tokenInput, setTokenInput] = useState('');
  const [revision, setRevision] = useState('main');
  const fileListRef = useRef(null);

  useImperativeHandle(ref, () => ({
    loadRepo: (repo, rev) => {
      if (repo) setRepoInput(repo);
      if (rev) setRevision(rev);
      handleLoadRepo();
    }
  }));

  useEffect(() => {
    const savedToken = localStorage.getItem('hf_token') || '';
    setTokenInput(savedToken);
  }, []);

  const handleLoadRepo = async () => {
    const repo = repoInput.trim();
    if (!repo) return;
    
    const tree = await loadRepoFiles(repo, revision);
    if (fileListRef.current && tree.length > 0) {
      fileListRef.current.loadRepoFiles(tree);
    }
  };

  const handleSaveToken = () => {
    const token = tokenInput.trim();
    saveToken(token);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      if (e.target.type === 'password') {
        handleSaveToken();
      } else {
        handleLoadRepo();
      }
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h2>🤗 HF File Browser</h2>
      </div>
      
      <div className="repo-input-group">
        <div className="input-row">
          <input
            type="text"
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            placeholder="user/repo-name"
            onKeyDown={handleKeyDown}
            className="repo-input"
          />
          <input
            type="text"
            value={revision}
            onChange={(e) => setRevision(e.target.value)}
            placeholder="revision (main)"
            onKeyDown={handleKeyDown}
            className="revision-input"
            style={{ width: '120px' }}
          />
        </div>
        <button onClick={handleLoadRepo} className="primary-btn" disabled={loading}>
          {loading ? '⏳ Loading...' : '📂 Open'}
        </button>
      </div>
      
      <div className="token-row">
        <input
          type="password"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="HF Token (optional, for private repos)"
          onKeyDown={handleKeyDown}
          className="token-input"
        />
        <button onClick={handleSaveToken} className="secondary-btn">
          💾 Save
        </button>
      </div>
      
      <div className="divider"></div>
      
      <FileList 
        ref={fileListRef} 
        onFileClick={props.onFileClick}
      />
    </div>
  );
});

Sidebar.displayName = 'Sidebar';
export default Sidebar;