import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FIXED_ENV,
  buildServiceEnv,
  deployArgs,
  envFileContent,
  hasEngine,
  isPlaceholder,
  parseCloudRunArgs,
  parseDevVars,
  resolveProject,
} from '../scripts/deploy-cloudrun.js';

test('les options du déploiement Cloud Run sont lues', () => {
  assert.deepEqual(parseCloudRunArgs([]), {
    project: null,
    region: 'europe-west1',
    service: 'enise-docs-api',
    writeOrigin: true,
    withHfToken: false,
    dryRun: false,
  });
  const options = parseCloudRunArgs(['--project', 'enise-docs', '--region=europe-west9', '--no-origin', '--dry-run']);
  assert.equal(options.project, 'enise-docs');
  assert.equal(options.region, 'europe-west9');
  assert.equal(options.writeOrigin, false);
  assert.equal(options.dryRun, true);
  assert.throws(() => parseCloudRunArgs(['--project']), /Valeur manquante/);
  assert.throws(() => parseCloudRunArgs(['--inconnue']), /Option inconnue/);
});

test('le projet vient de l’option, de l’environnement ou de .firebaserc', () => {
  const root = mkdtempSync(join(tmpdir(), 'firebaserc-'));
  assert.equal(resolveProject(null, {}, root), null);
  writeFileSync(join(root, '.firebaserc'), JSON.stringify({ projects: { default: 'enise-docs-fb' } }));
  assert.equal(resolveProject(null, {}, root), 'enise-docs-fb');
  assert.equal(resolveProject(null, { GOOGLE_CLOUD_PROJECT: 'depuis-env' }, root), 'depuis-env');
  assert.equal(resolveProject('option', { GOOGLE_CLOUD_PROJECT: 'depuis-env' }, root), 'option');
});

test('seules les clés utiles et remplies partent vers Cloud Run', () => {
  const file = parseDevVars(`
# commentaire
CLOUDFLARE_ACCOUNT_ID="acc_123"
CLOUDFLARE_API_TOKEN='cf-token'
OPENROUTER_API_KEY="sk-or-v1-..."
NVIDIA_API_KEY="nvapi-your-key"
HF_TOKEN="hf_secret"
APS_CLIENT_SECRET="ne-doit-pas-partir"
export OPENCODE_API_KEY=oc-key
`);
  assert.equal(file.CLOUDFLARE_API_TOKEN, 'cf-token');
  assert.equal(file.OPENCODE_API_KEY, 'oc-key');

  const env = buildServiceEnv(file, {});
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID, 'acc_123');
  assert.equal(env.CLOUDFLARE_API_TOKEN, 'cf-token');
  assert.equal(env.OPENCODE_API_KEY, 'oc-key');
  assert.equal(env.CHAT_TRUST_PROXY, FIXED_ENV.CHAT_TRUST_PROXY);
  assert.ok(!('OPENROUTER_API_KEY' in env), 'valeur d’exemple transmise');
  assert.ok(!('NVIDIA_API_KEY' in env), 'valeur d’exemple transmise');
  assert.ok(!('HF_TOKEN' in env), 'HF_TOKEN transmis sans --with-hf-token');
  assert.ok(!('APS_CLIENT_SECRET' in env), 'clé hors liste transmise');
  assert.ok(hasEngine(env));

  assert.equal(buildServiceEnv(file, {}, { withHfToken: true }).HF_TOKEN, 'hf_secret');
  assert.equal(hasEngine(buildServiceEnv({}, {})), false);
});

test('les valeurs d’exemple sont reconnues', () => {
  for (const value of ['', 'your-account-id', 'votre_token', 'sk-or-v1-...', 'nvapi-your-key']) {
    assert.equal(isPlaceholder(value), true, value);
  }
  assert.equal(isPlaceholder('acc_123'), false);
});

test('le fichier de variables échappe guillemets et deux-points', () => {
  const content = envFileContent({ A: 'simple', B: 'a "b": c' });
  assert.equal(content, 'A: "simple"\nB: "a \\"b\\": c"\n');
});

test('la commande gcloud déploie les sources Go, public, 300 s', () => {
  const args = deployArgs({ service: 'enise-docs-api', region: 'europe-west1', project: 'p' }, '/tmp/env.yaml', '/repo/backend');
  const joined = args.join(' ');
  assert.ok(joined.startsWith('run deploy enise-docs-api --source /repo/backend'));
  assert.ok(joined.includes('--allow-unauthenticated'));
  assert.ok(joined.includes('--timeout 300'));
  assert.ok(joined.includes('--env-vars-file /tmp/env.yaml'));
  assert.ok(joined.includes('--project p'));
});
