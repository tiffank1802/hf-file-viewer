import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { ensureAppwritePing } from './services/appwrite';
import './index.css';

/**
 * Contrôle de configuration Appwrite : `client.ping()` est appelé une seule
 * fois, au démarrage, et le résultat s'affiche dans la pastille du pied de
 * page (et dans la console). Il valide l'endpoint, l'ID de projet et les
 * origines autorisées — aucun de ces éléments ne dépend d'une session.
 */
ensureAppwritePing().then((state) => {
  if (state.status === 'online') {
    console.info('[appwrite] client.ping() OK — le projet « Django objects » répond.');
    return;
  }
  console.warn(`[appwrite] client.ping() en échec (${state.status}) : ${state.detail}`);
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
