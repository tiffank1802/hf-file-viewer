import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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

async function mockUnifiedPDF(page, { ranges = false, scanned = false, fixture = PDF_FIXTURE } = {}) {
  const state = {
    revision: `etag-sha256:${'a'.repeat(64)}`, strategy: 'strong-etag', annotations: [], chats: [],
    doclingCalls: 0, ranges: [], failFile: false, structuredReady: false,
    doclingGate: null, annotationGate: null, annotationWrites: 0,
    annotationListGate: null, annotationLists: 0, annotationWarning: '',
  };
  let pdfBytes = typeof fixture === 'string' ? await readFile(fixture) : fixture;
  if (scanned) {
    const withoutText = pdfBytes.toString('latin1')
      .replace('Energie cinetique - lecteur R6', ' '.repeat('Energie cinetique - lecteur R6'.length))
      .replace('La vitesse intervient au carre.', ' '.repeat('La vitesse intervient au carre.'.length));
    pdfBytes = Buffer.from(withoutText, 'latin1');
  }
  const legacy = {
    id: 'old-note', artifactId: 'old-docling', legacy: true, status: 'needs-review',
    kind: 'note', color: 'yellow', body: 'Ancienne note conservée', page: 1,
    anchor: { page: 1, quote: 'Ancien passage' },
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/auth/session') return json({ configured: true, profileTable: true, user: { id: 'e2e-user', name: 'Test' }, profile: null });
    if (url.pathname === '/api/reader/document') {
      state.doclingCalls += 1;
      if (state.doclingGate) await state.doclingGate;
      if (!state.structuredReady) return json({ error: 'Docling indisponible' }, 503);
      return json({ sourcePath: PDF_PATH, kind: 'pdf', status: 'structured-ready', artifactId: 'docling-test', pageCount: 1, capabilities: { pdf: true, structured: true }, outline: [] });
    }
    if (url.pathname === '/api/reader/blocks') return json({
      sourcePath: PDF_PATH, artifactId: 'docling-test', total: 1, nextFrom: 0,
      blocks: [{ id: 'b-structured', ordinal: 1, type: 'text', page: 1, text: 'Un passage restructuré par Docling.' }],
    });
    if (url.pathname === '/api/reader/pdf-revision') return json({ sourcePath: PDF_PATH, revision: state.revision, strategy: state.strategy, size: pdfBytes.length, maxHashBytes: 67108864 });
    if (url.pathname === '/api/file') {
      if (state.failFile) return json({ error: 'Le PDF a changé pendant sa lecture.' }, 409);
      const header = request.headers().range;
      if (ranges && header) {
        state.ranges.push(header);
        const match = /^bytes=(\d+)-(\d+)$/.exec(header);
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), pdfBytes.length - 1);
        return route.fulfill({ status: 206, headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'Content-Range': `bytes ${start}-${end}/${pdfBytes.length}`, 'Accept-Ranges': 'bytes' }, body: pdfBytes.subarray(start, end + 1) });
      }
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' }, body: pdfBytes });
    }
    if (url.pathname === '/api/reader/metrics') return route.fulfill({ status: 204, body: '' });
    if (url.pathname === '/api/annotations' && request.method() === 'GET') {
      const requestedRevision = url.searchParams.get('sourceRevision');
      state.annotationLists += 1;
      const items = structuredClone([
        ...state.annotations.map((item) => ({ ...item, status: item.sourceRevision === requestedRevision ? 'active' : 'needs-review' })), legacy,
      ]);
      if (state.annotationListGate) await state.annotationListGate;
      return json({ ok: true, enabled: true, storageAvailable: true, sourceRevision: requestedRevision, items, warning: state.annotationWarning });
    }
    if (url.pathname === '/api/annotations' && request.method() === 'POST') {
      const input = request.postDataJSON();
      state.annotationWrites += 1;
      if (state.annotationGate) await state.annotationGate;
      const item = { id: `pdfv2:note-${state.annotations.length + 1}`, ...input, page: input.anchor.page, status: 'active' };
      state.annotations.unshift(item);
      return json({ ok: true, item }, 201);
    }
    if (url.pathname.startsWith('/api/annotations/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/annotations/'.length));
      const item = state.annotations.find((entry) => entry.id === id);
      if (!item) return json({ error: 'Annotation absente' }, 404);
      if (request.method() === 'PATCH') {
        Object.assign(item, request.postDataJSON());
        return json({ ok: true, item });
      }
      if (request.method() === 'DELETE') {
        state.annotations = state.annotations.filter((entry) => entry.id !== id);
        return json({ ok: true });
      }
    }
    if (url.pathname === '/api/chat' && request.method() === 'POST') {
      const body = request.postDataJSON();
      state.chats.push(body);
      if (body.message.includes('attendre')) await new Promise((resolve) => setTimeout(resolve, 4000));
      const anchor = body.scope.anchor;
      const passage = body.scope.pdfContext?.passages?.[0];
      const citation = { citationId: 'S1', sourcePath: PDF_PATH, sourceRevision: body.scope.sourceRevision, page: anchor?.page || passage?.page || 1, segments: anchor?.segments, origin: 'pdf-text', verified: false };
      const coverage = { kind: 'partial-pdf-reader', indexedPages: 1, totalPages: 1 };
      const events = [
        ['scope', { status: 'pdf-ready', knowledgeSource: 'pdf-reader', anchor: { verified: false } }],
        ['citations', { citations: [citation], coverage }],
        ['delta', { text: 'La vitesse intervient au carré [S1].' }],
        ['done', { answer: 'La vitesse intervient au carré [S1].', citations: [citation], coverage }],
      ];
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `${events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')}\n` }).catch(() => {});
    }
    return json({ error: `Route mock absente : ${url.pathname}` }, 404);
  });
  return state;
}

async function selectPDFText(page) {
  await expect(page.locator('.reader-pdf-text span').filter({ hasText: 'Energie cinetique' }).first()).toBeVisible();
  await page.locator('.reader-pdf-text span').filter({ hasText: 'Energie cinetique' }).first().evaluate((span) => {
    const owner = span.ownerDocument;
    const range = owner.createRange();
    range.selectNodeContents(span);
    const selection = owner.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    span.dispatchEvent(new owner.defaultView.PointerEvent('pointerup', { bubbles: true }));
  });
  await expect(page.getByRole('toolbar', { name: 'Actions sur la sélection' })).toBeVisible();
}

test('PDF unifié : note privée, réouverture, zoom, ancienne version et question globale sans Docling', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Le parcours tactile est couvert séparément.');
  const state = await mockUnifiedPDF(page);
  await page.goto(`/read?path=${encodeURIComponent(PDF_PATH)}`);
  await selectPDFText(page);
  await expect(page.getByRole('button', { name: 'Ajouter une note' })).toBeEnabled();
  await page.getByRole('button', { name: 'Ajouter une note' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ajouter une note privée' });
  await dialog.getByLabel('Note').fill('Note privée sur la vitesse.');
  await dialog.getByRole('button', { name: 'Enregistrer la note' }).click();
  await expect(page.getByText('Note privée sur la vitesse.')).toBeVisible();
  expect(state.annotations).toHaveLength(1);
  expect(state.annotations[0].anchor.schemaVersion).toBe('pdf-anchor/v1');
  expect(state.annotations[0].anchor.sourceRevision).toBe(state.revision);
  expect(state.annotations[0].anchor.segments[0].quads.length).toBeGreaterThan(0);
  const marker = page.locator('.reader-highlight.annotation').first();
  await expect(marker).toBeVisible();
  const before = await marker.evaluate((element) => ({ left: element.style.left, top: element.style.top, width: element.style.width }));
  await page.getByRole('button', { name: 'Augmenter le zoom' }).click();
  await expect.poll(async () => marker.evaluate((element) => element.style.left)).toBe(before.left);
  const after = await marker.evaluate((element) => ({ left: element.style.left, top: element.style.top, width: element.style.width }));
  expect(after).toEqual(before);

  await page.reload();
  await expect(page.locator('.reader-highlight.annotation').first()).toBeVisible();
  await page.getByRole('tab', { name: /Notes/ }).click();
  await expect(page.getByText('Note privée sur la vitesse.')).toBeVisible();
  const oldNote = page.locator('.reader-annotation-item').filter({ hasText: 'Ancienne note conservée' });
  await expect(oldNote).toContainText('À vérifier');
  await oldNote.locator('.reader-annotation-target').click();
  await expect(page.getByText(/doit être vérifiée avant de la positionner/)).toBeVisible();

  if (!(await page.getByRole('button', { name: 'Masquer l’assistant' }).isVisible())) await page.getByRole('button', { name: 'Afficher l’assistant' }).click();
  await expect(page.getByText(/Index local : 1\/1 pages/)).toBeVisible();
  await page.getByLabel('Question à l’assistant du document').fill('Que dit le PDF sur la vitesse ?');
  await page.getByRole('button', { name: 'Envoyer la question' }).click();
  await expect(page.getByText(/La vitesse intervient au carré/).first()).toBeVisible();
  expect(state.chats.at(-1).scope.sourceRevision).toBe(state.revision);
  expect(state.chats.at(-1).scope.pdfContext.passages[0].text).toContain('vitesse');
  expect(state.chats.at(-1).scope.artifactId).toBeUndefined();
  await expect(page.getByText(/texte du lecteur n’est pas vérifié par le serveur/i)).toBeVisible();

  state.revision = `etag-sha256:${'b'.repeat(64)}`;
  await page.reload();
  await expect(page.locator('.reader-pdf-text span').first()).toBeVisible();
  await page.getByRole('tab', { name: /Notes/ }).click();
  const saved = page.locator('.reader-annotation-item').filter({ hasText: 'Note privée sur la vitesse.' });
  await expect(saved).toContainText('À vérifier');
  await expect(page.locator('.reader-highlight.annotation')).toHaveCount(0);
  await saved.locator('.reader-annotation-target').click();
  await expect(page.getByText(/doit être vérifiée avant de la positionner/)).toBeVisible();
});

test('PDF unifié : citation de sélection et annulation de la réponse', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Parcours desktop.');
  const state = await mockUnifiedPDF(page);
  await page.goto(`/read?path=${encodeURIComponent(PDF_PATH)}`);
  await selectPDFText(page);
  await page.getByRole('button', { name: 'Expliquer', exact: true }).click();
  await expect(page.getByText(/La vitesse intervient au carré/).first()).toBeVisible();
  expect(state.chats[0].scope.anchor.schemaVersion).toBe('pdf-anchor/v1');
  expect(state.chats[0].scope.anchor.segments).toHaveLength(1);
  await page.locator('.reader-answer-citations .library-chat-citation').first().click();
  await expect(page.locator('.reader-highlight.citation').first()).toBeVisible();
  await page.getByLabel('Question à l’assistant du document').fill('Peux-tu attendre ?');
  await page.getByRole('button', { name: 'Envoyer la question' }).click();
  await page.getByRole('button', { name: 'Annuler la réponse' }).click();
  await expect(page.getByText('Demande annulée.', { exact: true }).first()).toBeVisible();
  await page.getByLabel('Question à l’assistant du document').fill('Explique encore.');
  await page.getByRole('button', { name: 'Envoyer la question' }).click();
  await expect(page.locator('.reader-message.assistant').last()).toContainText('La vitesse intervient au carré');
});

test('PDF unifié sur viewport tactile : sélection et enregistrement sans Docling', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'Viewport mobile seulement.');
  const state = await mockUnifiedPDF(page);
  await page.goto(`/read?path=${encodeURIComponent(PDF_PATH)}`);
  await selectPDFText(page);
  await page.getByRole('button', { name: 'Ajouter une note' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ajouter une note privée' });
  await dialog.getByLabel('Note').fill('Note sur téléphone.');
  await dialog.getByRole('button', { name: 'Enregistrer la note' }).click();
  await expect(page.getByText('Note sur téléphone.')).toBeVisible();
  expect(state.annotations[0].sourceRevision).toBe(state.revision);
});

test('PDF unifié : repli SHA-256 sur les octets affichés sans ETag fort', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Scénario desktop.');
  const state = await mockUnifiedPDF(page);
  state.strategy = 'sha256';
  state.revision = '';
  await page.goto(`/read?path=${encodeURIComponent(PDF_PATH)}`);
  await selectPDFText(page);
  await expect(page.getByRole('button', { name: 'Ajouter une note' })).toBeEnabled();
  await page.getByRole('button', { name: 'Ajouter une note' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ajouter une note privée' });
  await dialog.getByLabel('Note').fill('Empreinte du PDF local.');
  await dialog.getByRole('button', { name: 'Enregistrer la note' }).click();
  await expect(page.getByText('Empreinte du PDF local.')).toBeVisible();
  const expected = `sha256:${createHash('sha256').update(await readFile(PDF_FIXTURE)).digest('hex')}`;
  expect(state.annotations[0].sourceRevision).toBe(expected);
  expect(state.annotations[0].anchor.sourceRevision).toBe(expected);
});

test('PDF unifié : page sans texte signale le besoin d’OCR sans envoyer de faux extraits', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Scénario desktop.');
  const state = await mockUnifiedPDF(page, { scanned: true });
  await page.goto(`/read?path=${encodeURIComponent(PDF_PATH)}`);
  await expect(page.getByText(/Aucun texte sélectionnable détecté sur cette page/)).toBeVisible();
  await expect(page.getByText(/Index local : 1\/1 pages/)).toBeVisible();
  await page.getByLabel('Question à l’assistant du document').fill('Que contient ce scan ?');
  await page.getByRole('button', { name: 'Envoyer la question' }).click();
  await expect(page.getByText(/Aucun texte disponible dans l’index/)).toBeVisible();
  expect(state.chats).toHaveLength(0);
});

test('PDF unifié : transport Tauri simulé utilise une plage pour ouvrir le PDF', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Simulation de la WebView Tauri.');
  const state = await mockUnifiedPDF(page, { ranges: true });
  await page.addInitScript(() => {
    globalThis.isTauri = true;
    globalThis.__TAURI_INTERNALS__ = { convertFileSrc: () => globalThis.location.origin };
  });
  await page.goto(`/read?path=${encodeURIComponent(PDF_PATH)}`);
  await selectPDFText(page);
  expect(state.ranges[0]).toBe('bytes=0-262143');
  await page.getByRole('button', { name: 'Surligner', exact: true }).click();
  await expect(page.locator('.reader-highlight.annotation').first()).toBeVisible();
  expect(state.annotations[0].sourceRevision).toBe(state.revision);
});

test('PDF unifié : réessayer recharge la révision après une erreur de lecture', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Scénario desktop.');
  const state = await mockUnifiedPDF(page);
  state.failFile = true;
  await page.goto(`/read?path=${encodeURIComponent(PDF_PATH)}`);
  await expect(page.getByText('Le lecteur PDF interactif est indisponible.')).toBeVisible();
  state.failFile = false;
  state.revision = `etag-sha256:${'b'.repeat(64)}`;
  await page.locator('.reader-pdf-error').getByRole('button', { name: 'Réessayer' }).click();
  await selectPDFText(page);
  await page.getByRole('button', { name: 'Surligner', exact: true }).click();
  await expect(page.locator('.reader-highlight.annotation').first()).toBeVisible();
  expect(state.annotations[0].sourceRevision).toBe(state.revision);
});

function twoPagePDF() {
  const stream = (text) => {
    const content = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
    return `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
  };
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [30 40 580 750] /Rotate 90 /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream('Energie cinetique - premiere page'),
    stream('La vitesse intervient au carre.'),
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => { output += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  output += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

test('PDF unifié : sélection multipages avec rotation et CropBox conserve deux zones', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Scénario desktop.');
  const state = await mockUnifiedPDF(page, { fixture: twoPagePDF() });
  await page.goto(`/read?path=${encodeURIComponent(PDF_PATH)}`);
  const first = page.locator('[data-reader-page="1"] .reader-pdf-text span').filter({ hasText: 'Energie cinetique' }).first();
  const second = page.locator('[data-reader-page="2"] .reader-pdf-text span').filter({ hasText: 'La vitesse' }).first();
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await first.evaluate((start) => {
    const owner = start.ownerDocument;
    const end = owner.querySelector('[data-reader-page="2"] .reader-pdf-text span');
    const range = owner.createRange();
    range.setStart(start.firstChild, 0);
    range.setEnd(end.firstChild, end.firstChild.textContent.length);
    const selection = owner.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    start.dispatchEvent(new owner.defaultView.PointerEvent('pointerup', { bubbles: true }));
  });
  await expect(page.getByRole('toolbar', { name: 'Actions sur la sélection' })).toBeVisible();
  await page.getByRole('button', { name: 'Surligner', exact: true }).click();
  await expect.poll(() => state.annotations.length).toBe(1);
  const anchor = state.annotations[0].anchor;
  expect(anchor.segments.map((segment) => segment.page)).toEqual([1, 2]);
  expect(anchor.segments[1].pageView).toEqual([30, 40, 580, 750]);
  expect(anchor.quote).toContain('premiere page La vitesse');
  await expect(page.locator('[data-reader-page="1"] .reader-highlight.annotation').first()).toBeVisible();
  await expect(page.locator('[data-reader-page="2"] .reader-highlight.annotation').first()).toBeAttached();
});

test('PDF unifié : changer de mode abandonne la sélection précédente sans mélanger les ancres', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Scénario desktop.');
  const state = await mockUnifiedPDF(page);
  state.structuredReady = true;
  await page.goto(`/read?path=${encodeURIComponent(PDF_PATH)}`);
  await selectPDFText(page);
  await page.getByRole('button', { name: 'Structuré', exact: true }).click();
  await expect(page.getByRole('toolbar', { name: 'Actions sur la sélection' })).toHaveCount(0);
  await expect(page.getByText('Un passage restructuré par Docling.')).toBeVisible();
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  await expect(page.getByRole('toolbar', { name: 'Actions sur la sélection' })).toHaveCount(0);
  await selectPDFText(page);
  await page.getByRole('button', { name: 'Surligner', exact: true }).click();
  await expect.poll(() => state.annotations.length).toBe(1);
  expect(state.annotations[0].anchor.schemaVersion).toBe('pdf-anchor/v1');
  expect(state.annotations[0].anchor.blockId).toBeUndefined();
});

test('PDF unifié sur mobile : expliquer une sélection ouvre le flux IA sans annulation intempestive', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'Scénario réservé au viewport tactile.');
  const state = await mockUnifiedPDF(page);
  await page.goto(`/read?path=${encodeURIComponent(PDF_PATH)}`);
  await selectPDFText(page);
  await page.getByRole('button', { name: 'Expliquer', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Assistant du document' })).toBeVisible();
  await expect(page.getByText('La vitesse intervient au carré')).toBeVisible();
  await expect(page.getByText('Demande annulée.', { exact: true })).toHaveCount(0);
  expect(state.chats).toHaveLength(1);
  expect(state.chats[0].scope.anchor.schemaVersion).toBe('pdf-anchor/v1');
});

test('PDF unifié : un double clic rapide ne lance pas deux réponses concurrentes', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Scénario desktop.');
  const state = await mockUnifiedPDF(page);
  await page.goto(`/read?path=${encodeURIComponent(PDF_PATH)}`);
  await selectPDFText(page);
  await page.getByRole('button', { name: 'Expliquer', exact: true }).evaluate((button) => {
    button.click();
    button.click();
  });
  await expect(page.locator('.reader-message.assistant').last()).toContainText('La vitesse intervient au carré');
  expect(state.chats).toHaveLength(1);
});

test('PDF unifié : l’arrivée tardive de Docling ne perd pas une note PDF en cours', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Scénario desktop.');
  const state = await mockUnifiedPDF(page);
  let releaseMetadata;
  let releaseWrite;
  state.structuredReady = true;
  state.doclingGate = new Promise((resolve) => { releaseMetadata = resolve; });
  state.annotationGate = new Promise((resolve) => { releaseWrite = resolve; });
  try {
    await page.goto(`/read?path=${encodeURIComponent(PDF_PATH)}`);
    await selectPDFText(page);
    await page.getByRole('button', { name: 'Ajouter une note', exact: true }).click();
    const composer = page.getByRole('dialog', { name: 'Ajouter une note privée' });
    await composer.getByLabel('Note').fill('Note pendant l’arrivée de Docling.');
    await composer.getByRole('button', { name: 'Enregistrer la note' }).click();
    await expect.poll(() => state.annotationWrites).toBe(1);
    state.doclingGate = null;
    releaseMetadata();
    await expect(page.getByRole('button', { name: 'Structuré', exact: true })).toBeVisible();
    // Let React commit the metadata-dependent effects before the write returns.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    state.annotationGate = null;
    releaseWrite();
    await expect(composer).toBeHidden();
    await expect(page.getByText('Note pendant l’arrivée de Docling.', { exact: true })).toBeVisible();
    await expect(page.locator('.reader-highlight.annotation').first()).toBeVisible();
  } finally {
    releaseMetadata();
    releaseWrite();
  }
});

test('PDF unifié : actualiser une liste lente ne rétablit ni une ancienne note ni une suppression', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Scénario desktop.');
  const state = await mockUnifiedPDF(page);
  state.annotationWarning = 'Synchronisation à vérifier.';
  await page.goto(`/read?path=${encodeURIComponent(PDF_PATH)}`);
  await selectPDFText(page);
  await page.getByRole('button', { name: 'Ajouter une note', exact: true }).click();
  const composer = page.getByRole('dialog', { name: 'Ajouter une note privée' });
  await composer.getByLabel('Note').fill('Avant modification.');
  await composer.getByRole('button', { name: 'Enregistrer la note' }).click();
  await expect(composer).toBeHidden();
  await page.reload();
  await page.getByRole('tab', { name: /Notes/ }).click();
  const panel = page.locator('#reader-annotations-panel');
  await expect(panel.getByText('Avant modification.', { exact: true })).toBeVisible();
  await expect(panel.getByText('Synchronisation à vérifier.')).toBeVisible();

  let release;
  try {
    const beforeUpdateLoad = state.annotationLists;
    state.annotationListGate = new Promise((resolve) => { release = resolve; });
    await panel.getByRole('button', { name: 'Réessayer' }).click();
    await expect.poll(() => state.annotationLists).toBeGreaterThan(beforeUpdateLoad);
    const item = panel.locator('.reader-annotation-item').filter({ hasText: 'Avant modification.' });
    await item.getByRole('button', { name: 'Modifier' }).click();
    const editor = panel.locator('.reader-annotation-edit');
    await editor.locator('textarea').fill('Après modification.');
    await editor.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await expect(panel.getByText('Après modification.', { exact: true })).toBeVisible();
    state.annotationListGate = null;
    release();
    await expect.poll(() => state.annotationLists).toBeGreaterThan(beforeUpdateLoad + 1);
    await expect(panel.getByText('Après modification.', { exact: true })).toBeVisible();
    await expect(panel.getByText('Avant modification.', { exact: true })).toHaveCount(0);
    await expect(panel.getByText('Synchronisation à vérifier.')).toBeVisible();

    const beforeDeleteLoad = state.annotationLists;
    state.annotationListGate = new Promise((resolve) => { release = resolve; });
    await panel.getByRole('button', { name: 'Réessayer' }).click();
    await expect.poll(() => state.annotationLists).toBeGreaterThan(beforeDeleteLoad);
    page.once('dialog', (dialog) => dialog.accept());
    await panel.locator('.reader-annotation-item').filter({ hasText: 'Après modification.' }).getByRole('button', { name: 'Supprimer' }).click();
    await expect(panel.getByText('Après modification.', { exact: true })).toHaveCount(0);
    state.annotationListGate = null;
    release();
    await expect.poll(() => state.annotationLists).toBeGreaterThan(beforeDeleteLoad + 1);
    await expect(panel.getByText('Après modification.', { exact: true })).toHaveCount(0);
    await expect(page.locator('.reader-highlight.annotation')).toHaveCount(0);
    await expect(panel.getByText('Ancienne note conservée', { exact: true })).toBeVisible();
  } finally {
    release?.();
  }
});

test('PDF unifié : double clic et changement de mode isolent les écritures en cours', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Scénario desktop.');
  const state = await mockUnifiedPDF(page);
  state.structuredReady = true;
  let releaseOld;
  let releaseNew;
  state.annotationGate = new Promise((resolve) => { releaseOld = resolve; });
  try {
    await page.goto(`/read?path=${encodeURIComponent(PDF_PATH)}`);
    await expect(page.getByRole('button', { name: 'Structuré', exact: true })).toBeVisible();
    await selectPDFText(page);
    await page.getByRole('button', { name: 'Ajouter une note', exact: true }).click();
    const oldComposer = page.getByRole('dialog', { name: 'Ajouter une note privée' });
    await oldComposer.getByLabel('Note').fill('Première écriture en attente.');
    // Two clicks in one task happen before React can repaint the disabled state.
    await oldComposer.getByRole('button', { name: 'Enregistrer la note' }).evaluate((button) => { button.click(); button.click(); });
    await expect.poll(() => state.annotationWrites).toBe(1);
    await oldComposer.getByRole('button', { name: 'Fermer', exact: true }).click();
    await page.getByRole('button', { name: 'Structuré', exact: true }).click();
    await page.getByRole('button', { name: 'PDF', exact: true }).click();

    state.annotationGate = new Promise((resolve) => { releaseNew = resolve; });
    await selectPDFText(page);
    await page.getByRole('button', { name: 'Ajouter une note', exact: true }).click();
    const newComposer = page.getByRole('dialog', { name: 'Ajouter une note privée' });
    await newComposer.getByLabel('Note').fill('Nouvelle écriture en attente.');
    await newComposer.getByRole('button', { name: 'Enregistrer la note' }).click();
    await expect.poll(() => state.annotationWrites).toBe(2);
    releaseOld();
    await expect.poll(() => state.annotations.length).toBe(1);
    await expect(newComposer.getByRole('button', { name: 'Enregistrement…' })).toBeDisabled();
    state.annotationGate = null;
    releaseNew();
    await expect(newComposer).toBeHidden();
    await expect(page.getByText('Nouvelle écriture en attente.', { exact: true })).toBeVisible();
    expect(state.annotations).toHaveLength(2);
  } finally {
    releaseOld();
    releaseNew?.();
  }
});
