import { countFilesByDirectory, normalizeBucketItem } from '../utils/files.js';

const UPDATED_AT = '2026-08-20T10:00:00.000Z';

const directory = (path, count = null) =>
  normalizeBucketItem({ type: 'directory', path, count, mtime: UPDATED_AT });
const file = (path, size) =>
  normalizeBucketItem({ type: 'file', path, size, mtime: UPDATED_AT });

const FALLBACK_TREE = {
  '': [directory('GM', 7483), directory('TOEIC', 2142)],
  GM: [
    directory('GM/3A GM', 1815),
    directory('GM/4A GM', 1966),
    directory('GM/5A GM', 1155),
    directory('GM/Tutos SolidWorks', 2547),
  ],
  'GM/3A GM': [directory('GM/3A GM/S5', 1357), directory('GM/3A GM/S6', 458)],
  'GM/3A GM/S5': [
    directory('GM/3A GM/S5/Calcul Tensoriel', 13),
    directory('GM/3A GM/S5/Calculs Scientifiques', 9),
    directory('GM/3A GM/S5/Conception des systemes', 45),
    directory('GM/3A GM/S5/Controle industriel', 5),
    directory('GM/3A GM/S5/Dimensionnement des liaisons', 18),
    directory('GM/3A GM/S5/English', 9),
    directory('GM/3A GM/S5/Gestion', 10),
    directory('GM/3A GM/S5/INTEGRATION DES SYSTEMES', 36),
    directory('GM/3A GM/S5/Industrialisation', 11),
    directory('GM/3A GM/S5/Ing.Vir', 103),
    directory('GM/3A GM/S5/Initiation à la simulation numérique', 9),
    directory('GM/3A GM/S5/Langue V2 Allemand', 6),
    directory('GM/3A GM/S5/Procedé de fabrication & Matériaux', 3),
    directory('GM/3A GM/S5/SEMESTRE1', 1025),
    directory('GM/3A GM/S5/SHS', 26),
    directory('GM/3A GM/S5/Transmission de puissance', 29),
  ],
  'GM/3A GM/S6': [
    directory('GM/3A GM/S6/Allemand s6', 12),
    directory('GM/3A GM/S6/Analyse num s6', 38),
    directory('GM/3A GM/S6/Anglais s6', 6),
    directory('GM/3A GM/S6/Economie S6', 326),
    directory('GM/3A GM/S6/Méca solides déformables s6', 19),
    directory('GM/3A GM/S6/Méca solides indéformables s6', 6),
    directory('GM/3A GM/S6/Phy Elec S6', 12),
    directory('GM/3A GM/S6/Physique élec s6', 11),
    directory('GM/3A GM/S6/Stat&Prob S6', 9),
    directory('GM/3A GM/S6/Traitement du signal s6', 16),
    directory('GM/3A GM/S6/Transmission de puissance S6', 3),
  ],
  'GM/3A GM/S5/Calcul Tensoriel': [
    file('GM/3A GM/S5/Calcul Tensoriel/CahierExos.pdf', 337000),
    file('GM/3A GM/S5/Calcul Tensoriel/CalculMatriciel_1A_2022-2023.pdf', 321000),
    file('GM/3A GM/S5/Calcul Tensoriel/ClassificationEDP.pdf', 1410000),
    file('GM/3A GM/S5/Calcul Tensoriel/CorrecExo9EDP.pdf', 1040000),
    file('GM/3A GM/S5/Calcul Tensoriel/CorrectionEDP-Exo6-ondes.pdf', 1430000),
    file('GM/3A GM/S5/Calcul Tensoriel/CorrectionExos5-6-Tenseurs.pdf', 236000),
    file('GM/3A GM/S5/Calcul Tensoriel/ExoSupSeparationVariables.pdf', 322000),
    file('GM/3A GM/S5/Calcul Tensoriel/ExosSupsEDP.pdf', 686000),
    file('GM/3A GM/S5/Calcul Tensoriel/ExosSupsTenseurs.pdf', 601000),
    file('GM/3A GM/S5/Calcul Tensoriel/Poly.pdf', 787000),
    file('GM/3A GM/S5/Calcul Tensoriel/Slides.pdf', 1200000),
    file('GM/3A GM/S5/Calcul Tensoriel/Tenseurs_Exo11.pdf', 769000),
    file('GM/3A GM/S5/Calcul Tensoriel/Tenseurs_Exo12.pdf', 375000),
  ],
  'GM/4A GM': [
    directory('GM/4A GM/All', 2),
    directory('GM/4A GM/Anglais S8', 8),
    directory('GM/4A GM/CHELS', 2),
    directory('GM/4A GM/COMMUN', 50),
    directory('GM/4A GM/Commande des systemes par calculateurs', 151),
    directory('GM/4A GM/Conception des systèmes de transfert de fluide S8', 4),
    directory('GM/4A GM/Conception des systèmes mécatroniques S8', 374),
    directory('GM/4A GM/Dimensionnement de structure S8', 262),
    directory('GM/4A GM/Droit S8', 22),
    directory('GM/4A GM/Dynamique et energetique des fluides', 30),
    directory('GM/4A GM/Gestion de prod s8', 20),
    directory('GM/4A GM/Gestion de production', 39),
    directory('GM/4A GM/Ingéniérie Matériaux-Procédés S8', 125),
    directory('GM/4A GM/Maitrise de variation', 51),
    directory('GM/4A GM/Maitrise des procedes haute temperature', 6),
    directory('GM/4A GM/Mécanique des solides déformables 2 S8', 288),
    directory('GM/4A GM/Optimisations S8', 49),
    directory("GM/4A GM/Outil d'analyse système", 22),
    directory('GM/4A GM/Outil de gestion de performance S8', 9),
    directory('GM/4A GM/Projet S8', 276),
    directory('GM/4A GM/SEMESTRE2', 49),
    directory('GM/4A GM/Simulation et FAO UGV', 3),
    directory('GM/4A GM/Thermique', 18),
    directory('GM/4A GM/Transition ecolo S8', 94),
    directory('GM/4A GM/Énergie renouvelable S8', 12),
  ],
  'GM/4A GM/All': [
    file('GM/4A GM/All/AUD-All2.aac', 3920000),
    file('GM/4A GM/All/BILAN  GR LEKT 6 LÖ docx.docx', 14000),
  ],
  'GM/5A GM': [directory('GM/5A GM/S9', 1155)],
  'GM/Tutos SolidWorks': [directory('GM/Tutos SolidWorks/SolidProfessor', 2547)],
  TOEIC: [
    directory('TOEIC/COMPASS TOEIC', 194),
    directory('TOEIC/Very Easy TOEIC', 65),
    directory('TOEIC/ĐỒNG HÀNH CHINH PHỤC TOEIC 990', 1883),
  ],
  'TOEIC/COMPASS TOEIC': [
    directory('TOEIC/COMPASS TOEIC/Analyst TOEIC', 38),
    directory('TOEIC/COMPASS TOEIC/Developing TOEIC', 8),
    directory('TOEIC/COMPASS TOEIC/Starter TOEIC', 54),
    directory('TOEIC/COMPASS TOEIC/Target TOEIC', 29),
    directory('TOEIC/COMPASS TOEIC/Very Easy TOEIC', 65),
  ],
};

export function getFallbackTree(path = '') {
  return FALLBACK_TREE[path] ? [...FALLBACK_TREE[path]] : [];
}

export function getFallbackIndex() {
  const items = new Map();
  Object.values(FALLBACK_TREE).flat().forEach((item) => items.set(item.path, item));
  return [...items.values()];
}

/**
 * Catalogue d’aperçu local, utilisé uniquement si `/api/index` est injoignable.
 * Les effectifs déclarés ici sont des ordres de grandeur de développement ;
 * en production, ils proviennent toujours du JSON d’index du Worker.
 */
export function getFallbackCatalog() {
  const items = getFallbackIndex();
  const counts = { ...countFilesByDirectory(items).counts };

  items.forEach((item) => {
    if (item.type !== 'directory') return;
    const declared = Number(item.count);
    if (Number.isFinite(declared) && declared > 0) counts[item.path] = declared;
  });

  const totalFiles = Object.entries(counts)
    .filter(([path]) => !path.includes('/'))
    .reduce((total, [, value]) => total + value, 0);

  return { items, counts, totalFiles };
}
