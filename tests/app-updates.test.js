import assert from 'node:assert/strict';
import test from 'node:test';
import { getNativeRelease, getWebUpdate } from '../src/utils/appUpdates.js';

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
