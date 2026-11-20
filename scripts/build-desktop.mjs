import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { TAURI_SIGNING_PRIVATE_KEY, TAURI_UPDATER_PUBLIC_KEY } = process.env;
const signed = Boolean(TAURI_SIGNING_PRIVATE_KEY?.trim() && TAURI_UPDATER_PUBLIC_KEY?.trim());
const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
const args = ['build', ...process.argv.slice(2)];
if (signed) {
  args.push('--config', JSON.stringify({
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater: {
      pubkey: TAURI_UPDATER_PUBLIC_KEY.trim(),
      endpoints: ['https://github.com/tiffank1802/hf-file-viewer/releases/latest/download/latest.json'],
    } },
  }));
} else {
  console.log('Pas de paire de clés de mise à jour : build de test, notification via la page des versions.');
}
const result = spawnSync(process.execPath, [cli, ...args], {
  stdio: 'inherit', env: { ...process.env, VITE_ENISE_SIGNED_UPDATER: signed ? '1' : '0' },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
