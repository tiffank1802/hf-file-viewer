import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import AuthProvider from './contexts/AuthContext.jsx';
import { isTauriRuntime, openExternalUrl } from './utils/runtime.js';
import './index.css';

if (typeof document !== 'undefined' && isTauriRuntime()) {
  document.documentElement.classList.add('is-tauri');
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    const isExternalTarget = anchor.getAttribute('target') === '_blank';
    const isDownload = anchor.hasAttribute('download');
    if ((isExternalTarget || isDownload) && /^https?:\/\//i.test(href)) {
      event.preventDefault();
      void openExternalUrl(href);
    }
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);
