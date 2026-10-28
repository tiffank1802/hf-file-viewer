import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareAppRelease } from '../scripts/prepare-app-release.mjs';
import {
  APP_PLATFORMS,
  DEFAULT_RELEASE_BASE_URL,
  DEFAULT_RELEASE_PAGE_URL,
  buildAppAssetUrl,
  detectClientPlatform,
  getPlatformById,
  resolveReleaseBaseUrl,
  resolveReleasePageUrl,
} from '../src/utils/appDownloads.js';

const OLD_ARTIFACTS = [
  'ENISE Docs_1.0.0_x64-setup.exe',
  'ENISE Docs_1.0.0_x64_fr-FR.msi',
  'ENISE Docs_1.0.0_universal.dmg',
  'ENISE-Docs-macos-universal.app.tar.gz',
  'ENISE-Docs-android-universal.apk',
  'ENISE-Docs-android-universal.aab',
  'ENISE-Docs-ios-unsigned.ipa',
  'ENISE-Docs-ios-simulator-arm64.app.zip',
];

test('détection des appareils : Windows, macOS, Android, iPhone, iPadOS et inconnu', () => {
  assert.deepEqual(
    detectClientPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32' }),
    { id: 'windows', detected: true },
  );
  assert.deepEqual(
    detectClientPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)', platform: 'MacIntel' }),
    { id: 'macos', detected: true },
  );
  assert.deepEqual(
    detectClientPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 }),
    { id: 'ios', detected: true },
  );
  assert.deepEqual(
    detectClientPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone' }),
    { id: 'ios', detected: true },
  );
  assert.deepEqual(
    detectClientPlatform({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)', platform: 'Linux armv81' }),
    { id: 'android', detected: true },
  );
  assert.deepEqual(
    detectClientPlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64' }),
    { id: null, detected: false },
  );
});

test('liens de téléchargement stables et configuration HTTPS sûre', () => {
  assert.equal(buildAppAssetUrl('ENISE-Docs-windows-x64-setup.exe', {}), `${DEFAULT_RELEASE_BASE_URL}/ENISE-Docs-windows-x64-setup.exe`);
  assert.equal(buildAppAssetUrl('ENISE-Docs-android-universal.apk', {
    VITE_APP_RELEASE_BASE_URL: 'https://cdn.example.org/app/',
  }), 'https://cdn.example.org/app/ENISE-Docs-android-universal.apk');
  assert.equal(resolveReleaseBaseUrl({ VITE_APP_RELEASE_BASE_URL: 'javascript:alert(1)' }), DEFAULT_RELEASE_BASE_URL);
  assert.equal(resolveReleaseBaseUrl({ VITE_APP_RELEASE_BASE_URL: 'https://evil@example.org/' }), DEFAULT_RELEASE_BASE_URL);
  assert.equal(resolveReleaseBaseUrl({ VITE_APP_RELEASE_BASE_URL: 'https://example.org/?next=1' }), DEFAULT_RELEASE_BASE_URL);
  assert.equal(resolveReleasePageUrl({}), DEFAULT_RELEASE_PAGE_URL);
  assert.equal(APP_PLATFORMS.length, 4);
  assert.equal(getPlatformById('android').primary.fileName, 'ENISE-Docs-android-universal.apk');
});

test('préparation des téléchargements : noms versionnés normalisés et empreintes vérifiables', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'enise-app-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  await mkdir(input);
  for (const file of OLD_ARTIFACTS) await writeFile(path.join(input, file), `fixture ${file}`);

  const names = await prepareAppRelease(input, output);
  const files = await readdir(output);
  assert.equal(names.length, 8);
  assert.equal(files.length, 9);
  assert.ok(files.includes('ENISE-Docs-macos-universal.dmg'));
  assert.ok(files.includes('ENISE-Docs-windows-x64-setup.exe'));
  assert.ok(files.includes('ENISE-Docs-windows-x64.msi'));
  for (const platform of APP_PLATFORMS) {
    assert.ok(files.includes(platform.primary.fileName));
    if (platform.secondary) assert.ok(files.includes(platform.secondary.fileName));
  }
  const data = await readFile(path.join(output, 'ENISE-Docs-windows-x64-setup.exe'));
  const hash = createHash('sha256').update(data).digest('hex');
  assert.match(await readFile(path.join(output, 'SHA256SUMS.txt'), 'utf8'), new RegExp(`${hash}  ENISE-Docs-windows-x64-setup\\.exe`));
});

test('préparation : refuse un fichier manquant, vide ou ambigu avant publication', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'enise-app-release-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  await mkdir(input);
  await assert.rejects(prepareAppRelease(input, output), /manquant ou ambigu/);
  for (const file of OLD_ARTIFACTS) await writeFile(path.join(input, file), 'fixture');
  await writeFile(path.join(input, OLD_ARTIFACTS[0]), '');
  await assert.rejects(prepareAppRelease(input, output), /vide/);
  await writeFile(path.join(input, OLD_ARTIFACTS[0]), 'fixture');
  await writeFile(path.join(input, 'ENISE Docs_2.0.0_x64-setup.exe'), 'fixture');
  await assert.rejects(prepareAppRelease(input, output), /ambigu/);
});

test('publication atomique : brouillon, upload puis publication ; une release existante reste immuable', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'enise-app-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'gh.log');
  await mkdir(input);
  await mkdir(bin);
  for (const file of OLD_ARTIFACTS) await writeFile(path.join(input, file), 'fixture');
  await prepareAppRelease(input, output);
  await writeFile(path.join(bin, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
if [[ "$1 $2" == 'release view' ]]; then
  if [[ "$GH_STATE" == 'missing' ]]; then exit 1; fi
  if [[ "$GH_STATE" == 'draft' || "$GH_STATE" == 'upload-fails' ]]; then echo true; else echo false; fi
fi
if [[ "$1 $2" == 'release upload' && "$GH_STATE" == 'upload-fails' ]]; then exit 1; fi
`, { mode: 0o755 });

  const run = (state) => spawnSync('bash', ['scripts/publish-app-release.sh', output], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_LOG: log,
      GH_STATE: state,
      RELEASE_TAG: 'v1.0.0',
      RELEASE_TARGET: 'ffc68d4',
    },
  });
  let result = run('missing');
  assert.equal(result.status, 0, result.stderr);
  let commands = await readFile(log, 'utf8');
  assert.match(commands, /release create v1\.0\.0 .*--draft/);
  assert.ok(commands.indexOf('release upload') > commands.indexOf('release create'));
  assert.ok(commands.indexOf('release edit') > commands.indexOf('release upload'));

  await writeFile(log, '');
  result = run('public');
  assert.notEqual(result.status, 0);
  commands = await readFile(log, 'utf8');
  assert.doesNotMatch(commands, /release upload|release edit/);

  await writeFile(log, '');
  result = run('upload-fails');
  assert.notEqual(result.status, 0);
  commands = await readFile(log, 'utf8');
  assert.match(commands, /release upload/);
  assert.doesNotMatch(commands, /release edit/);
});
