/* global window */
import { createServer } from 'vite';

const folder = { path: 'GM', type: 'directory' };
const items = ['Cours.pdf', 'Notes.txt', 'Document.docx', 'Photo.jpg', 'Musique.mp3', 'Vidéo.mp4', 'Maquette.step', 'Archive.zip', 'Fichier.dat'].map((name) => ({ path: `GM/${name}`, type: 'file', size: 8192 }));

// Injected only by this demo server. Never bundled into the production app.
function mockTauri() {
  let callback = 0;
  const delay = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__TAURI_INTERNALS__ = {
    convertFileSrc: () => window.location.origin,
    transformCallback: () => ++callback,
    unregisterCallback: () => {},
    async invoke(command, args) {
      if (command === 'plugin:app|version') return '1.1.0';
      if (command === 'plugin:event|listen') return args.handler;
      if (command === 'plugin:updater|check') {
        await delay(800);
        return { rid: 4, currentVersion: '1.1.0', version: '1.2.0' };
      }
      if (command === 'plugin:updater|download') {
        await delay(3800);
        if (args.rid !== 4) throw new Error('Paquet indisponible');
        return 5;
      }
      if (command === 'plugin:updater|install') {
        if (args.updateRid !== 4 || args.bytesRid !== 5) throw new Error('Paquet indisponible');
        return delay(1050);
      }
      if (command === 'plugin:updater|download_and_install') throw new Error('Téléchargement répété');
    },
  };
}
const server = await createServer({
  define: {
    'import.meta.env.VITE_ENISE_SIGNED_UPDATER': '"1"',
    'import.meta.env.VITE_ENISE_PREVIEW_TAG': '""',
    'import.meta.env.VITE_API_ORIGIN': '""',
    'import.meta.env.VITE_TAURI_DIRECT_HTTP': '"0"',
  },
  server: { host: '0.0.0.0', port: 4175, strictPort: true, hmr: false },
  plugins: [{
    name: 'demo-only-simulated-updater',
    transformIndexHtml() {
      return [
        { tag: 'script', injectTo: 'head-prepend', children: `(${mockTauri.toString()})();` },
        { tag: 'aside', injectTo: 'body-prepend', attrs: { style: 'background:#003c31;color:#fff;font:600 13px/1.4 system-ui;text-align:center;padding:9px 16px' }, children: 'Démonstration · Mise à jour Tauri simulée · Aucun téléchargement ni installation réels' },
      ];
    },
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        const url = new URL(req.url, 'http://demo.invalid');
        if (url.pathname === '/') { res.writeHead(302, { Location: '/bibliotheque/GM' }); res.end(); return; }
        if (!url.pathname.startsWith('/api/')) return next();
        const value = url.pathname === '/api/index' ? { items: [folder, ...items], totalFiles: items.length, counts: {} }
          : url.pathname === '/api/tree' ? { items: url.searchParams.get('prefix') === 'GM' ? items : [folder] }
          : url.pathname === '/api/auth/session' ? { configured: false, user: null }
          : { items: [] };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(value));
      });
    },
  }],
});
await server.listen();
server.printUrls();
