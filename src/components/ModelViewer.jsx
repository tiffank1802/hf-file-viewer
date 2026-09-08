import { useEffect, useState } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { getExtension, isModelExtension, modelViewerKind } from '../utils/files';
import AutodeskViewer from './AutodeskViewer';
import GlbViewer from './GlbViewer';
import OfficeModeTabs from './office/OfficeModeTabs';
import { ViewerError, ViewerLoader } from './office/common';

const MODEL_MODE_KEY = 'enise-docs:model-mode';

/** Demande au Worker si la conversion GLB FreeCAD est configurée. */
function useModel3dStatus(enabled) {
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    if (!enabled) {
      setStatus('disabled');
      return undefined;
    }

    const controller = new AbortController();
    setStatus('loading');
    fetch('/api/model3d/status', {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
      .then((response) => (response.ok ? response.json() : { status: 'not-configured' }))
      .then((payload) => setStatus(payload.status === 'ready' ? 'ready' : 'not-configured'))
      .catch((error) => {
        if (error.name !== 'AbortError') setStatus('not-configured');
      });

    return () => controller.abort();
  }, [enabled]);

  return status;
}

/**
 * Routeur des aperçus 3D : conversion GLB gratuite (pipeline type 3Dfindit)
 * ou viewer Autodesk (fidélité maximale, configuration requise).
 */
export default function ModelViewer({ file }) {
  const extension = getExtension(file.path);
  const glbKind = modelViewerKind(extension);
  const convertStatus = useModel3dStatus(glbKind === 'glb');
  const [storedMode, setStoredMode] = useLocalStorage(MODEL_MODE_KEY, '');

  if (!isModelExtension(extension)) {
    return (
      <ViewerError
        file={file}
        message="Ce format n’est pas pris en charge par la visionneuse 3D."
        action={null}
      />
    );
  }

  const modes = [];
  if (glbKind === 'glb' && convertStatus === 'ready') {
    modes.push({ id: 'web', label: 'Aperçu Web', hint: 'Modèle converti en GLB (gratuit, fonctionne partout)' });
  }
  modes.push({ id: 'autodesk', label: 'Autodesk', hint: 'Viewer Autodesk (fidélité maximale, configuration requise)' });

  // Le statut de conversion est encore inconnu et le mode Web est possible.
  if (glbKind === 'glb' && convertStatus === 'loading') {
    return <ViewerLoader message="Préparation de l’aperçu…" />;
  }

  const activeMode = modes.some((mode) => mode.id === storedMode) ? storedMode : modes[0].id;

  const switchActionFor = (currentId) => {
    const target = modes.find((mode) => mode.id !== currentId);
    if (!target) return null;
    return { label: `Essayer : ${target.label}`, onClick: () => setStoredMode(target.id) };
  };

  return (
    <div className="office-viewer">
      <OfficeModeTabs modes={modes} active={activeMode} onChange={setStoredMode} />
      <div className="office-viewer-body">
        {activeMode === 'web' ? (
          <GlbViewer file={file} onSwitchMode={switchActionFor('web')} />
        ) : (
          <AutodeskViewer file={file} />
        )}
      </div>
    </div>
  );
}
