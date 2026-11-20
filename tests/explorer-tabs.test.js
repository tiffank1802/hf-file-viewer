import test from 'node:test';
import assert from 'node:assert/strict';
import { activateExplorerTab, addExplorerTab, closeExplorerTab, initialExplorerTabs, MAX_EXPLORER_TABS } from '../src/utils/explorerTabs.js';

test('les onglets commencent au dossier courant, puis naviguent indépendamment', () => {
  const original = initialExplorerTabs('GM/Cours');
  const two = addExplorerTab(original, 'second');
  assert.equal(two.activeId, 'second');
  assert.equal(two.tabs[1].path, 'GM/Cours');
  const moved = activateExplorerTab(two, 'second', 'TOEIC');
  const switched = activateExplorerTab(moved, original.activeId);
  assert.equal(switched.tabs[0].path, 'GM/Cours');
  assert.equal(switched.tabs[1].path, 'TOEIC');
  assert.equal(two.tabs[1].path, 'GM/Cours');
  assert.equal(activateExplorerTab(switched, 'missing'), switched);
});

test('la fermeture choisit un onglet voisin et ne ferme jamais le dernier', () => {
  const first = initialExplorerTabs('');
  assert.equal(closeExplorerTab(first), first);
  const three = addExplorerTab(addExplorerTab(first, 'second'), 'third');
  const closed = closeExplorerTab(activateExplorerTab(three, 'second'));
  assert.equal(closed.activeId, first.activeId);
  assert.deepEqual(closed.tabs.map(({ id }) => id), [first.activeId, 'third']);
  let full = first;
  for (let index = 1; index < MAX_EXPLORER_TABS; index += 1) full = addExplorerTab(full, `tab-${index}`);
  assert.equal(addExplorerTab(full, 'too-many'), full);
});
