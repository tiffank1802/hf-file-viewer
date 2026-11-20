/* global document, window */
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// API fixtures intentionally cover a folder omitted by the index and an
// unavailable path. Nothing in this test calls the external storage service.
const file = (path, size = 32) => ({ path, size, type: 'file', mtime: '2026-11-19' });
const directory = (path) => ({ path, type: 'directory' });
const root = 'GM';
const lesson = 'GM/Mécanique & plans';
const empty = `${lesson}/Vide`;
const offline = `${lesson}/Hors ligne`;
const notes = `${lesson}/Notes.txt`;
const picture = `${lesson}/Épure.png`;
const data = new Map([
  ['', [directory(root), directory('TOEIC')]],
  [root, [directory(lesson), directory('GM/Autre')]],
  [lesson, [directory(empty), directory(offline), file(notes), file(picture), file(`${lesson}/Cours.pdf`, 200000)]],
  [empty, []], ['GM/Autre', Array.from({ length: 30 }, (_, n) => file(`GM/Autre/Document ${n + 1}.txt`))],
]);
const index = [...data.values()].flat().filter((entry) => entry.path !== empty);
const blank = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM5kAAAAASUVORK5CYII=';
let sse;
const emit = (event, data) => sse.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const vite = await createServer({
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{
    name: 'test-chat-stream',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== '/api/chat' || request.method !== 'POST') return next();
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        response.flushHeaders();
        sse = response;
      });
    },
  }],
});
let browser;
try {
  await vite.listen();
  const base = vite.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ executablePath: process.env.FINDER_CHROMIUM || undefined });
  const desktop = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const runtimeErrors = [];
  let userId = null;
  async function stub(page) {
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    page.setDefaultTimeout(6_000);
    await page.route((url) => url.origin !== base, (route) => route.abort());
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/chat') return route.continue();
      if (url.pathname === '/api/tree') {
        const prefix = url.searchParams.get('prefix') ?? '';
        if (prefix === offline) return route.fulfill({ status: 503, json: { error: 'Indisponible' } });
        return route.fulfill({ json: { items: data.get(prefix) ?? [] } });
      }
      if (url.pathname === '/api/index') return route.fulfill({ json: { items: index, counts: {}, totalFiles: 4 } });
      if (url.pathname === '/api/auth/session') return route.fulfill({ json: { configured: true, user: userId ? { id: userId, name: userId } : null } });
      if (url.pathname.includes('favorites')) return route.fulfill({ json: { items: userId ? [directory(root), directory('TOEIC')] : [] } });
      if (url.pathname === '/api/file' && url.searchParams.get('path') === picture) {
        return route.fulfill({ contentType: 'image/png', body: Buffer.from(blank, 'base64') });
      }
      if (url.pathname === '/api/file') return route.fulfill({ contentType: 'text/plain', body: 'Un aperçu en français.' });
      return route.fulfill({ json: {} });
    });
  }
  function control(page, name) { return page.getByRole('button', { name, exact: true }); }
  function entry(page, path) { return page.locator(`[data-finder-item="${path}"]`); }
  function heading(page, name) { return page.getByRole('heading', { name, exact: true }); }
  const href = (path) => `${base}/bibliotheque/${path.split('/').map(encodeURIComponent).join('/')}`;
  await stub(desktop);
  await desktop.goto(href(root));
  await heading(desktop, 'GM').waitFor();
  assert.equal(await control(desktop, 'Précédent').isEnabled(), false);
  assert.equal(await entry(desktop, lesson).locator('svg rect').count(), 1);
  await entry(desktop, lesson).click();
  assert.equal(await entry(desktop, lesson).getAttribute('aria-pressed'), 'true');
  await entry(desktop, lesson).press('Enter');
  await desktop.waitForURL(href(lesson));
  await control(desktop, 'Affichage : Colonnes').click();
  await entry(desktop, empty).click();
  await heading(desktop, 'Vide').first().waitFor();
  await desktop.getByText('Ce dossier est vide', { exact: true }).waitFor();
  await control(desktop, 'Précédent').click();
  await desktop.waitForURL(href(lesson));
  await control(desktop, 'Suivant').click();
  await desktop.waitForURL(href(empty));
  await desktop.goBack();
  await desktop.waitForURL(href(lesson));
  await control(desktop, 'Affichage : Liste').click();
  await control(desktop, 'Déplier Vide').click();
  await desktop.getByText('Ce dossier est vide', { exact: true }).waitFor();
  assert.equal(desktop.url(), href(lesson));
  await entry(desktop, notes).click();
  await entry(desktop, picture).click({ modifiers: ['Shift'] });
  await desktop.getByText('2 sélectionnés', { exact: true }).waitFor();
  await control(desktop, 'Affichage : Galerie').click();
  await desktop.locator('.finder-gallery-image').waitFor();
  await desktop.waitForFunction(() => document.querySelector('.finder-gallery-image')?.naturalWidth > 0);
  await entry(desktop, notes).press('Space');
  await desktop.getByText('Un aperçu en français.', { exact: true }).waitFor();
  await desktop.keyboard.press('Escape');
  assert.equal(await entry(desktop, notes).evaluate((node) => node === document.activeElement), true);
  await entry(desktop, notes).press('Shift+F10');
  await control(desktop, 'Lire les informations').last().click();
  await control(desktop.getByRole('dialog'), 'Important').click();
  await desktop.keyboard.press('Escape');
  await control(desktop, 'Rechercher depuis ce dossier').click();
  assert.equal(await desktop.getByLabel('Emplacement de recherche').inputValue(), lesson);
  await desktop.getByLabel('Tag', { exact: true }).selectOption('important');
  assert.equal(await desktop.locator('.search-result').count(), 1);
  await control(desktop, 'Enregistrer la recherche').click();
  await desktop.getByLabel('Nom du dossier intelligent').fill('Mes révisions');
  await control(desktop, 'Enregistrer').click();
  await desktop.getByText('Dossier intelligent enregistré sur cet appareil.').waitFor();
  await desktop.keyboard.press('Escape');
  await desktop.reload();
  await desktop.locator('.finder-gallery').waitFor();
  assert.equal(await control(desktop, 'Affichage : Galerie').getAttribute('aria-pressed'), 'true');
  await control(desktop, 'Mes révisions').click();
  await heading(desktop, 'Mes révisions').waitFor();
  assert.equal(await desktop.locator('.search-result strong').textContent(), 'Notes.txt');
  await desktop.keyboard.press('Escape');
  await desktop.getByRole('button', { name: /^Récents/ }).click();
  await heading(desktop, 'Récents').waitFor();
  await desktop.locator('.search-result').getByText('Notes.txt', { exact: true }).waitFor();
  await desktop.keyboard.press('Escape');

  await control(desktop, 'Affichage : Liste').click();
  await entry(desktop, notes).click();
  await control(desktop, 'Nouvel onglet').click();
  assert.equal(await desktop.getByRole('tab').count(), 2);
  await control(desktop, 'Dossier parent').click();
  await desktop.waitForURL(href(root));
  await desktop.getByRole('tab', { name: 'Mécanique & plans' }).click();
  await desktop.waitForURL(href(lesson));
  assert.equal(await entry(desktop, notes).getAttribute('aria-pressed'), 'true');
  await desktop.getByRole('tab', { name: 'Mécanique & plans' }).press('ArrowRight');
  await desktop.waitForURL(href(root));
  await entry(desktop, 'GM/Autre').press('Enter');
  await desktop.waitForURL(href('GM/Autre'));
  await entry(desktop, 'GM/Autre/Document 30.txt').waitFor();
  await desktop.locator('.finder-content').evaluate((node) => new Promise((resolve) => {
    node.addEventListener('scroll', () => window.requestAnimationFrame(resolve), { once: true });
    node.scrollTop = 280;
  }));
  await desktop.getByRole('tab', { name: 'Mécanique & plans' }).click();
  await desktop.waitForURL(href(lesson));
  await desktop.getByRole('tab', { name: 'Autre' }).click();
  await desktop.waitForURL(href('GM/Autre'));
  await entry(desktop, 'GM/Autre/Document 30.txt').waitFor();
  assert.equal(await desktop.locator('.finder-content').evaluate((node) => node.scrollTop), 280);
  await control(desktop, 'Fermer l’onglet actif').click();
  await desktop.waitForURL(href(lesson));
  assert.equal(await desktop.getByRole('tab').count(), 1);
  await desktop.getByLabel('Options de présentation').click();
  await desktop.getByLabel('Regroupement').selectOption('tag');
  await heading(desktop, 'Important').waitFor();
  await desktop.getByLabel('Options de présentation').click();
  await control(desktop, 'Affichage : Galerie').click();

  userId = 'Compte-B';
  await desktop.reload();
  await desktop.locator('.finder-gallery').waitFor();
  const pinned = desktop.getByRole('navigation', { name: 'Dossiers favoris' });
  await pinned.waitFor();
  await control(pinned, 'Monter TOEIC').click();
  assert.equal(await pinned.locator('.finder-pinned-row > button').first().innerText(), 'TOEIC');
  await control(desktop, 'Rechercher depuis ce dossier').click();
  await desktop.getByLabel('Tag', { exact: true }).selectOption('important');
  await heading(desktop, 'Aucun résultat trouvé').waitFor();
  assert.equal(await desktop.getByLabel('Dossiers intelligents').count(), 0);
  await desktop.keyboard.press('Escape');
  await control(desktop, 'Affichage : Icônes').click();
  const optionsButton = desktop.getByLabel('Options de présentation');
  await optionsButton.click();
  const options = desktop.getByRole('group', { name: 'Options du Finder' });
  await options.getByLabel('Afficher la prévisualisation', { exact: true }).check();
  await options.getByLabel('Afficher la barre latérale').uncheck();
  assert.equal(await desktop.locator('.finder-sidebar').count(), 0);
  await options.getByLabel('Utiliser cette présentation pour ce dossier').check();
  await options.getByLabel('Position des noms').selectOption('right');
  await options.getByLabel('Afficher les vignettes d’image').check();
  await desktop.keyboard.press('Escape');
  await desktop.locator('.finder-label-right').waitFor();
  await entry(desktop, picture).locator('.finder-icon-thumbnail').waitFor();
  const preview = desktop.getByRole('complementary', { name: 'Prévisualisation' });
  await entry(desktop, notes).click();
  await preview.getByText('Un aperçu en français.', { exact: true }).waitFor();
  assert.equal(await preview.getByText('Modification', { exact: true }).count(), 1);
  await control(preview, 'Ouvrir en grand').click();
  await desktop.getByRole('dialog').getByText('Un aperçu en français.', { exact: true }).waitFor();
  await desktop.keyboard.press('Escape');
  await control(desktop, 'Dossier parent').click();
  await desktop.waitForURL(href(root));
  await desktop.locator('.finder-label-below').waitFor();
  await control(desktop, 'Précédent').click();
  await desktop.waitForURL(href(lesson));
  await desktop.locator('.finder-label-right').waitFor();
  await desktop.reload();
  await desktop.locator('.finder-label-right').waitFor();
  await preview.waitFor();
  await control(preview, 'Masquer la prévisualisation').click();
  assert.equal(await preview.count(), 0);
  await control(desktop, 'Affichage : Liste').click();
  await optionsButton.click();
  await options.getByLabel('Colonne : Modification').uncheck();
  await options.getByLabel('Colonne : Type').uncheck();
  await desktop.keyboard.press('Escape');
  assert.equal(await desktop.locator('.finder-list-header button').count(), 2);
  assert.deepEqual(await desktop.locator('.finder-list-header button').allTextContents(), ['Nom↑', 'Taille']);

  // The HTTP connection stays open until after a wheel scroll and two further deltas.
  await control(desktop, 'Assistant').click();
  const question = desktop.getByLabel('Question à l’assistant');
  await question.fill('Une longue réponse');
  const connected = desktop.waitForResponse((res) => res.url() === `${base}/api/chat` && res.status() === 200);
  await question.press('Enter');
  await connected;
  const log = desktop.locator('.library-chat-log');
  const first = Array.from({ length: 74 }, (_, n) => `Paragraphe ${n + 1} de la réponse de test.`).join('\n\n');
  emit('delta', { text: first });
  await log.getByText('Paragraphe 74 de la réponse de test.').waitFor();
  const nearBottom = () => desktop.waitForFunction(() => {
    const node = document.querySelector('.library-chat-log');
    return node && node.scrollHeight - node.scrollTop - node.clientHeight < 4;
  });
  await nearBottom();
  await log.hover();
  await desktop.mouse.wheel(0, -560);
  const jump = control(desktop, 'Derniers messages');
  await jump.waitFor();
  const readingAt = await log.evaluate((node) => node.scrollTop);
  const second = '\n\nLa réponse continue pendant la lecture.';
  emit('delta', { text: second });
  await log.getByText('La réponse continue pendant la lecture.').waitFor();
  assert.equal(await log.evaluate((node) => node.scrollTop), readingAt);
  await jump.click();
  await nearBottom();
  await log.hover();
  await desktop.mouse.wheel(0, -410);
  await jump.waitFor();
  const beforeDone = await log.evaluate((node) => node.scrollTop);
  emit('done', { answer: `${first}${second}\n\nFin du flux.` });
  sse.end();
  await log.getByText('Fin du flux.').waitFor();
  assert.equal(await log.evaluate((node) => node.scrollTop), beforeDone);
  await jump.click();
  await nearBottom();
  await desktop.close();

  userId = null;
  const mobile = await browser.newPage({ viewport: { width: 360, height: 750 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await stub(mobile);
  await mobile.goto(href(lesson));
  await control(mobile, 'Affichage : Colonnes').tap();
  assert.equal(await mobile.locator('.finder-column:visible').count(), 1);
  await entry(mobile, offline).tap();
  await mobile.waitForURL(href(offline));
  await mobile.getByText('Contenu indisponible hors ligne', { exact: true }).waitFor();
  await control(mobile, 'Dossier parent').tap();
  await mobile.waitForURL(href(lesson));
  await control(mobile, 'Affichage : Icônes').tap();
  await entry(mobile, notes).tap();
  await mobile.getByText('Un aperçu en français.', { exact: true }).waitFor();
  await mobile.keyboard.press('Escape');
  await control(mobile, 'Prévisualisation').tap();
  await entry(mobile, notes).tap();
  await mobile.getByRole('complementary', { name: 'Prévisualisation' }).getByText('Un aperçu en français.', { exact: true }).waitFor();
  assert.equal(await mobile.getByRole('dialog').count(), 0);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(runtimeErrors, []);
  console.log('Finder : bureau et mobile ; assistant : défilement pendant un flux SSE validé.');
} finally {
  if (sse && !sse.writableEnded) sse.end();
  await browser?.close();
  await vite.close();
}
