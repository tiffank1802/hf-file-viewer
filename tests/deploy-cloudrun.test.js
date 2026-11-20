import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  validateDeploymentIntent,
} from '../scripts/deploy-cloudrun.js';

test('les options du déploiement Cloud Run sont lues', () => {
  assert.deepEqual(parseCloudRunArgs([]), {
    project: null,
    region: 'europe-west1',
    service: 'enise-docs-api',
    writeOrigin: true,
    withHfToken: false,
    dryRun: false,
    apply: false,
  });
  const options = parseCloudRunArgs(['--project', 'enise-docs', '--region=europe-west9', '--no-origin', '--dry-run']);
  assert.equal(options.project, 'enise-docs');
  assert.equal(options.region, 'europe-west9');
  assert.equal(options.writeOrigin, false);
  assert.equal(options.dryRun, true);
  assert.throws(() => parseCloudRunArgs(['--project']), /Valeur manquante/);
  assert.throws(() => parseCloudRunArgs(['--inconnue']), /Option inconnue/);
  assert.throws(() => parseCloudRunArgs(['--apply=false']), /n'accepte pas de valeur/);
});

test('Cloud Run exige un consentement explicite et une cible pour toute écriture', () => {
  assert.throws(() => validateDeploymentIntent(parseCloudRunArgs(['--project=test'])), /Aucun déploiement effectué/);
  assert.throws(() => validateDeploymentIntent(parseCloudRunArgs(['--apply'])), /projet explicite/);
  assert.throws(() => validateDeploymentIntent(parseCloudRunArgs(['--project=test', '--dry-run', '--apply'])), /ne peuvent pas être combinés/);
  assert.doesNotThrow(() => validateDeploymentIntent(parseCloudRunArgs(['--project=test', '--dry-run'])));
  assert.doesNotThrow(() => validateDeploymentIntent(parseCloudRunArgs(['--project=test', '--apply'])));
});

test('une ancienne commande Cloud Run ne lance pas gcloud', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'cloudrun-guard-'));
  const marker = join(root, 'gcloud-called');
  writeFileSync(join(root, 'gcloud'), `#!/bin/sh\necho called > '${marker}'\n`, { mode: 0o755 });
  const script = fileURLToPath(new URL('../scripts/deploy-cloudrun.js', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--project=test-project'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH || ''}` },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Aucun déploiement effectué/);
  assert.equal(existsSync(marker), false);
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
APPWRITE_API_KEY=provisioning-only
APPWRITE_PROFILE_TABLE_ID=custom_profiles
APPWRITE_FAVORITES_TABLE_ID=custom_favorites
APPWRITE_CONVERSATIONS_TABLE_ID=custom_conversations
APPWRITE_MESSAGES_TABLE_ID=custom_messages
APPWRITE_ANNOTATIONS_TABLE_ID=custom_annotations
APPWRITE_PDF_ANNOTATIONS_TABLE_ID=custom_pdf_notes
APPWRITE_ENABLED=1
`);
  assert.equal(file.CLOUDFLARE_API_TOKEN, 'cf-token');
  assert.equal(file.OPENCODE_API_KEY, 'oc-key');

  const env = buildServiceEnv(file, {});
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID, 'acc_123');
  assert.equal(env.CLOUDFLARE_API_TOKEN, 'cf-token');
  assert.equal(env.OPENCODE_API_KEY, 'oc-key');
  assert.equal(env.CHAT_TRUST_PROXY, FIXED_ENV.CHAT_TRUST_PROXY);
  assert.equal(env.HF_DERIVED_BUCKET_ID, 'ktongue/ENISE-SITE-DERIVED');
  assert.ok(!('OPENROUTER_API_KEY' in env), 'valeur d’exemple transmise');
  assert.ok(!('NVIDIA_API_KEY' in env), 'valeur d’exemple transmise');
  assert.ok(!('HF_TOKEN' in env), 'HF_TOKEN transmis sans --with-hf-token');
  assert.ok(!('APS_CLIENT_SECRET' in env), 'clé hors liste transmise');
  assert.ok(!('APPWRITE_API_KEY' in env), 'clé de provisioning transmise au backend');
  for (const key of [
    'APPWRITE_PROFILE_TABLE_ID', 'APPWRITE_FAVORITES_TABLE_ID',
    'APPWRITE_CONVERSATIONS_TABLE_ID', 'APPWRITE_MESSAGES_TABLE_ID',
    'APPWRITE_ANNOTATIONS_TABLE_ID', 'APPWRITE_PDF_ANNOTATIONS_TABLE_ID', 'APPWRITE_ENABLED',
  ]) {
    assert.equal(env[key], file[key], `${key} absent du déploiement Cloud Run`);
  }
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
