import { useEffect, useState } from 'react';
import { useOfficeFile } from '../../hooks/useOfficeFile';
import { ViewerError, ViewerLoader } from './common';

const SLIDE_PATH_PATTERN = /^ppt\/slides\/slide(\d+)\.xml$/i;

function slideNumber(path) {
  const match = path.match(SLIDE_PATH_PATTERN);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function childElements(node, localName) {
  if (typeof node.getElementsByTagNameNS === 'function') {
    return Array.from(node.getElementsByTagNameNS('*', localName));
  }
  return Array.from(node.getElementsByTagName(`a:${localName}`));
}

/**
 * Extrait le texte d’une diapositive, paragraphe par paragraphe (`<a:p>`).
 * Tout le rendu passe par React (texte échappé) : aucun HTML brut injecté.
 */
function extractSlideParagraphs(document) {
  return childElements(document, 'p')
    .map((paragraph) => (
      childElements(paragraph, 't')
        .map((node) => node.textContent || '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
    ))
    .filter(Boolean);
}

async function extractSlides(JSZip, buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slidePaths = Object.keys(zip.files)
    .filter((path) => SLIDE_PATH_PATTERN.test(path))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const slides = [];
  for (const path of slidePaths) {
    const xml = await zip.files[path].async('text');
    const document = new DOMParser().parseFromString(xml, 'application/xml');
    if (document.querySelector('parsererror')) continue;
    slides.push({ number: slideNumber(path), paragraphs: extractSlideParagraphs(document) });
  }
  return slides;
}

/**
 * Aperçu « texte » des `.pptx` / `.pptm` : aucune librairie front gratuite ne
 * rend fidèlement un PowerPoint, on extrait donc le contenu slide par slide.
 * Pour un rendu fidèle, voir les modes « PDF » et « Microsoft ».
 */
export default function PptxViewer({ file, onSwitchMode }) {
  const { buffer, loading, error } = useOfficeFile(file);
  const [slides, setSlides] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');

  useEffect(() => {
    if (!buffer) return undefined;

    let cancelled = false;
    setParsing(true);
    setParseError('');
    setSlides(null);

    import('jszip')
      .then(({ default: JSZip }) => {
        if (cancelled) return null;
        return extractSlides(JSZip, buffer);
      })
      .then((extracted) => {
        if (cancelled || !extracted) return;
        if (extracted.length === 0) {
          setParseError('Aucune diapositive n’a été trouvée dans cette présentation.');
          return;
        }
        setSlides(extracted);
      })
      .catch((parseIssue) => {
        console.error('Cannot extract pptx text locally', parseIssue);
        if (!cancelled) {
          setParseError(
            'Cette présentation n’a pas pu être lue localement (fichier endommagé).',
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
    return <ViewerLoader message="Téléchargement de la présentation…" />;
  }

  if (error || parseError) {
    return <ViewerError file={file} message={error || parseError} action={onSwitchMode} />;
  }

  if (parsing || !slides) {
    return <ViewerLoader message="Extraction du texte des diapositives…" />;
  }

  const withText = slides.filter((slide) => slide.paragraphs.length > 0);

  return (
    <div className="office-local-scroll pptx-preview">
      <p className="pptx-notice">
        Aperçu texte ({slides.length} diapositive{slides.length > 1 ? 's' : ''}) — mise en forme,
        images et animations non affichées. Pour un rendu fidèle, utilisez{' '}
        {onSwitchMode ? 'un autre mode ci-dessus.' : 'le téléchargement.'}
      </p>
      {withText.length === 0 && (
        <p className="xlsx-empty">
          Aucun texte extractible (diapositives scannées ou tout-images ?).
        </p>
      )}
      <ol className="pptx-slides">
        {slides.map((slide) => (
          <li key={slide.number} className="pptx-slide">
            <h4>Diapositive {slide.number}</h4>
            {slide.paragraphs.length === 0 ? (
              <p className="pptx-no-text">(aucun texte)</p>
            ) : (
              slide.paragraphs.map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
