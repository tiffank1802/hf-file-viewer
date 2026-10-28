#!/usr/bin/env node

// Build the real frontend and Go API, then run the browser against both. The
// only remote services used by the tests are fakes bound to loopback; no real
// Appwrite, document storage, AI provider or production credentials are used.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(tmpdir(), 'enise-pdf-integration-'));
const binary = path.join(temp, process.platform === 'win32' ? 'enise-api.exe' : 'enise-api');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} a échoué (${result.status ?? result.signal}).`);
}

try {
  // Override local build configuration so the test frontend always uses the
  // local Go server instead of an operator's real API or rollout setting.
  run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], {
    env: { ...process.env, VITE_API_ORIGIN: '', VITE_TAURI_DIRECT_HTTP: '0', VITE_READER_ROLLOUT: 'all' },
  });
  run('go', ['build', '-o', binary, './cmd/enise-api'], { cwd: path.join(root, 'backend') });
  run(process.execPath, [
    path.join(root, 'node_modules/@playwright/test/cli.js'),
    'test', '--config=playwright.integration.config.js', ...process.argv.slice(2),
  ], { env: { ...process.env, PDF_INTEGRATION_GO_BIN: binary } });
} catch (error) {
  console.error(`Test d’intégration PDF impossible : ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
