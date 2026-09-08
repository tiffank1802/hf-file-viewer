/**
 * Lecture de la structure d’un fichier `.odb` (LibreOffice Base).
 *
 * Un `.odb` est un conteneur ZIP dont `content.xml` décrit les tables,
 * requêtes, formulaires et états (espace de noms `db:`). Les données des
 * tables embarquées sont binaires (HSQLDB) et ne sont pas extractibles :
 * on ne liste que la structure, sans DOM (testable sous Node).
 */

const XML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': '’',
};

function decodeXmlEntities(value) {
  return String(value).replace(
    /&(amp|lt|gt|quot|apos);/g,
    (entity) => XML_ENTITIES[entity] || entity,
  );
}

/** Extrait les attributs `db:name` (ou `name`) d’un élément `db:<localName>`. */
function extractNames(xml, localName) {
  const pattern = new RegExp(
    `<db:${localName}\\b[^>]*?\\b(?:db:)?name=(["'])(.*?)\\1`,
    'g',
  );
  const names = [];
  let match = pattern.exec(xml);
  while (match) {
    const name = decodeXmlEntities(match[2]).trim();
    if (name) names.push(name);
    match = pattern.exec(xml);
  }
  return names;
}

/** Contenu textuel d’une section `<db:<localName>>…</db:<localName>>` (ou vide). */
function extractSection(xml, localName) {
  const match = xml.match(
    new RegExp(`<db:${localName}\\b[^>]*>([\\s\\S]*?)</db:${localName}>`),
  );
  return match ? match[1] : '';
}

/**
 * Noms des composants d’une section (`forms` ou `reports`).
 *
 * Les deux sections utilisent `<db:component db:name="…">` : on découpe
 * d’abord la section pour ne pas mélanger formulaires et états. Repli sur
 * tout attribut `db:name` de la section si la variante change.
 */
function extractComponents(xml, section) {
  const content = extractSection(xml, section);
  if (!content) return [];
  const components = extractNames(content, 'component');
  if (components.length > 0) return components;
  return extractNames(`<db:component ${content}>`, 'component');
}

const DATASOURCE_LABELS = [
  [/sdbc:embedded:hsqldb/i, 'HSQLDB embarquée'],
  [/sdbc:hsqldb/i, 'HSQLDB'],
  [/sdbc:mysql/i, 'MySQL / MariaDB'],
  [/sdbc:postgresql/i, 'PostgreSQL'],
  [/sdbc:calc/i, 'Classeur LibreOffice (Calc)'],
  [/sdbc:writer/i, 'Document LibreOffice (Writer)'],
  [/sdbc:address/i, 'Carnet d’adresses'],
  [/sdbc:odbc/i, 'ODBC'],
  [/sdbc:jdbc/i, 'JDBC'],
];

function detectDataSource(xml) {
  for (const [pattern, label] of DATASOURCE_LABELS) {
    if (pattern.test(xml)) return label;
  }
  return null;
}

/**
 * Structure d’une base à partir de son `content.xml` (texte).
 * Ne lance jamais d’exception : tout échec donne des listes vides.
 */
export function parseOdbStructure(contentXml = '') {
  const xml = String(contentXml || '');
  if (!xml) {
    return { tables: [], queries: [], forms: [], reports: [], dataSource: null };
  }
  try {
    return {
      tables: extractNames(xml, 'table-representation'),
      queries: extractNames(xml, 'query'),
      forms: extractComponents(xml, 'forms'),
      reports: extractComponents(xml, 'reports'),
      dataSource: detectDataSource(xml),
    };
  } catch {
    return { tables: [], queries: [], forms: [], reports: [], dataSource: null };
  }
}
