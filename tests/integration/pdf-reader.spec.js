import { createHash } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { isolateContext, PDF_PATH, startPDFStack, startSimulatedTauriGateway } from './pdfStackFixture.js';

const test = base.extend({
  stack: async ({ browserName }, use, testInfo) => {
    const stack = await startPDFStack();
    try {
      await use(stack);
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach(`backend-go-${browserName}.log`, { body: stack.logs(), contentType: 'text/plain' });
      }
    } finally {
      await stack.stop();
    }
  },
});

async function openPDF(page, stack) {
  await page.goto(`${stack.base}/read?path=${encodeURIComponent(PDF_PATH)}`);
  await expect(page.locator('.reader-pdf-text span').filter({ hasText: 'Energie cinetique' }).first()).toBeVisible();
  await expect(page.getByLabel('Plan et annotations du document')).toContainText('Sélection, notes et IA sur le PDF');
}

async function selectText(page) {
  const span = page.locator('.reader-pdf-text span').filter({ hasText: 'Energie cinetique' }).first();
  await expect(span).toBeVisible();
  await span.evaluate((element) => {
    const doc = element.ownerDocument;
    const range = doc.createRange();
    range.selectNodeContents(element);
    const selection = doc.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new doc.defaultView.PointerEvent('pointerup', { bubbles: true }));
  });
  await expect(page.getByRole('toolbar', { name: 'Actions sur la sélection' })).toBeVisible();
}

async function addNote(page, text) {
  await selectText(page);
  await page.getByRole('button', { name: 'Ajouter une note', exact: true }).click();
  const composer = page.getByRole('dialog', { name: 'Ajouter une note privée' });
  await composer.getByLabel('Note').fill(text);
  await composer.getByRole('button', { name: 'Enregistrer la note' }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
}

async function openNotes(page) {
  await page.getByRole('tab', { name: /Notes/ }).click();
}

test('Go + PDF.js : notes privées, ancienne révision, modification et isolation entre comptes', async ({ page, context, browser, stack }) => {
  await isolateContext(context, stack.base, 'alice');
  await openPDF(page, stack);
  await addNote(page, 'Note privée Alice.');
  await expect.poll(() => stack.state.rows.size).toBe(1);
  const [id, row] = [...stack.state.rows.entries()][0];
  const anchor = JSON.parse(row.data.anchorJson);
  expect(row.data.userId).toBe('alice');
  expect(row.data.sourceRevision).toMatch(/^etag-sha256:[0-9a-f]{64}$/);
  expect(anchor.schemaVersion).toBe('pdf-anchor/v1');
  expect(anchor.sourceRevision).toBe(row.data.sourceRevision);
  expect(anchor.segments[0].quads.length).toBeGreaterThan(0);
  expect(stack.state.permissions[0].permissions.sort()).toEqual([
    'delete("user:alice")', 'read("user:alice")', 'update("user:alice")',
  ]);
  const fileParams = new URLSearchParams({ path: PDF_PATH, reader: '1', revision: row.data.sourceRevision });
  const range = await context.request.get(`${stack.base}/api/file?${fileParams}`, { headers: { Range: 'bytes=0-31' } });
  expect(range.status()).toBe(206);
  expect(range.headers()['content-range']).toBe(`bytes 0-31/${stack.pdf.length}`);
  expect(range.headers()['cache-control']).toContain('no-store');
  expect(await range.body()).toEqual(stack.pdf.subarray(0, 32));
  await expect(page.locator('.reader-highlight.annotation').first()).toBeVisible();

  await page.reload();
  await openNotes(page);
  const saved = page.locator('.reader-annotation-item').filter({ hasText: 'Note privée Alice.' });
  await expect(saved).toBeVisible();
  await expect(page.locator('.reader-highlight.annotation').first()).toBeVisible();
  const legacy = page.locator('.reader-annotation-item').filter({ hasText: 'Ancienne note Docling' });
  await expect(legacy).toContainText('À vérifier');
  await legacy.locator('.reader-annotation-target').click();
  await expect(page.getByText(/doit être vérifiée avant de la positionner/)).toBeVisible();
  await saved.getByRole('button', { name: 'Modifier' }).click();
  const editor = page.locator('.reader-annotation-edit');
  await editor.locator('textarea').fill('Note Alice modifiée.');
  await editor.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByText('Note Alice modifiée.', { exact: true })).toBeVisible();
  expect(stack.state.rows.get(id).data.body).toBe('Note Alice modifiée.');

  // The fake Appwrite intentionally returns Alice's row to Bob. The Go API
  // must filter it and refuse direct writes independently of row permissions.
  const bobContext = await browser.newContext();
  try {
    await isolateContext(bobContext, stack.base, 'bob');
    const bob = await bobContext.newPage();
    await openPDF(bob, stack);
    await openNotes(bob);
    await expect(bob.getByText('Note Alice modifiée.', { exact: true })).toHaveCount(0);
    await expect(bob.getByText('Ancienne note Docling', { exact: true })).toHaveCount(0);
    const denied = await bobContext.request.patch(`${stack.base}/api/annotations/${encodeURIComponent(`pdfv2:${id}`)}`, {
      data: { body: 'Tentative étrangère' },
    });
    expect(denied.status()).toBe(403);
    await addNote(bob, 'Note privée Bob.');
    await expect.poll(() => stack.state.rows.size).toBe(2);
    bob.once('dialog', (dialog) => dialog.accept());
    await bob.locator('.reader-annotation-item').filter({ hasText: 'Note privée Bob.' })
      .getByRole('button', { name: 'Supprimer' }).click();
    await expect.poll(() => stack.state.rows.size).toBe(1);
  } finally {
    await bobContext.close();
  }

  stack.state.etag = '"integration-v2"';
  const staleRange = await context.request.get(`${stack.base}/api/file?${fileParams}`, { headers: { Range: 'bytes=0-31' } });
  expect(staleRange.status()).toBe(409);
  await page.reload();
  await openNotes(page);
  const oldVersion = page.locator('.reader-annotation-item').filter({ hasText: 'Note Alice modifiée.' });
  await expect(oldVersion).toContainText('À vérifier');
  await expect(page.locator('.reader-highlight.annotation')).toHaveCount(0);
  await oldVersion.locator('.reader-annotation-target').click();
  await expect(page.getByText(/doit être vérifiée avant de la positionner/)).toBeVisible();
  expect(stack.state.doclingRequests).toBeGreaterThan(0);
});

test('Go + PDF.js : une liste lente ne masque pas une note enregistrée entre-temps', async ({ page, context, stack }) => {
  let release;
  stack.state.pdfListGate = new Promise((resolve) => { release = resolve; });
  try {
    await isolateContext(context, stack.base, 'alice');
    await openPDF(page, stack);
    await expect.poll(() => stack.state.pdfListCalls).toBeGreaterThan(0);
    await selectText(page);
    await page.getByRole('button', { name: 'Ajouter une note', exact: true }).click();
    const composer = page.getByRole('dialog', { name: 'Ajouter une note privée' });
    await composer.getByLabel('Note').fill('Note créée pendant le chargement.');
    await composer.getByRole('button', { name: 'Enregistrer la note' }).click();
    await expect(composer).toBeHidden();
    await expect.poll(() => stack.state.rows.size).toBe(1);
    await expect(page.locator('.reader-highlight.annotation').first()).toBeVisible();
    const callsBeforeRelease = stack.state.pdfListCalls;
    stack.state.pdfListGate = null;
    release();
    await expect.poll(() => stack.state.pdfListCalls).toBeGreaterThan(callsBeforeRelease);
    await expect(page.getByText('Note créée pendant le chargement.', { exact: true })).toBeVisible();
    await expect(page.getByText('Ancienne note Docling', { exact: true })).toBeVisible();
    await expect(page.locator('.reader-highlight.annotation').first()).toBeVisible();
  } finally {
    release();
  }
});

test('Go + PDF.js : citation réelle, confidentialité du prompt et annulation du flux IA', async ({ page, context, stack }) => {
  await isolateContext(context, stack.base, 'alice');
  const status = await (await context.request.get(`${stack.base}/api/chat/status`)).json();
  expect(status.providers.filter((provider) => provider.enabled).map((provider) => provider.id)).toEqual(['nvidia']);
  await openPDF(page, stack);
  await addNote(page, 'Secret privé à ne pas transmettre.');
  await selectText(page);
  await page.getByRole('button', { name: 'Expliquer', exact: true }).click();
  await expect(page.locator('.reader-message.assistant').last()).toContainText('La vitesse intervient au carré');
  await expect(page.getByText(/texte du lecteur n’est pas vérifié par le serveur/i)).toBeVisible();
  const prompt = JSON.stringify(stack.state.prompts[0]);
  expect(prompt).toContain('Energie cinetique');
  expect(prompt).toContain('Texte fourni par le lecteur et non vérifié côté serveur');
  expect(prompt).not.toContain('Secret privé à ne pas transmettre');
  await page.locator('.reader-answer-citations .library-chat-citation').first().click();
  await expect(page.locator('.reader-highlight.citation').first()).toBeVisible();

  await page.getByRole('button', { name: 'Fermer les actions de sélection' }).click();
  await expect(page.getByText(/Index local : 1\/1 pages/)).toBeVisible();
  await page.getByLabel('Question à l’assistant du document').fill('Que dit le PDF sur la vitesse ?');
  const globalQuestion = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/chat' && request.method() === 'POST');
  await page.getByRole('button', { name: 'Envoyer la question' }).click();
  const globalScope = (await globalQuestion).postDataJSON().scope;
  expect(globalScope.anchor).toBeUndefined();
  expect(globalScope.pdfContext).toMatchObject({ indexedPages: 1, totalPages: 1, complete: true });
  expect(globalScope.pdfContext.passages[0].text).toContain('vitesse');
  await expect(page.locator('.reader-message.assistant').last()).toContainText('La vitesse intervient au carré');
  await expect(page.getByText(/Les passages fournis ne constituent pas une lecture exhaustive/)).toBeVisible();
  expect(JSON.stringify(stack.state.prompts[1])).not.toContain('Secret privé à ne pas transmettre');

  await page.getByLabel('Question à l’assistant du document').fill('Attends volontairement avant de répondre.');
  await page.getByRole('button', { name: 'Envoyer la question' }).click();
  await expect(page.locator('.reader-message.assistant').last()).toContainText('Réponse partielle.');
  await page.getByRole('button', { name: 'Annuler la réponse' }).click();
  await expect.poll(() => stack.state.providerAborts, { timeout: 10_000 }).toBe(1);
});

test('Go + PDF.js : repli SHA-256 vérifié et refus d’une empreinte périmée', async ({ page, context, stack }) => {
  stack.state.etag = '';
  await isolateContext(context, stack.base, 'alice');
  await openPDF(page, stack);
  await addNote(page, 'Note sans ETag.');
  const row = [...stack.state.rows.values()][0];
  const revision = `sha256:${createHash('sha256').update(stack.pdf).digest('hex')}`;
  expect(row.data.sourceRevision).toBe(revision);
  const anchor = JSON.parse(row.data.anchorJson);
  expect(anchor.sourceRevision).toBe(revision);
  expect(stack.state.fileRequests.filter((request) => request.method === 'GET').length).toBeGreaterThanOrEqual(2);

  const stale = `sha256:${'0'.repeat(64)}`;
  const response = await context.request.post(`${stack.base}/api/annotations`, {
    data: {
      sourcePath: PDF_PATH, sourceRevision: stale, kind: 'note', body: 'Ne doit pas être enregistré',
      anchor: { ...anchor, sourceRevision: stale },
    },
  });
  expect(response.status()).toBe(409);
  expect(stack.state.rows.size).toBe(1);
});

test('Go + transport Tauri simulé : plages PDF, session, flux IPC et annulation', async ({ page, context, stack }) => {
  const gateway = await startSimulatedTauriGateway(stack, 'alice');
  try {
    await isolateContext(context, gateway.origin);
    await page.addInitScript((gatewayOrigin) => {
      const streams = new Map();
      let nextCallback = 1;
      globalThis.isTauri = true;
      globalThis.__TAURI_INTERNALS__ = {
        convertFileSrc: () => gatewayOrigin,
        transformCallback: () => nextCallback++,
        unregisterCallback: () => {},
        async invoke(command, args) {
          if (command === 'tauri_chat_cancel') {
            streams.get(args.streamId)?.abort();
            return;
          }
          if (command !== 'tauri_chat_stream') throw new Error(`Commande non simulée : ${command}`);
          const controller = new AbortController();
          streams.set(args.streamId, controller);
          try {
            const response = await fetch(`${gatewayOrigin}/api/chat`, {
              method: 'POST', body: args.body, signal: controller.signal,
              headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
            });
            if (!response.ok || !response.body) throw new Error('Flux Go indisponible');
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              args.onEvent.onmessage({ kind: 'chunk', text: decoder.decode(value, { stream: true }) });
            }
            const tail = decoder.decode();
            if (tail) args.onEvent.onmessage({ kind: 'chunk', text: tail });
            args.onEvent.onmessage({ kind: 'done' });
          } finally {
            streams.delete(args.streamId);
          }
        },
      };
    }, gateway.origin);
    await openPDF(page, { base: gateway.origin });
    await addNote(page, 'Note via passerelle simulée.');
    expect(gateway.requests.some((request) => request.url.startsWith('/api/file?') && request.range === 'bytes=0-262143')).toBe(true);
    expect([...stack.state.rows.values()][0].data.userId).toBe('alice');

    await selectText(page);
    await page.getByRole('button', { name: 'Expliquer', exact: true }).click();
    await expect(page.locator('.reader-message.assistant').last()).toContainText('La vitesse intervient au carré');
    await page.getByLabel('Question à l’assistant du document').fill('Attends volontairement avant de répondre.');
    await page.getByRole('button', { name: 'Envoyer la question' }).click();
    await expect(page.locator('.reader-message.assistant').last()).toContainText('Réponse partielle.');
    await page.getByRole('button', { name: 'Annuler la réponse' }).click();
    await expect.poll(() => stack.state.providerAborts, { timeout: 10_000 }).toBe(1);
  } finally {
    await gateway.stop();
  }
});

test('Go + PDF.js sur mobile émulé : note persistée et assistant sur la sélection', async ({ browser, browserName, stack }) => {
  test.skip(browserName !== 'chromium', 'Émulation tactile Chromium.');
  const mobile = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 2.75,
    isMobile: true,
    hasTouch: true,
  });
  try {
    await isolateContext(mobile, stack.base, 'alice');
    const page = await mobile.newPage();
    await page.goto(`${stack.base}/read?path=${encodeURIComponent(PDF_PATH)}`);
    await addNote(page, 'Note privée sur téléphone.');
    expect([...stack.state.rows.values()][0].data.userId).toBe('alice');
    await page.getByRole('button', { name: 'Fermer le plan et les notes' }).click();
    await selectText(page);
    await page.getByRole('button', { name: 'Expliquer', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Assistant du document' })).toBeVisible();
    await expect(page.locator('.reader-message.assistant').last()).toContainText('La vitesse intervient au carré');
    await expect(page.getByText('Demande annulée.', { exact: true })).toHaveCount(0);
    expect(stack.state.prompts).toHaveLength(1);
    await page.reload();
    await page.getByRole('button', { name: 'Afficher le plan et les notes' }).click();
    await openNotes(page);
    await expect(page.getByText('Note privée sur téléphone.', { exact: true })).toBeVisible();
  } finally {
    await mobile.close();
  }
});
