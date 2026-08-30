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
 * Script du Viewer Autodesk (APS / Forge View & Data).
 *
 * La version `7.*` est la version stable maintenue par Autodesk ; le
 * navigateur télécharge ensuite les assets depuis le même domaine Autodesk.
 */
export const AUTODESK_VIEWER_API_URL =
  'https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/viewer3D.min.js';

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
];

export const SIDE_LINKS = [
  { label: 'Accueil', path: '', icon: 'home' },
  { label: 'Génie mécanique', path: 'GM', icon: 'settings' },
  { label: '3e année', path: 'GM/3A GM', icon: 'book' },
  { label: '4e année', path: 'GM/4A GM', icon: 'book' },
  { label: '5e année', path: 'GM/5A GM', icon: 'book' },
  { label: 'Préparation TOEIC', path: 'TOEIC', icon: 'globe' },
  { label: 'SolidWorks', path: 'GM/Tutos SolidWorks', icon: 'box' },
];
