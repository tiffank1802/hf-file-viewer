import { useState } from 'react';
import { FiAlertCircle, FiCheck, FiDownload, FiRefreshCw } from 'react-icons/fi';
import { fileProxyUrl, solidworksStepUrl } from '../services/api';
import { formatBytes } from '../utils/files';
import { FileTypeIcon } from './Icons';

/**
 * Déclenche l’export serveur HOOPS SolidWorks → STEP et expose le fichier
 * généré depuis le bucket. La conversion reste volontairement explicite :
 * elle peut réveiller un service froid et consommer du CPU.
 */
export default function SolidworksStepViewer({ file }) {
  const [state, setState] = useState({ status: 'idle', error: '', result: null });

  const convert = async (force = false) => {
    setState({ status: 'loading', error: '', result: null });
    try {
      const response = await fetch(solidworksStepUrl(file, force), {
        method: 'POST',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          payload.error
          || payload.detail
          || (payload.status === 'not-configured'
            ? 'La conversion SolidWorks → STEP n’est pas configurée sur ce site.'
            : 'La conversion SolidWorks → STEP a échoué.'),
        );
      }
      setState({ status: 'success', error: '', result: payload });
    } catch (error) {
      setState({
        status: 'error',
        error: error.name === 'AbortError' ? 'La demande a été annulée.' : error.message,
        result: null,
      });
    }
  };

  const result = state.result;
  const outputPath = result?.stepPath || result?.step_path;
  const downloadUrl = outputPath ? fileProxyUrl(outputPath, true) : '';
  const isLoading = state.status === 'loading';

  return (
    <div className="solidworks-step-viewer">
      <div className="solidworks-step-card">
        <span className="solidworks-step-icon"><FileTypeIcon kind="model" size={34} /></span>
        <h3>Exporter en STEP</h3>
        <p>
          Le fichier SolidWorks sera converti par HOOPS Converter puis enregistré
          dans le bucket Hugging Face, sans supprimer le fichier original.
        </p>

        {state.status === 'error' && (
          <div className="solidworks-step-error" role="alert">
            <FiAlertCircle aria-hidden="true" />
            <span>{state.error}</span>
          </div>
        )}

        {state.status === 'success' && outputPath ? (
          <div className="solidworks-step-success" role="status">
            <div className="solidworks-step-success-title">
              <FiCheck aria-hidden="true" />
              <strong>{result.cached ? 'STEP déjà disponible' : 'STEP enregistré dans le bucket'}</strong>
            </div>
            <code>{outputPath}</code>
            {Number.isFinite(Number(result.size)) && <small>{formatBytes(result.size)}</small>}
          </div>
        ) : (
          <button
            type="button"
            className="viewer-switch solidworks-step-button"
            onClick={() => convert(false)}
            disabled={isLoading}
          >
            {isLoading ? <><span className="solidworks-step-spinner" /> Conversion en cours…</> : 'Convertir et enregistrer le STEP'}
          </button>
        )}

        {state.status === 'success' && outputPath && (
          <div className="solidworks-step-actions">
            <a href={downloadUrl} download>
              <FiDownload aria-hidden="true" /> Télécharger le STEP
            </a>
            <button type="button" className="viewer-switch" onClick={() => convert(true)} disabled={isLoading}>
              <FiRefreshCw aria-hidden="true" /> Régénérer
            </button>
          </div>
        )}

        <p className="solidworks-step-note">
          L’historique paramétrique SolidWorks n’est pas conservé dans un fichier STEP.
          Autodesk reste disponible pour l’aperçu du modèle original.
        </p>
      </div>
    </div>
  );
}
