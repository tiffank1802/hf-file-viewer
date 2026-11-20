import { randomUUID } from 'node:crypto';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxy = process.env.VITE_API_PROXY || 'http://127.0.0.1:8788';

function apiProxyOptions(target) {
  return {
    target,
    changeOrigin: true,
    xfwd: true,
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

export default defineConfig(({ command }) => {
  const buildId = command === 'build'
    ? (/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '') ? process.env.GITHUB_SHA : randomUUID().replaceAll('-', ''))
    : '';
  return {
  define: { 'import.meta.env.VITE_ENISE_BUILD_ID': JSON.stringify(buildId) },
  plugins: [react(), {
    name: 'enise-version-manifest',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ id: buildId }) });
    },
  }],
  build: {
    target: 'es2022',
    // Only content-hashed Vite output belongs in this immutable directory.
    assetsDir: 'build-assets',
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
  };
});
