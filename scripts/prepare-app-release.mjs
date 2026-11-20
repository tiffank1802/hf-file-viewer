#!/usr/bin/env node
/**
 * Copie les artefacts Tauri sous des noms stables et génère leurs SHA-256.
 * Accepte aussi les noms versionnés des premières compilations GitHub Actions.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = [
  { name: 'ENISE-Docs-windows-x64-setup.exe', legacy: /^ENISE Docs_.+_x64-setup\.exe$/i },
  { name: 'ENISE-Docs-windows-x64.msi', legacy: /^ENISE Docs_.+_x64_.+\.msi$/i },
  { name: 'ENISE-Docs-macos-universal.dmg', legacy: /^ENISE Docs_.+_universal\.dmg$/i },
  { name: 'ENISE-Docs-macos-universal.app.tar.gz' },
  { name: 'ENISE-Docs-android-universal.apk' },
  { name: 'ENISE-Docs-android-universal.aab' },
  { name: 'ENISE-Docs-ios-unsigned.ipa' },
  { name: 'ENISE-Docs-ios-simulator-arm64.app.zip' },
];

export async function prepareAppRelease(inputDir, outputDir) {
  if (!inputDir || !outputDir || path.resolve(inputDir) === path.resolve(outputDir)) {
    throw new Error('Deux dossiers différents sont requis : source des artefacts et destination.');
  }
  const entries = (await readdir(inputDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

  // Vérifier tous les fichiers avant toute publication : aucun lien ne doit
  // pointer vers un fichier manquant dans une release partielle.
  const sources = await Promise.all(ASSETS.map(async ({ name, legacy }) => {
    const matches = entries.includes(name) ? [name] : entries.filter((entry) => legacy?.test(entry));
    if (matches.length !== 1) throw new Error(`Artefact manquant ou ambigu : ${name} (${matches.length} trouvé(s)).`);
    const source = path.join(inputDir, matches[0]);
    if ((await stat(source)).size === 0) throw new Error(`Artefact vide : ${matches[0]}.`);
    return { name, source };
  }));

  await mkdir(outputDir, { recursive: true });
  const checksums = [];
  for (const { name, source } of sources) {
    const destination = path.join(outputDir, name);
    await copyFile(source, destination);
    const hash = createHash('sha256').update(await readFile(destination)).digest('hex');
    checksums.push(`${hash}  ${name}`);
  }
  await writeFile(path.join(outputDir, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
  return sources.map(({ name }) => name);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  prepareAppRelease(process.argv[2], process.argv[3])
    .then((names) => console.log(`Artefacts prêts : ${names.join(', ')}`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
