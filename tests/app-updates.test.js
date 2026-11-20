import assert from 'node:assert/strict';
import test from 'node:test';
import { findNativeUpdate, getNativeRelease, getWebUpdate, installedRelease } from '../src/utils/appUpdates.js';

test('only a changed, valid web build offers a reload', () => {
  const current = 'a'.repeat(40);
  const next = 'b'.repeat(40);
  assert.equal(getWebUpdate(current, { id: next }), next);
  assert.equal(getWebUpdate(current, { id: current }), null);
  assert.equal(getWebUpdate(current, { id: 'index.html' }), null);
  assert.equal(getWebUpdate('', { id: next }), null);
});

test('native notification ignores drafts, prereleases, and older or identical versions', () => {
  assert.equal(getNativeRelease('1.9.0', { tag_name: 'v1.10.0' }), '1.10.0');
  for (const payload of [null, { tag_name: 'v1.9.0' }, { tag_name: 'v1.8.9' }, { tag_name: 'v2.0.0-beta.1' }, { tag_name: 'v2.0.0', prerelease: true }, { tag_name: 'v2.0.0', draft: true }]) {
    assert.equal(getNativeRelease('1.9.0', payload), null);
  }
});

test('preview updates compare the numeric build suffix and preserve channel isolation', () => {
  const release = (tag_name, prerelease = false, draft = false) => ({ tag_name, prerelease, draft, html_url: 'https://untrusted.invalid' });
  const feed = [release('v1.1.0-test.2', true), release('v1.1.0-test.9', true), release('v1.1.0-test.10', true),
    release('v1.1.0-test.12', true, true), release('v1.0.0'), release('v9.0.0-beta.1', true)];
  assert.equal(installedRelease('1.1.0', 'v1.1.0-test.4'), 'v1.1.0-test.4');
  assert.equal(installedRelease('1.0.0', 'v1.1.0-test.4'), '1.0.0');
  assert.equal(findNativeUpdate('1.1.0', feed), null);
  assert.deepEqual(findNativeUpdate('v1.1.0-test.4', feed), {
    version: '1.1.0-test.10', kind: 'preview', url: 'https://github.com/tiffank1802/hf-file-viewer/releases/tag/v1.1.0-test.10',
  });
  assert.equal(findNativeUpdate('v1.1.0-test.10', feed), null);
  assert.equal(findNativeUpdate('v1.1.0-test.4', [...feed, release('v1.1.0')]).kind, 'release');
  assert.equal(findNativeUpdate('1.1.0', [...feed, release('v1.2.0')]).version, '1.2.0');
});

test('stable feed requires every signature and pairs MSI and NSIS with the correct bundles', async (t) => {
  const { mkdir, mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { prepareUpdaterManifest } = await import('../scripts/prepare-updater-manifest.mjs');
  const root = await mkdtemp(join(tmpdir(), 'enise-updater-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'input');
  const output = join(root, 'output');
  await Promise.all([mkdir(input), mkdir(output)]);
  await writeFile(join(output, 'SHA256SUMS.txt'), 'previous checksum\n');
  const names = [
    'ENISE-Docs-macos-universal.app.tar.gz', 'ENISE-Docs-windows-x64-setup.exe',
    'ENISE-Docs-windows-x64.msi', 'ENISE-Docs-linux-x64.AppImage', 'ENISE-Docs-linux-x64.deb',
  ];
  const tag = 'v1.1.0';
  await assert.rejects(prepareUpdaterManifest(input, output, tag), /exige les signatures/);
  await Promise.all(names.map((name) => writeFile(join(input, name), `bundle ${name}`)));
  await Promise.all(names.slice(0, 4).map((name) => writeFile(join(input, `${name}.sig`), `sig-${name}\n`)));
  await prepareUpdaterManifest(input, output, tag);
  const manifest = JSON.parse(await readFile(join(output, 'latest.json'), 'utf8'));
  assert.equal(manifest.version, '1.1.0');
  assert.deepEqual(manifest.platforms['darwin-x86_64'], manifest.platforms['darwin-aarch64']);
  for (const [platform, name] of [['windows-x86_64-nsis', names[1]], ['windows-x86_64-msi', names[2]], ['linux-x86_64-appimage', names[3]]]) {
    assert.ok(manifest.platforms[platform].url.endsWith(`/${tag}/${name}`));
    assert.equal(manifest.platforms[platform].signature, `sig-${name}`);
  }
  assert.equal(manifest.platforms['linux-x86_64-deb'], undefined);
  assert.match(await readFile(join(output, 'SHA256SUMS.txt'), 'utf8'), /[a-f0-9]{64} {2}ENISE-Docs-linux-x64\.deb/);
});
