#!/usr/bin/env node
/**
 * Lance le backend Go et, sauf --api-only, le frontend Vite.
 *
 * Le navigateur parle uniquement à Vite. Vite proxifie /api vers Go, donc
 * l’origine reste la même et aucun secret ne sort du processus Go.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiOnly = process.argv.includes('--api-only');
const withStatic = process.argv.includes('--static');
const port = process.env.GO_API_PORT || '8788';
const listenHost = withStatic || process.argv.includes('--public') ? '0.0.0.0' : '127.0.0.1';
const apiOrigin = `http://127.0.0.1:${port}`;
const children = [];
let stopping = false;

function findGo() {
  const home = process.env.HOME || '';
  const candidates = [
    process.env.GO_BIN,
    path.join(home, '.local/go/bin/go'),
    path.join(home, '.local/go-py/go/bin/go'),
    '/usr/local/go/bin/go',
    '/usr/lib/go/bin/go',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate) && spawnSync(candidate, ['version'], { encoding: 'utf8' }).status === 0) {
      return candidate;
    }
  }
  if (spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0) return 'go';
  return '';
}

function stopChild(child) {
  if (!child?.pid || child.killed) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) stopChild(child);
  setTimeout(() => process.exit(code), 150);
}

function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (stopping) {
        resolve(false);
        return;
      }
      const req = httpRequest(`${apiOrigin}/api/health`, { method: 'GET' }, (response) => {
        response.resume();
        if (response.statusCode === 200) {
          resolve(true);
          return;
        }
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tick, 250);
      });
      req.on('error', () => {
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tick, 250);
      });
      req.setTimeout(1000, () => req.destroy());
      req.end();
    };
    tick();
  });
}

function start(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
    detached: true,
  });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    if (signal) return;
    console.error(`\n${options.label} s’est arrêté (code ${code ?? 0}).`);
    shutdown(code && code !== 0 ? code : 1);
  });
  return child;
}

const goBin = findGo();
if (!goBin) {
  const message = [
    '',
    'Go 1.22 ou plus récent est introuvable.',
    'Installez-le depuis https://go.dev/dl/ puis relancez npm run dev.',
    'En attendant, le frontend peut démarrer seul : npm run dev:vite',
    '',
  ].join('\n');
  if (apiOnly) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  start(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '0.0.0.0', '--port', '3000'], {
    cwd: root,
    env: process.env,
    label: 'Vite',
  });
} else {
  const goEnv = {
    ...process.env,
    ADDR: `${listenHost}:${port}`,
    ENISE_ROOT: root,
  };
  if (withStatic) goEnv.STATIC_DIR = path.join(root, 'dist');
  console.log(`Backend Go → http://${listenHost}:${port}`);
  start(goBin, ['run', './cmd/enise-api'], {
    cwd: path.join(root, 'backend'),
    env: goEnv,
    label: 'Backend Go',
  });
  const ready = await waitForHealth(90_000);
  if (!ready) {
    console.error('Le backend Go n’a pas répondu sur /api/health.');
    shutdown(1);
  } else if (!apiOnly) {
    const viteBin = path.join(root, 'node_modules/vite/bin/vite.js');
    if (!existsSync(viteBin)) {
      console.error('Dépendances frontend absentes. Lancez npm install.');
      shutdown(1);
    } else {
      console.log(`Frontend Vite → http://0.0.0.0:3000 (proxy /api → ${apiOrigin})`);
      start(process.execPath, [viteBin, '--host', '0.0.0.0', '--port', '3000'], {
        cwd: root,
        env: { ...process.env, VITE_API_PROXY: apiOrigin },
        label: 'Vite',
      });
    }
  }
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
