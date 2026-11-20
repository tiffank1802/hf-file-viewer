import { itemType } from './explorer.js';
import { TAGS } from './explorerPersonal.js';

export const GROUP_LABELS = { none: 'Sans regroupement', kind: 'Par type', date: 'Par mois', tag: 'Par tag' };
const months = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });

export function groupExplorerItems(items, grouping, labels = new Map(), tags = TAGS) {
  if (grouping === 'none') return [{ key: '', title: '', items }];
  const groups = new Map();
  for (const item of items) {
    let title;
    let key;
    if (grouping === 'kind') {
      title = item.type === 'directory' ? 'Dossiers' : itemType(item);
      key = title;
    } else if (grouping === 'date') {
      const date = item.mtime ? new Date(item.mtime) : null;
      if (date && Number.isFinite(date.valueOf())) {
        key = `${date.getFullYear()}-${date.getMonth() + 1}`;
        title = months.format(date);
      } else key = title = 'Date inconnue';
    } else if (grouping === 'tag') {
      // Each entry is rendered once. For multiple labels use the first palette tag.
      const tag = tags.find(({ id }) => labels.get(item.path)?.includes(id));
      key = tag?.id ?? 'untagged';
      title = tag?.label ?? 'Sans tag';
    }
    if (!groups.has(key)) groups.set(key, { key, title, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}
