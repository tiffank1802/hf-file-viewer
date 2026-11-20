import assert from 'node:assert/strict';
import test from 'node:test';
import { attachExplorerTag, EMPTY_PERSONAL, MAX_CUSTOM_TAGS, normalizeFilters, normalizePersonal, TAGS, TAG_COLORS, toggleExplorerTag } from '../src/utils/explorerPersonal.js';
import { groupExplorerItems } from '../src/utils/explorerGroups.js';

const color = TAG_COLORS[3].color;
const path = 'GM/document.pdf';

test('personal tags create a palette entry, attach it, and survive storage and saved searches', () => {
  const created = attachExplorerTag(EMPTY_PERSONAL, path, { id: 'custom-1', label: '  Méca   finale ', color });
  assert.deepEqual(created.customTags, [{ id: 'custom-1', label: 'Méca finale', color }]);
  assert.deepEqual(created.labels, [[path, ['custom-1']]]);
  const tags = [...TAGS, ...created.customTags];
  const savedFilters = normalizeFilters({ tag: 'custom-1' }, tags);
  const normalized = normalizePersonal(JSON.parse(JSON.stringify({ ...created, searches: [{ id: '1', label: 'Cours', query: '', filters: savedFilters }] })));
  assert.equal(normalized.searches[0].filters.tag, 'custom-1');
  assert.equal(groupExplorerItems([{ path }], 'tag', new Map(normalized.labels), tags)[0].title, 'Méca finale');
  assert.deepEqual(toggleExplorerTag(normalized.labels, path, 'custom-1', tags), []);

  const duplicate = attachExplorerTag(created, 'GM/Autre', { id: 'custom-2', label: 'ME\u0301CA FINALE', color });
  assert.equal(duplicate.customTags.length, 1);
  assert.deepEqual(new Map(duplicate.labels).get('GM/Autre'), ['custom-1']);
});

test('personal palette drops invalid tags, unknown labels and excess entries', () => {
  const data = normalizePersonal({
    customTags: [
      { id: 'custom-wrong', label: 'Non', color: 'url(example)' },
      { id: 'custom-important', label: 'IMPORTANT', color },
      ...Array.from({ length: MAX_CUSTOM_TAGS + 2 }, (_, n) => ({ id: `custom-${n}`, label: `Étiquette ${n}`, color })),
    ],
    labels: [[path, ['missing', 'custom-wrong', 'custom-0', 'custom-0']]],
  });
  assert.equal(data.customTags.length, MAX_CUSTOM_TAGS);
  assert.deepEqual(data.labels, [[path, ['custom-0']]]);
  assert.equal(attachExplorerTag(data, path, { id: 'custom-more', label: 'Autre', color }), data);
});
