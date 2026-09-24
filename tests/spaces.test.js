import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURED_SPACES } from '../src/config.js';
import {
  buildHomeCards,
  buildLibraryCard,
  buildSpaces,
  hasDirectory,
  indexedDirectories,
  latestActivity,
  libraryDescription,
  rootDirectories,
} from '../src/utils/spaces.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const daysBefore = (days) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

const file = (path, mtime) => ({ type: 'file', path, size: 1024, mtime });
const folder = (path, mtime = null) => (mtime ? { type: 'directory', path, mtime } : { type: 'directory', path });

function catalogOf(items, counts = {}, totalFiles = null) {
  return { items, counts, totalFiles, loading: false, source: 'index-json' };
}

test('les espaces connus absents du bucket ne sont plus affichés', () => {
  const spaces = buildSpaces(
    catalogOf([folder('GM'), folder('GM/4A GM'), file('GM/4A GM/projet.pdf', daysBefore(3)), file('TOEIC/audio.mp3', daysBefore(2))]),
    { now: NOW },
  );
  assert.deepEqual(spaces.map((space) => space.path), ['GM/4A GM', 'TOEIC']);
  const known = spaces.map((space) => space.title);
  assert.ok(known.includes('4e année GM'));
  assert.ok(!known.includes('3e année GM'));
  assert.ok(!known.includes('Tutos SolidWorks'));
});

test('un dossier ajouté à la racine obtient une carte, du plus récent au plus ancien', () => {
  const spaces = buildSpaces(
    catalogOf([
      folder('TOEIC'),
      file('TOEIC/audio.mp3', daysBefore(2)),
      file('Stages 2026/offre.pdf', daysBefore(1)),
      file('Annales/sujet.pdf', daysBefore(90)),
    ]),
    { now: NOW },
  );
  assert.deepEqual(spaces.map((space) => space.path), ['TOEIC', 'Stages 2026', 'Annales']);
  const [stages, annales] = spaces.slice(1);
  assert.equal(stages.title, 'Stages 2026');
  assert.equal(stages.dynamic, true);
  assert.equal(stages.tone, 'green');
  assert.equal(stages.badge, 'Nouveau');
  assert.equal(annales.tone, 'red');
  assert.equal(annales.badge, null);
  assert.equal(annales.description, 'Dossier de la bibliothèque');
});

test('un nouveau sous-dossier de conteneur apparaît sans carte pour le conteneur', () => {
  const spaces = buildSpaces(
    catalogOf([
      folder('GM'),
      folder('GM/3A GM'),
      file('GM/3A GM/S5/poly.pdf', daysBefore(10)),
      file('GM/Stages/rapport.pdf', daysBefore(4)),
    ]),
    { now: NOW },
  );
  assert.deepEqual(spaces.map((space) => space.path), ['GM/3A GM', 'GM/Stages']);
  assert.equal(spaces[1].description, 'Dans Génie mécanique');
  assert.equal(spaces[1].badge, 'Nouveau');
});

test('le badge Nouveau disparaît passé la fenêtre de 30 jours', () => {
  const spaces = buildSpaces(
    catalogOf([file('Archives/sujet.pdf', daysBefore(31)), file('Nouveautés/td.pdf', daysBefore(29))]),
    { now: NOW },
  );
  const archives = spaces.find((space) => space.path === 'Archives');
  const nouveautes = spaces.find((space) => space.path === 'Nouveautés');
  assert.equal(archives.badge, null);
  assert.equal(nouveautes.badge, 'Nouveau');
});

test('sans index, les espaces connus restent affichés comme avant', () => {
  const { spaces, cards } = buildHomeCards({ items: [], counts: {}, loading: true });
  assert.equal(spaces.length, FEATURED_SPACES.length);
  assert.deepEqual(spaces.map((space) => space.path), [
    'GM/3A GM', 'GM/4A GM', 'GM/5A GM', 'TOEIC', 'GM/Tutos SolidWorks',
  ]);
  assert.equal(cards.length, FEATURED_SPACES.length + 1);
});

test('la carte Toute la bibliothèque ouvre la racine et compte les fichiers indexés', () => {
  const { spaces, cards } = buildHomeCards(
    catalogOf([file('TOEIC/audio.mp3', daysBefore(2))], { TOEIC: 1 }, 1234),
    { now: NOW },
  );
  const library = cards[cards.length - 1];
  assert.equal(cards.length, spaces.length + 1);
  assert.equal(library.library, true);
  assert.equal(library.path, '');
  assert.equal(library.title, 'Toute la bibliothèque');
  assert.equal(library.count, 1234);

  // Un total absent (index en panne) ne doit pas devenir « 0 ressource ».
  assert.equal(buildLibraryCard({ totalFiles: null }).count, null);
});

test('les dossiers de l’index se déduisent des fichiers et des entrées de type dossier', () => {
  const items = [file('GM/3A GM/S5/poly.pdf', daysBefore(1)), folder('TOEIC')];
  const directories = indexedDirectories(items);
  assert.deepEqual([...directories].sort(), ['GM', 'GM/3A GM', 'GM/3A GM/S5', 'TOEIC']);
  assert.equal(hasDirectory(items, 'GM/3A GM'), true);
  assert.equal(hasDirectory(items, 'GM/4A GM'), false);
  assert.equal(hasDirectory(items, 'TOEIC'), true);
  assert.equal(latestActivity(items, 'GM/3A GM'), Date.parse(daysBefore(1)));
  assert.equal(latestActivity(items, 'GM/4A GM'), null);
});

test('un dossier de l’en-tête du bucket obtient sa carte même s’il est vide', () => {
  // L’index récursif ne voit pas un dossier vide : le listage racine fait foi.
  const { spaces, cards } = buildHomeCards(
    catalogOf([file('GM/3A GM/S5/poly.pdf', daysBefore(4))], { 'GM/3A GM': 1 }, 1),
    {
      now: NOW,
      rootItems: [
        folder('GM'),
        folder('TOEIC'),
        folder('Annales 2025'),
        file('Annales 2025/sujet.pdf', daysBefore(3)),
        file('README.md', daysBefore(200)),
      ],
    },
  );

  // Les espaces connus d’abord, puis les dossiers découverts.
  assert.deepEqual(spaces.map((space) => space.path), ['GM/3A GM', 'TOEIC', 'Annales 2025']);
  const annales = spaces[2];
  assert.equal(annales.dynamic, true);
  assert.equal(annales.badge, 'Nouveau');
  // TOEIC n’existe que dans l’index mais pas encore dans le listage : la carte
  // de l’espace connu reste affichée, sans doublon dynamique.
  assert.equal(spaces[1].dynamic, false);

  const library = cards[cards.length - 1];
  assert.equal(library.folders, 3);
  assert.equal(library.description, 'Annales 2025 · GM · TOEIC');
});

test('sans index, l’en-tête du bucket complète les espaces connus', () => {
  const { spaces, cards } = buildHomeCards(
    { items: [], counts: {}, totalFiles: null, loading: false, error: 'Index indisponible' },
    {
      now: NOW,
      rootItems: [
        folder('GM'),
        folder('TOEIC'),
        folder('Stages 2026'),
        file('Stages 2026/offre.pdf', daysBefore(5)),
      ],
    },
  );

  // Les 5 espaces connus restent affichés comme avant…
  assert.equal(spaces.length, FEATURED_SPACES.length + 1);
  assert.deepEqual(
    spaces.slice(0, FEATURED_SPACES.length).map((space) => space.path),
    FEATURED_SPACES.map((space) => space.path),
  );
  // … et le nouveau dossier racine apparaît, sans doublon pour GM / TOEIC.
  const added = spaces.slice(FEATURED_SPACES.length);
  assert.deepEqual(added.map((space) => space.path), ['Stages 2026']);
  assert.equal(added[0].badge, 'Nouveau');
  assert.equal(cards[cards.length - 1].description, 'GM · Stages 2026 · TOEIC');
});

test('les dossiers de l’en-tête se lisent depuis les entrées du listage', () => {
  const directories = rootDirectories([
    folder('GM'),
    file('GM/3A GM/poly.pdf', daysBefore(1)),
    folder('TOEIC'),
    file('README.md', daysBefore(2)),
  ]);
  assert.deepEqual([...directories].sort(), ['GM', 'TOEIC']);
  assert.equal(libraryDescription([]), 'Tous les dossiers du bucket');
  assert.equal(
    libraryDescription(['A', 'B', 'C', 'D', 'E'].map((name) => folder(name))),
    'A · B · C · +2',
  );
});
