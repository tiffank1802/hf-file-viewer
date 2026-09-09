import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  buildApsObjectKey,
  buildHfFileUrl,
  buildHfTreeUrl,
  buildSolidworksManifestPath,
  buildSolidworksOriginalManifestPath,
  buildSolidworksOriginalStepPath,
  buildSolidworksStepPath,
  countFilesByDirectory,
  describeApsFailure,
  describeApsManifest,
  extractLinkMeta,
  getNextLink,
  getSolidworksConvertUrl,
  isAuthWallUrl,
  isBlockedLinkHost,
  isSolidworksExtension,
  readCappedText,
  sha256Hex,
  isApsConfigured,
  makeApsSourceKey,
  makeKvKey,
  makeSolidworksSourceKey,
  normalizeFilePath,
  normalizePrefix,
  selectCountsForPrefix,
} from '../worker/index.js';

test('buildHfTreeUrl encode les préfixes sans perdre les caractères Unicode', () => {
  const url = new URL(buildHfTreeUrl('ktongue/ENISE-SITE', 'GM/3A GM/S5/Mécanique', false));
  assert.equal(url.pathname, '/api/buckets/ktongue/ENISE-SITE/tree/GM%2F3A%20GM%2FS5%2FM%C3%A9canique');
  assert.equal(url.searchParams.get('recursive'), 'false');
});

test('buildHfTreeUrl demande de grandes pages pour l’index récursif', () => {
  const url = new URL(buildHfTreeUrl('ktongue/ENISE-SITE', '', true));
  assert.equal(url.searchParams.get('recursive'), 'true');
  assert.equal(url.searchParams.get('limit'), '1000');
});

test('buildHfFileUrl produit une URL resolve sûre', () => {
  const url = buildHfFileUrl('ktongue/ENISE-SITE', 'GM/4A GM/Cours & TD/épreuve.pdf');
  assert.equal(
    url,
    'https://huggingface.co/buckets/ktongue/ENISE-SITE/resolve/GM/4A%20GM/Cours%20%26%20TD/%C3%A9preuve.pdf?download=false',
  );
});

test('getNextLink lit le lien de pagination relatif', () => {
  const next = getNextLink(
    '</api/buckets/u/b/tree?cursor=abc>; rel="next", </api/buckets/u/b/tree?cursor=xyz>; rel="last"',
    'https://huggingface.co/api/buckets/u/b/tree',
  );
  assert.equal(next, 'https://huggingface.co/api/buckets/u/b/tree?cursor=abc');
});

test('les chemins SolidWorks dérivés restent stables et hors du dossier source', () => {
  assert.equal(
    buildSolidworksStepPath('GM/Tutos SolidWorks/piece.sldprt'),
    'derived/step/GM/Tutos SolidWorks/piece.step',
  );
  assert.equal(
    buildSolidworksManifestPath('GM/Tutos SolidWorks/piece.sldprt'),
    'derived/step/GM/Tutos SolidWorks/piece.step.json',
  );
  assert.equal(
    buildSolidworksOriginalStepPath('GM/Tutos SolidWorks/piece.sldprt'),
    'GM/Tutos SolidWorks/piece.step',
  );
  assert.equal(
    buildSolidworksOriginalManifestPath('GM/Tutos SolidWorks/piece.sldprt'),
    'GM/Tutos SolidWorks/piece.step.json',
  );
  assert.equal(isSolidworksExtension('SLDASM'), true);
  assert.equal(isSolidworksExtension('step'), false);
  assert.equal(
    makeSolidworksSourceKey('GM/piece.sldprt', '123', '2026-09-09'),
    makeSolidworksSourceKey('GM/piece.sldprt', '123', '2026-09-09'),
  );
  assert.notEqual(
    makeSolidworksSourceKey('GM/piece.sldprt', '123', '2026-09-09'),
    makeSolidworksSourceKey('GM/other.sldprt', '123', '2026-09-09'),
  );
});

test('le convertisseur SolidWorks est désactivé par défaut et normalise son URL', () => {
  assert.equal(getSolidworksConvertUrl({}), '');
  assert.equal(
    getSolidworksConvertUrl({ SOLIDWORKS_CONVERT_URL: 'https://hoops.example///' }),
    'https://hoops.example',
  );
});

test('POST /api/solidworks/step transmet le fichier et le chemin de sortie au service HOOPS', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let converterForm = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.endsWith('.step.json?download=false')) return new Response('missing', { status: 404 });
    if (url.includes('/api/convert-solidworks-step')) {
      converterForm = init.body;
      assert.equal(init.headers.Authorization, 'Bearer internal-secret');
      return new Response(JSON.stringify({
        status: 'success',
        stepPath: 'derived/step/GM/piece.step',
        manifestPath: 'derived/step/GM/piece.step.json',
        size: 321,
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(new TextEncoder().encode('solidworks-source').buffer);
  };

  try {
    const response = await worker.fetch(
      new Request('https://docs.example/api/solidworks/step?path=GM%2Fpiece.sldprt', { method: 'POST' }),
      {
        HF_BUCKET_ID: 'ktongue/ENISE-SITE',
        SOLIDWORKS_CONVERT_URL: 'https://hoops.example/',
        SOLIDWORKS_CONVERTER_TOKEN: 'internal-secret',
        MAX_SOLIDWORKS_BYTES: '1000000',
        ASSETS: { fetch: () => new Response('asset') },
      },
      { waitUntil() {} },
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.status, 'success');
    assert.equal(payload.stepPath, 'derived/step/GM/piece.step');
    assert.equal(payload.downloadUrl, '/api/file?path=derived%2Fstep%2FGM%2Fpiece.step&download=1');
    assert.ok(converterForm instanceof FormData);
    assert.equal(converterForm.get('source_path'), 'GM/piece.sldprt');
    assert.equal(converterForm.get('output_path'), 'derived/step/GM/piece.step');
    assert.match(String(converterForm.get('source_sha256')), /^[a-f0-9]{64}$/);
    assert.equal(calls.some((url) => url.includes('/api/convert-solidworks-step')), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('un STEP local déjà présent à côté du source est servi sans service HOOPS', async () => {
  const originalFetch = globalThis.fetch;
  const source = new TextEncoder().encode('local-solidworks-source');
  const sourceSha256 = await sha256Hex(source);
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/GM/piece.sldprt')) return new Response(source);
    if (url.includes('/derived/step/')) return new Response('missing', { status: 404 });
    if (url.includes('/GM/piece.step.json')) {
      return new Response(JSON.stringify({
        sourceSha256,
        dependencies: [],
        size: 456,
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Le service HOOPS ne devrait pas être appelé : ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request('https://docs.example/api/solidworks/step?path=GM%2Fpiece.sldprt', { method: 'POST' }),
      {
        HF_BUCKET_ID: 'ktongue/ENISE-SITE',
        ASSETS: { fetch: () => new Response('asset') },
      },
      { waitUntil() {} },
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.cached, true);
    assert.equal(payload.stepPath, 'GM/piece.step');
    assert.equal(payload.downloadUrl, '/api/file?path=GM%2Fpiece.step&download=1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('un assemblage transmet ses dépendances SolidWorks et leurs empreintes', async () => {
  const originalFetch = globalThis.fetch;
  let converterForm = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/tree/GM')) {
      return new Response(JSON.stringify([
        { type: 'file', path: 'GM/assembly.sldasm' },
        { type: 'file', path: 'GM/parts/base.sldprt' },
        { type: 'file', path: 'GM/sub/plate.sldprt' },
      ]), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('.step.json?download=false')) return new Response('missing', { status: 404 });
    if (url.includes('/api/convert-solidworks-step')) {
      converterForm = init.body;
      return new Response(JSON.stringify({
        status: 'success',
        stepPath: 'derived/step/GM/assembly.step',
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/GM/parts/base.sldprt')) return new Response(new TextEncoder().encode('base-part'));
    if (url.includes('/GM/sub/plate.sldprt')) return new Response(new TextEncoder().encode('plate-part'));
    return new Response(new TextEncoder().encode('assembly-source'));
  };

  try {
    const response = await worker.fetch(
      new Request('https://docs.example/api/solidworks/step?path=GM%2Fassembly.sldasm', { method: 'POST' }),
      {
        HF_BUCKET_ID: 'ktongue/ENISE-SITE',
        SOLIDWORKS_CONVERT_URL: 'https://hoops.example',
        MAX_SOLIDWORKS_BYTES: '1000000',
        MAX_SOLIDWORKS_BUNDLE_BYTES: '1000000',
        ASSETS: { fetch: () => new Response('asset') },
      },
      { waitUntil() {} },
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.dependencies.length, 2);
    assert.deepEqual(payload.dependencies.map(({ path }) => path), ['parts/base.sldprt', 'sub/plate.sldprt']);
    assert.ok(converterForm instanceof FormData);
    assert.equal(converterForm.getAll('dependencies').length, 2);
    assert.deepEqual(
      JSON.parse(converterForm.get('dependency_manifest')),
      payload.dependencies,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('les clés Workers KV sont courtes, stables et spécifiques au chemin', () => {
  const first = makeKvKey('tree', 'ktongue/ENISE-SITE', 'GM/3A GM');
  assert.equal(first, makeKvKey('tree', 'ktongue/ENISE-SITE', 'GM/3A GM'));
  assert.notEqual(first, makeKvKey('tree', 'ktongue/ENISE-SITE', 'GM/4A GM'));
  assert.ok(first.length < 80);
});

test('le comptage récursif agrège tous les fichiers d’un dossier', () => {
  const { counts, totalFiles } = countFilesByDirectory([
    { type: 'directory', path: 'GM' },
    { type: 'file', path: 'GM/3A GM/S5/poly.pdf' },
    { type: 'file', path: 'GM/3A GM/S6/td.pdf' },
    { type: 'file', path: 'GM/readme.md' },
    { type: 'file', path: 'TOEIC/audio.mp3' },
  ], '');
  assert.equal(totalFiles, 4);
  assert.equal(counts.GM, 3);
  assert.equal(counts['GM/3A GM'], 2);
  assert.equal(counts['GM/3A GM/S5'], 1);
  assert.equal(counts.TOEIC, 1);
});

test('les effectifs sont extraits du JSON d’index, jamais recalculés en live', () => {
  const document = {
    counts: { GM: 3, 'GM/3A GM': 2, 'GM/4A GM': 1, TOEIC: 1 },
    totalFiles: 4,
  };

  const root = selectCountsForPrefix(document, '');
  assert.equal(root.totalFiles, 4);
  assert.equal(root.counts.TOEIC, 1);

  const scoped = selectCountsForPrefix(document, '/GM/');
  assert.equal(scoped.totalFiles, 3);
  assert.equal(scoped.counts['GM/3A GM'], 2);
  assert.equal(scoped.counts.TOEIC, undefined);

  assert.deepEqual(selectCountsForPrefix({}, 'GM'), { counts: {}, totalFiles: 0 });
});

test('les chemins sont normalisés et les traversées refusées', () => {
  assert.equal(normalizePrefix('/GM/3A GM/'), 'GM/3A GM');
  assert.equal(normalizeFilePath('/GM/poly.pdf'), 'GM/poly.pdf');
  assert.throws(() => normalizeFilePath('../secret'), /invalide/i);
  assert.throws(() => normalizeFilePath('a\u0000b'), /invalide/i);
  assert.throws(() => normalizeFilePath(''), /obligatoire/i);
});

test('la configuration Autodesk APS exige les deux secrets', () => {
  assert.equal(isApsConfigured({}), false);
  assert.equal(isApsConfigured({ APS_CLIENT_ID: 'id' }), false);
  assert.equal(
    isApsConfigured({ APS_CLIENT_ID: 'id', APS_CLIENT_SECRET: 'secret' }),
    true,
  );
});

test('les clés APS sont stables, courtes et sensibles au contenu', () => {
  const first = makeApsSourceKey('GM/3D/piece.sldprt', '1024', '2026-01-01');
  assert.equal(first.length, 32);
  assert.equal(first, makeApsSourceKey('GM/3D/piece.sldprt', '1024', '2026-01-01'));
  assert.notEqual(first, makeApsSourceKey('GM/3D/piece.sldprt', '2048', '2026-01-01'));
  assert.notEqual(first, makeApsSourceKey('GM/3D/piece.stl', '1024', '2026-01-01'));
});

test('les objets OSS APS gardent une partie lisible du nom', () => {
  const key = buildApsObjectKey('GM/3D/maquette_du$batiment.rvt', 'abc123');
  assert.equal(key, 'abc123-maquette_du_batiment.rvt');
});

test('les erreurs Autodesk de version non prise en charge sont explicites', () => {
  const raw = 'The Version of the file: 2024 is not supported.';
  const failure = describeApsFailure([raw], 'GM/3D/_1700mm_plank.SLDPRT');
  assert.match(failure, /n’est pas prise en charge/i);
  assert.match(failure, /SLDPRT/i);
  assert.match(failure, /STEP\/IGES\/OBJ\/STL/i);
  assert.match(failure, /Autodesk/i);

  const manifest = {
    status: 'failed',
    derivatives: [
      {
        status: 'failed',
        messages: [{ type: 'error', message: 'The Version of the file: {0} is not supported.' }],
      },
    ],
  };
  const fromManifest = describeApsManifest(manifest, 'GM/3D/piece.x_t');
  assert.equal(fromManifest, describeApsFailure(['The Version of the file: {0} is not supported.'], 'GM/3D/piece.x_t'));

  const success = describeApsManifest({ status: 'success', derivatives: [] }, 'GM/3D/piece.stl');
  assert.equal(success, 'Modèle 3D prêt.');
});

test('les hôtes internes sont interdits pour l’aperçu de lien', () => {
  for (const host of ['localhost', 'LOCALHOST.', '127.0.0.1', '10.4.2.1', '172.16.0.9', '172.31.255.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', '[::1]', 'intranet', 'srv.local', 'app.internal', 'x.test', '']) {
    assert.equal(isBlockedLinkHost(host), true, host || '(vide)');
  }
  for (const host of ['exemple.fr', 'www.univ-lyon.fr', 'ecole.sharepoint.com', '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.167.1.1']) {
    assert.equal(isBlockedLinkHost(host), false, host);
  }
});

test('les métas Open Graph sont extraites (og prioritaire, URL résolues)', () => {
  const meta = extractLinkMeta(
    '<html><head><title>Titre brut &amp; co</title>'
    + '<meta name="description" content="Desc classique">'
    + '<meta property="og:title" content="Titre &lt;OG&gt;">'
    + '<meta property="og:description" content="Desc OG">'
    + '<meta property="og:image" content="/img/cover.png">'
    + '<meta property="og:site_name" content="Site démo">'
    + '<link rel="icon" href="https://cdn.exemple.fr/f.ico">'
    + '</head></html>',
    'https://exemple.fr/page/a',
  );
  assert.equal(meta.title, 'Titre <OG>');
  assert.equal(meta.description, 'Desc OG');
  assert.equal(meta.image, 'https://exemple.fr/img/cover.png');
  assert.equal(meta.siteName, 'Site démo');
  assert.equal(meta.icon, 'https://cdn.exemple.fr/f.ico');

  const fallback = extractLinkMeta('<title>Seul titre</title>', 'https://exemple.fr/');
  assert.equal(fallback.title, 'Seul titre');
  assert.equal(fallback.description, '');
  assert.equal(fallback.image, '');

  const unsafe = extractLinkMeta(
    '<meta property="og:image" content="javascript:alert(1)">',
    'https://exemple.fr/',
  );
  assert.equal(unsafe.image, '');
});

test('la lecture plafonnée tronque les gros corps de réponse', async () => {
  const short = await readCappedText(new Response('<title>Court</title>').body, 1024);
  assert.equal(short, '<title>Court</title>');
  const long = await readCappedText(new Response(`${'a'.repeat(500)}<title>Tard</title>`).body, 100);
  assert.equal(long.length, 100);
  assert.equal(await readCappedText(null, 100), '');
});

test('les redirections vers le login Microsoft sont détectées', () => {
  assert.equal(isAuthWallUrl('https://login.microsoftonline.com/tenant/oauth2/authorize?x=1'), true);
  assert.equal(isAuthWallUrl('https://login.live.com/login.srf?wa=wsignin'), true);
  assert.equal(isAuthWallUrl('https://account.microsoft.com/account'), true);
  assert.equal(isAuthWallUrl('https://onedrive.live.com/?id=root'), false);
  assert.equal(isAuthWallUrl('https://exemple.fr/'), false);
  assert.equal(isAuthWallUrl(''), false);
  assert.equal(isAuthWallUrl('pas une url'), false);
});
