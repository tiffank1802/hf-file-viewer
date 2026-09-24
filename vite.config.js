import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxy = process.env.VITE_API_PROXY || 'http://127.0.0.1:8788';

function apiProxyOptions(target) {
  return {
    target,
    changeOrigin: true,
    timeout: 300_000,
    proxyTimeout: 300_000,
    configure(proxy) {
      proxy.on('proxyRes', (proxyRes) => {
        const type = String(proxyRes.headers['content-type'] || '');
        if (type.includes('text/event-stream')) {
          proxyRes.headers['cache-control'] = 'no-cache, no-transform';
          proxyRes.headers['x-accel-buffering'] = 'no';
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
    proxy: {
      '/api': apiProxyOptions(apiProxy),
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
    proxy: {
      '/api': apiProxyOptions(apiProxy),
    },
  },
});
