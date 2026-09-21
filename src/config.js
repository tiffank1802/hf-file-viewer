import { normalizeAppwriteEndpoint } from './utils/appwriteEndpoint.js';

export const BUCKET_ID = 'ktongue/ENISE-SITE';
export const BUCKET_URL = `https://huggingface.co/buckets/${BUCKET_ID}`;

/**
 * Appwrite — projet « Django objects » (region France, `fra.cloud.appwrite.io`).
 *
 * L'URL et l'ID de projet sont des identifiants publics : ils désignent le
 * backend, ils ne l'autorisent pas. L'accès aux données reste porté par le
 * cookie de session Appwrite et par les permissions de collection.
 * Les variables `VITE_APPWRITE_*` permettent de basculer sur un autre projet
 * (préproduction, instance self-hosted) sans toucher au code.
 */
/**
 * `import.meta.env` dans le bundle (Vite l'injecte à la build), `process.env`
 * sinon : les tests Node et `scripts/appwrite-setup.mjs` partagent ainsi la
 * même source de vérité que le frontend, sans variable dupliquée.
 * Seules les clés `VITE_` (publiques) sont lues — la règle du dépôt sur les clés
 * API reste vérifiée par tests/appwrite-config.test.js.
 */
const appwriteEnv = (typeof import.meta.env === 'object' && import.meta.env)
  || (typeof globalThis === 'object' ? globalThis.process?.env : null)
  || {};

export const APPWRITE_ENDPOINT = appwriteEnv.VITE_APPWRITE_ENDPOINT || 'https://fra.cloud.appwrite.io/v1';
export const APPWRITE_PROJECT_ID = appwriteEnv.VITE_APPWRITE_PROJECT_ID || '69cedb12002acdd498e0';
export const APPWRITE_PROJECT_NAME = 'Django objects';

/**
 * Base absolue pour les appels REST bruts (outillage de provisioning). L'SDK
 * web, lui, consomme APPWRITE_ENDPOINT tel quel — le `/v1` ne doit y apparaître
 * qu'une fois, d'où la normalisation partagée.
 */
export const APPWRITE_API_BASE = normalizeAppwriteEndpoint(APPWRITE_ENDPOINT);
export const APPWRITE_ENABLED = Boolean(APPWRITE_ENDPOINT && APPWRITE_PROJECT_ID);

/**
 * Tables créées par l'étape de provisioning (TablesDB — le service
 * `Databases` historique est déprécié depuis Appwrite 1.8)
 * (`docs/APPWRITE_AUTH_PLAN.md`, phase 1). Vide tant que la base n'existe pas :
 * le module Appwrite refuse alors les appels « données » sans lever d'erreur
 * réseau et affiche l'état « non provisionné ».
 */
export const APPWRITE_DATABASE_ID = appwriteEnv.VITE_APPWRITE_DATABASE_ID || '';
export const APPWRITE_PROFILE_TABLE_ID = appwriteEnv.VITE_APPWRITE_PROFILE_TABLE_ID || 'profiles';
export const APPWRITE_FAVORITES_TABLE_ID = appwriteEnv.VITE_APPWRITE_FAVORITES_TABLE_ID || 'favorites';
/**
 * Dialecte d'API des données. Appwrite 2.x sert TablesDB (`tables`/`rows`) ;
 * les instances plus anciennes ou les projets sans TablesDB n'exposent que
 * l'API héritée `Databases` (`collections`/`documents`). `scripts/appwrite-setup.mjs`
 * imprime la valeur détectée à la fin du provisioning.
 */
export const APPWRITE_FLAVOR = appwriteEnv.VITE_APPWRITE_FLAVOR === 'databases' ? 'databases' : 'tablesdb';

/** Fournisseur OAuth2 actif dans les settings Appwrite du projet ('' = désactivé). */
export const APPWRITE_OAUTH_PROVIDER = appwriteEnv.VITE_APPWRITE_OAUTH_PROVIDER || '';

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

/**
 * Vocabulaire du profil étudiant — source unique des listes `enum`.
 *
 * `scripts/appwrite-spec.js` en déduit les colonnes `enum` de la table
 * `profiles`, et `tests/appwrite-profile-vocabulary.test.js` échoue si l'UI
 * propose une valeur que la table refuserait (ou l'inverse). Une `<select>`
 * qui diverge d'un `enum` Appwrite se paie en `invalid_enum_value` au premier
 * enregistrement — un refus du serveur, que rien dans le code client annonçait.
 *
 * « TOEIC » est une préparation, pas une filière : c'est un chemin de
 * navigation (voir SIDE_LINKS), pas une valeur de profil.
 */
export const PROFILE_PROMOTIONS = ['3A', '4A', '5A', 'Alumni', 'Staff'];
export const PROFILE_FILIERES = ['GM', 'GC', 'GP', 'Autre'];

export const SIDE_LINKS = [
  { label: 'Accueil', path: '', icon: 'home' },
  { label: 'Génie mécanique', path: 'GM', icon: 'settings' },
  { label: '3e année', path: 'GM/3A GM', icon: 'book' },
  { label: '4e année', path: 'GM/4A GM', icon: 'book' },
  { label: '5e année', path: 'GM/5A GM', icon: 'book' },
  { label: 'Préparation TOEIC', path: 'TOEIC', icon: 'globe' },
  { label: 'SolidWorks', path: 'GM/Tutos SolidWorks', icon: 'box' },
];
