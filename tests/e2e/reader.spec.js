import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const PDF_FIXTURE = fileURLToPath(new URL('../fixtures/reader-r6.pdf', import.meta.url));
const PDF_PATH = 'Fixtures/reader-r6.pdf';
const SOURCE_PATH = 'Fixtures/energie.md';
const ARTIFACT_ID = 'artifact-e2e';
const BLOCK_TEXT = 'L’énergie cinétique dépend de la masse et du carré de la vitesse.';

async function mockReaderAPI(page) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });

    if (url.pathname === '/api/auth/session') {
      return json({ configured: true, profileTable: true, user: { id: 'e2e-user', name: 'Test' }, profile: null });
    }
    if (url.pathname === '/api/reader/document') {
      return json({
        schemaVersion: 'reader-ui/v1',
        sourcePath: SOURCE_PATH,
        artifactId: ARTIFACT_ID,
        title: 'Énergie — fixture navigateur',
        kind: 'text',
        status: 'structured-ready',
        pageCount: 1,
        blockCount: 2,
        capabilities: { pdf: false, structured: true, selectionAI: true, annotations: true },
        outline: [{ blockId: 'b-energy', label: 'Énergie cinétique', level: 1, page: 1, ordinal: 1 }],
      });
    }
    if (url.pathname === '/api/reader/blocks') {
      return json({
        schemaVersion: 'reader-ui/v1',
        sourcePath: SOURCE_PATH,
        artifactId: ARTIFACT_ID,
        total: 2,
        nextFrom: 0,
        blocks: [
          { id: 'b-title', ordinal: 1, level: 1, type: 'title', text: 'Énergie cinétique', page: 1 },
          { id: 'b-energy', ordinal: 2, type: 'text', text: BLOCK_TEXT, page: 1, headingPath: ['Énergie cinétique'] },
        ],
      });
    }
    if (url.pathname === '/api/annotations' && request.method() === 'GET') {
      return json({ ok: true, items: [] });
    }
    if (url.pathname === '/api/annotations' && request.method() === 'POST') {
      const body = request.postDataJSON();
      return json({
        ok: true,
        item: {
          id: 'annotation-e2e',
          artifactId: ARTIFACT_ID,
          blockId: body.anchor.blockId,
          page: body.anchor.page,
          anchor: body.anchor,
          kind: body.kind,
          color: body.color,
          body: body.body,
          status: 'active',
        },
      }, 201);
    }
    if (url.pathname === '/api/chat') {
      const citation = {
        citationId: 'S1',
        sourcePath: SOURCE_PATH,
        page: 1,
        blockIds: ['b-energy'],
        headingPath: ['Énergie cinétique'],
      };
      const body = [
        'event: scope',
        `data: ${JSON.stringify({ status: 'structured-ready', anchor: { verified: true } })}`,
        '',
        'event: citations',
        `data: ${JSON.stringify({ citations: [citation] })}`,
        '',
        'event: delta',
        `data: ${JSON.stringify({ text: 'La vitesse intervient au carré [S1].' })}`,
        '',
        'event: done',
        `data: ${JSON.stringify({ answer: 'La vitesse intervient au carré [S1].', citations: [citation] })}`,
        '',
        '',
      ].join('\n');
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
    }
    if (url.pathname === '/api/reader/metrics') {
      return route.fulfill({ status: 204, body: '' });
    }
    return json({ error: `Route mock absente: ${url.pathname}` }, 404);
  });
}

async function mockPdfAPI(page) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    if (url.pathname === '/api/auth/session') {
      return json({ configured: true, profileTable: true, user: null, profile: null });
    }
    if (url.pathname === '/api/reader/document') {
      return json({
        schemaVersion: 'reader-ui/v1',
        sourcePath: PDF_PATH,
        artifactId: 'artifact-pdf-e2e',
        title: 'PDF fixture R6',
        kind: 'pdf',
        status: 'structured-ready',
        pageCount: 1,
        blockCount: 1,
        capabilities: { pdf: true, structured: true, selectionAI: true, annotations: false },
        outline: [{ blockId: 'b-pdf', label: 'Énergie cinétique', level: 1, page: 1, ordinal: 1 }],
      });
    }
    if (url.pathname === '/api/file') {
      return route.fulfill({ status: 200, contentType: 'application/pdf', path: PDF_FIXTURE });
    }
    if (url.pathname === '/api/reader/metrics') {
      return route.fulfill({ status: 204, body: '' });
    }
    return json({ error: `Route mock absente: ${url.pathname}` }, 404);
  });
}

async function selectStructuredText(page) {
  await page.locator('#reader-block-b-energy').waitFor();
  await page.locator('#reader-block-b-energy').evaluate((element) => {
    const text = element.querySelector('p')?.firstChild;
    if (!text) throw new Error('Texte fixture absent');
    const start = text.textContent.indexOf('énergie cinétique');
    const owner = element.ownerDocument;
    const range = owner.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + 'énergie cinétique'.length);
    const selection = owner.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new owner.defaultView.PointerEvent('pointerup', { bubbles: true }));
  });
  await expect(page.getByRole('toolbar', { name: 'Actions sur la sélection' })).toBeVisible();
}

test('le PDF fixture expose une page et une couche texte sélectionnable', async ({ page }) => {
  await mockPdfAPI(page);
  await page.goto(`/read?path=${encodeURIComponent(PDF_PATH)}`);
  const pdfPage = page.locator('[data-reader-page="1"]');
  await expect(pdfPage).toBeVisible();
  await expect(pdfPage.locator('.reader-pdf-text')).toContainText('Energie cinetique');
  await expect(pdfPage.locator('canvas')).toBeVisible();
});

test('sélection structurée → IA citée → retour au bloc → note persistée', async ({ page }, testInfo) => {
  const isMobile = testInfo.project.name === 'mobile-chromium';
  await mockReaderAPI(page);
  await page.goto(`/read?path=${encodeURIComponent(SOURCE_PATH)}`);

  await expect(page.getByRole('heading', { name: 'Énergie cinétique' })).toBeVisible();
  await selectStructuredText(page);
  await page.getByRole('button', { name: 'Expliquer' }).click();

  await expect(page.getByText('La vitesse intervient au carré')).toBeVisible();
  await page.locator('.library-chat-citation').first().click();
  await expect(page.locator('#reader-block-b-energy')).toHaveClass(/focused/);

  if (isMobile) {
    await page.getByRole('button', { name: 'Masquer l’assistant' }).click();
  }
  await selectStructuredText(page);
  await page.getByRole('button', { name: 'Ajouter une note' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ajouter une note privée' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Note').fill('Revoir la dépendance quadratique.');
  await dialog.getByRole('button', { name: 'Enregistrer la note' }).click();

  await expect(page.getByText('Revoir la dépendance quadratique.')).toBeVisible();
  await expect(page.locator('.reader-annotation-item')).toHaveCount(1);
});

test('les panneaux du lecteur restent accessibles sur mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'Scénario réservé au viewport mobile.');
  await mockReaderAPI(page);
  await page.goto(`/read?path=${encodeURIComponent(SOURCE_PATH)}`);
  await expect(page.getByRole('button', { name: 'Afficher le plan et les notes' })).toBeVisible();
  await page.getByRole('button', { name: 'Afficher le plan et les notes' }).click();
  await expect(page.getByRole('complementary', { name: 'Plan et annotations du document' })).toBeVisible();
  await page.getByRole('button', { name: 'Fermer le plan et les notes' }).click();
  await expect(page.getByRole('complementary', { name: 'Plan et annotations du document' })).toHaveCount(0);
});
