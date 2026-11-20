import { createHash } from 'node:crypto';
import { copyFile, readFile, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAC = 'ENISE-Docs-macos-universal.app.tar.gz';
const WINDOWS = 'ENISE-Docs-windows-x64-setup.exe';
const MSI = 'ENISE-Docs-windows-x64.msi';
const LINUX = 'ENISE-Docs-linux-x64.AppImage';
const DEB = 'ENISE-Docs-linux-x64.deb';

export async function prepareUpdaterManifest(input, output, tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Tag de mise à jour invalide.');
  const updateFiles = [MAC, WINDOWS, MSI, LINUX];
  const signatures = await Promise.all(updateFiles.map((name) => readFile(join(input, `${name}.sig`), 'utf8').catch(() => '')));
  if (signatures.some((value) => !value.trim())) throw new Error('Une release stable exige les signatures de mise à jour macOS, Windows et Linux.');
  const packageVersion = (name) => ({
    url: `https://github.com/tiffank1802/hf-file-viewer/releases/download/${tag}/${name}`,
    signature: signatures[updateFiles.indexOf(name)].trim(),
  });
  const checksums = [];
  for (const name of [LINUX, DEB]) {
    const content = await readFile(join(input, name));
    if (!content.length) throw new Error(`Artefact vide : ${name}`);
    checksums.push(`${createHash('sha256').update(content).digest('hex')}  ${name}`);
    await copyFile(join(input, name), join(output, name));
  }
  await appendFile(join(output, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
  await writeFile(join(output, 'latest.json'), `${JSON.stringify({
    version: tag.slice(1),
    platforms: {
      'darwin-aarch64': packageVersion(MAC), 'darwin-x86_64': packageVersion(MAC),
      'linux-x86_64-appimage': packageVersion(LINUX),
      'windows-x86_64-nsis': packageVersion(WINDOWS), 'windows-x86_64-msi': packageVersion(MSI),
    },
  }, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await prepareUpdaterManifest(process.argv[2], process.argv[3], process.argv[4]);
}
