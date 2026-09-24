export const BUCKET_ID = 'ktongue/ENISE-SITE';
export const BUCKET_URL = `https://huggingface.co/buckets/${BUCKET_ID}`;

/**
 * Viewer Office embarqué de Microsoft (Office Web Apps Viewer).
 *
 * Il nécessite que le fichier soit accessible publiquement : c’est le cas
 * en production via l’URL absolue du site (`/api/file?path=...`).
 */
export const OFFICE_WEB_VIEWER_BASE_URL = 'https://view.officeapps.live.com/op/embed.aspx';

/**
 * Limites des aperçus Office rendus localement dans le navigateur.
 *
 * Au-delà de ces seuils, la modale propose le Viewer Microsoft ou le
 * téléchargement plutôt que de figer l’onglet (surtout sur mobile).
 */
export const MAX_LOCAL_PREVIEW_BYTES = 15 * 1024 * 1024;

/**
 * Limite du viewer Office Web de Microsoft (`view.officeapps.live.com`).
 *
 * Au-delà de 10 Mo, le service refuse l’aperçu : l’onglet Microsoft affiche
 * alors un message avec lien de téléchargement au lieu de l’iframe.
 */
export const MAX_OFFICE_WEB_VIEWER_BYTES = 10 * 1024 * 1024;
export const MAX_XLSX_CELLS = 50_000;
export const XLSX_PAGE_SIZE = 500;

/**
 * Script du Viewer Autodesk (APS / Forge View & Data).
 *
 * La version `7.*` est la version stable maintenue par Autodesk ; le
 * navigateur télécharge ensuite les assets depuis le même domaine Autodesk.
 */
export const AUTODESK_VIEWER_API_URL =
  'https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/viewer3D.min.js';

/**
 * Espaces connus de la bibliothèque.
 *
 * Ce ne sont plus les seules cartes de l’accueil : `src/utils/spaces.js`
 * construit la liste complète à partir de l’index du bucket. Ces entrées
 * gardent leur titre, leur icône et leur couleur, mais une carte n’apparaît
 * que si le dossier existe encore dans le bucket.
 */
export const FEATURED_SPACES = [
  {
    title: '3e année GM',
    shortTitle: '3A',
    description: 'Semestres 5 & 6',
    path: 'GM/3A GM',
    tone: 'green',
    icon: 'layers',
  },
  {
    title: '4e année GM',
    shortTitle: '4A',
    description: 'Cours & projets avancés',
    path: 'GM/4A GM',
    tone: 'red',
    icon: 'tool',
  },
  {
    title: '5e année GM',
    shortTitle: '5A',
    description: 'Spécialités & fin d’études',
    path: 'GM/5A GM',
    tone: 'yellow',
    icon: 'award',
  },
  {
    title: 'Objectif TOEIC',
    shortTitle: 'TOEIC',
    description: 'Audio, tests & méthodes',
    path: 'TOEIC',
    tone: 'green',
    icon: 'headphones',
  },
  {
    title: 'Tutos SolidWorks',
    shortTitle: 'SW',
    description: 'Modéliser pas à pas',
    path: 'GM/Tutos SolidWorks',
    tone: 'red',
    icon: 'box',
  },
  {
    title: 'Espace commun',
    shortTitle: 'Commun',
    description: 'Ressources partagées',
    path: 'Commun',
    tone: 'green',
    icon: 'globe',
  },
];

/**
 * Teintes attribuées aux cartes créées depuis l’index (dossiers ajoutés au
 * bucket après la mise en ligne). Elles tournent pour éviter une grille
 * monochrome quand plusieurs dossiers apparaissent en même temps.
 */
export const SPACE_TONES = ['green', 'red', 'yellow'];

/**
 * Durée pendant laquelle un dossier compte comme « nouveau ».
 *
 * Passé ce délai, la carte reste affichée mais perd son badge.
 */
export const NEW_SPACE_WINDOW_DAYS = 30;

/**
 * Carte qui ouvre la racine du bucket : elle est toujours présente, même si
 * l’index n’a pas encore répondu.
 */
export const LIBRARY_ROOT_CARD = {
  title: 'Toute la bibliothèque',
  shortTitle: 'Bibliothèque',
  description: 'Tous les dossiers du bucket',
  path: '',
  tone: 'ink',
  icon: 'layers',
  library: true,
};

export const SIDE_LINKS = [
  { label: 'Accueil', path: '', icon: 'home' },
  { label: 'Génie mécanique', path: 'GM', icon: 'settings' },
  { label: '3e année', path: 'GM/3A GM', icon: 'book' },
  { label: '4e année', path: 'GM/4A GM', icon: 'book' },
  { label: '5e année', path: 'GM/5A GM', icon: 'book' },
  { label: 'Préparation TOEIC', path: 'TOEIC', icon: 'globe' },
  { label: 'SolidWorks', path: 'GM/Tutos SolidWorks', icon: 'box' },
];
