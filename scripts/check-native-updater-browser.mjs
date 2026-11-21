/* global window */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { build, preview } from 'vite';

// Exercise the actual signed-build JS and Tauri plugin IPC without keys or
// invoking a real installer. Keep the CI web archive in dist/ unchanged.
const outDir = await mkdtemp(join(tmpdir(), 'enise-signed-updater-'));
let server;
let browser;
try {
  await build({
    define: {
      'import.meta.env.VITE_ENISE_SIGNED_UPDATER': '"1"',
      'import.meta.env.VITE_ENISE_PREVIEW_TAG': '""',
    },
    build: { outDir, emptyOutDir: true },
  });
  server = await preview({ build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({ executablePath: process.env.FINDER_CHROMIUM || undefined });
  const page = await browser.newPage();
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
  await page.addInitScript((origin) => {
    window.updates = { checks: 0, downloads: 0, installs: 0, released: [] };
    let callbackId = 0;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      convertFileSrc: () => origin,
      transformCallback: () => ++callbackId,
      unregisterCallback: () => {},
      async invoke(command, args) {
        if (command === 'plugin:app|version') return '1.1.0';
        if (command === 'plugin:event|listen') return args.handler;
        if (command === 'plugin:updater|check') {
          window.updates.checks += 1;
          return { rid: 4, currentVersion: '1.1.0', version: '1.2.0' };
        }
        if (command === 'plugin:updater|download') {
          window.updates.downloads += 1;
          const bytes = await new Promise((resolve, reject) => { window.updates.finish = resolve; window.updates.fail = reject; });
          return bytes;
        }
        if (command === 'plugin:updater|install') {
          if (args.updateRid !== 4 || args.bytesRid !== 5) throw new Error('Le paquet préparé doit être réutilisé');
          window.updates.installs += 1;
          return;
        }
        if (command === 'plugin:resources|close') window.updates.released.push(args.rid);
        if (command === 'plugin:updater|download_and_install') throw new Error('L’installation ne doit pas redéclencher un téléchargement');
      },
    };
  }, new URL(url).origin);
  const banner = page.getByRole('complementary', { name: 'Mise à jour de l’application' });
  const apply = banner.getByRole('button', { name: 'Appliquer la mise à jour' });
  await page.goto(url);
  await banner.getByText(/Préparation de la mise à jour signée/).waitFor();
  assert.equal(await apply.isDisabled(), true);
  assert.equal(await page.evaluate(() => window.updates.installs), 0);

  await page.waitForFunction(() => Boolean(window.updates.fail));
  await page.evaluate(() => window.updates.fail(Error('Téléchargement interrompu')));
  await banner.getByText(/Impossible de préparer la mise à jour signée/).waitFor();
  await banner.getByRole('button', { name: 'Réessayer' }).click();
  await page.waitForFunction(() => window.updates.downloads === 2);
  await page.evaluate(() => window.updates.finish(5));
  await banner.getByText(/Version 1\.2\.0 prête/).waitFor();
  assert.equal(await page.evaluate(() => window.updates.installs), 0);

  await banner.getByRole('button', { name: 'Plus tard' }).click();
  await banner.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Rechercher dans la bibliothèque' }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('enise-check-updates')));
  await banner.getByText(/Fermez le document ou le panneau/).waitFor();
  assert.equal(await apply.isDisabled(), true);
  await page.keyboard.press('Escape');
  await banner.getByText(/Version 1\.2\.0 prête/).waitFor();
  assert.equal(await page.evaluate(() => window.updates.checks), 2);
  await apply.click();
  await banner.getByText(/Mise à jour appliquée/).waitFor();
  assert.deepEqual(await page.evaluate(() => [window.updates.downloads, window.updates.installs]), [2, 1]);
  console.log('Updater Tauri simulé : téléchargement de fond, nouvelle tentative, report, installation du paquet déjà préparé.');
} finally {
  await browser?.close();
  await server?.close();
  await rm(outDir, { recursive: true, force: true });
}
