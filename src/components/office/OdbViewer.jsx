import { useEffect, useState } from 'react';
import { FiDownload } from 'react-icons/fi';
import { useOfficeFile } from '../../hooks/useOfficeFile';
import { fileProxyUrl } from '../../services/api';
import { formatBytes } from '../../utils/files';
import { parseOdbStructure } from '../../utils/odb';
import { ViewerError, ViewerLoader } from './common';

const ODB_SECTIONS = [
  { key: 'tables', label: 'Tables' },
  { key: 'queries', label: 'Requêtes' },
  { key: 'forms', label: 'Formulaires' },
  { key: 'reports', label: 'États' },
];

async function extractStructure(JSZip, buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.files['content.xml'];
  if (!entry) {
    throw new Error('content.xml introuvable');
  }
  return parseOdbStructure(await entry.async('text'));
}

/**
 * Aperçu « structure » des bases `.odb` (LibreOffice Base).
 *
 * Aucun service web (ni Microsoft, ni conversion PDF) ne sait afficher une
 * base de données : on liste localement les tables, requêtes, formulaires
 * et états lus dans le `content.xml`. Les données restent consultables en
 * téléchargeant le fichier pour l’ouvrir dans LibreOffice Base.
 */
export default function OdbViewer({ file }) {
  const { buffer, loading, error } = useOfficeFile(file);
  const [structure, setStructure] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');

  useEffect(() => {
    if (!buffer) return undefined;

    let cancelled = false;
    setParsing(true);
    setParseError('');
    setStructure(null);

    import('jszip')
      .then(({ default: JSZip }) => {
        if (cancelled) return null;
        return extractStructure(JSZip, buffer);
      })
      .then((extracted) => {
        if (cancelled || !extracted) return;
        setStructure(extracted);
      })
      .catch((parseIssue) => {
        console.error('Cannot extract odb structure locally', parseIssue);
        if (!cancelled) {
          setParseError(
            'Cette base de données n’a pas pu être lue localement (fichier endommagé ou non Base).',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setParsing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [buffer]);

  if (loading || (!buffer && !error)) {
    return <ViewerLoader message="Téléchargement de la base de données…" />;
  }

  if (error || parseError) {
    return <ViewerError file={file} message={error || parseError} action={null} />;
  }

  if (parsing || !structure) {
    return <ViewerLoader message="Lecture de la structure de la base…" />;
  }

  const total = ODB_SECTIONS.reduce((count, section) => count + structure[section.key].length, 0);

  return (
    <div className="office-local-scroll odb-preview">
      <p className="pptx-notice">
        Base de données LibreOffice Base — structure uniquement
        {structure.dataSource ? ` (source : ${structure.dataSource})` : ''}. Les données
        des tables ne sont pas affichées : téléchargez le fichier pour l’ouvrir dans
        LibreOffice Base.
      </p>
      {total === 0 && (
        <p className="xlsx-empty">
          Aucun objet détecté (base vide ou format inattendu).
        </p>
      )}
      {ODB_SECTIONS.map((section) => (
        <section key={section.key} className="odb-section">
          <h4>{section.label} ({structure[section.key].length})</h4>
          {structure[section.key].length === 0 ? (
            <p className="odb-empty">(aucun{section.key === 'tables' || section.key === 'queries' ? 'e' : ''})</p>
          ) : (
            <ul>
              {structure[section.key].map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <p className="odb-download">
        <a href={fileProxyUrl(file.path, true)} download>
          <FiDownload aria-hidden="true" /> Télécharger · {formatBytes(file.size)}
        </a>
      </p>
    </div>
  );
}
