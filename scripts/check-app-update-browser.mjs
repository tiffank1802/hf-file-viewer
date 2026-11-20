/* global window */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const { id } = JSON.parse(await readFile(new URL('../dist/version.json', import.meta.url), 'utf8'));
const next = id.replace(/^./, id[0] === 'a' ? 'b' : 'a');
const server = await preview({ preview: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({ executablePath: process.env.FINDER_CHROMIUM || undefined });
  const page = await browser.newPage();
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
  await page.clock.install();
  let remote = id;
  await page.route('**/version.json', (route) => route.fulfill({ json: { id: remote } }));
  const manifest = () => page.waitForResponse((response) => new URL(response.url()).pathname === '/version.json');
  const banner = page.getByRole('complementary', { name: 'Mise à jour de l’application' });
  let checked = manifest();
  await page.goto(url);
  await checked;
  await page.evaluate(() => { window.updateTestSentinel = 'unchanged page'; });
  assert.equal(await banner.count(), 0);
  remote = next;
  checked = manifest();
  await page.clock.fastForward(31_000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await checked;
  await banner.waitFor();
  await banner.getByRole('button', { name: 'Plus tard' }).click();
  await banner.waitFor({ state: 'hidden' });
  checked = manifest();
  await page.clock.fastForward(300_000);
  await checked;
  assert.equal(await page.evaluate(() => window.updateTestSentinel), 'unchanged page');
  assert.equal(await banner.count(), 0);
  await page.reload();
  await banner.waitFor();
  remote = id;
  await Promise.all([
    page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
    banner.getByRole('button', { name: 'Mettre à jour' }).click(),
  ]);
  await banner.waitFor({ state: 'hidden' });
  console.log('Mise à jour web : détection, report sans rechargement et actualisation choisie validés.');
} finally {
  await browser?.close();
  await server.close();
}
