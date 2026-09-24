import { useEffect, useRef, useState } from 'react';
import { model3dGlbUrl } from '../services/api';
import { ViewerError, ViewerLoader } from './office/common';

const QUALITIES = [
  { id: 'draft', label: 'Brouillon' },
  { id: 'standard', label: 'Standard' },
  { id: 'fine', label: 'Fin' },
];

/** Décode l’en-tête `X-Model3D-Meta` (base64url → JSON). */
function decodeModelMeta(header) {
  if (!header) return null;
  try {
    const binary = atob(header.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function formatCount(value) {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('fr-FR').format(Math.round(value));
}

/** Dimensions `[x, y, z]` en mètres → « 120 × 80 × 45 mm » ou « 1,2 × 0,8 × 0,9 m ». */
function formatSize(size) {
  if (!Array.isArray(size) || size.length !== 3 || !size.every(Number.isFinite)) return '—';
  const max = Math.max(...size);
  if (!(max > 0)) return '—';
  const formatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: max < 1 ? 1 : 2 });
  const parts = (max < 1 ? size.map((v) => v * 1000) : size).map((v) => formatter.format(v));
  return `${parts.join(' × ')} ${max < 1 ? 'mm' : 'm'}`;
}

/** Volume en m³ → mm³ lisibles pour les petites pièces. */
function formatVolume(volume) {
  if (!Number.isFinite(volume) || volume <= 0) return '—';
  const formatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  if (volume < 0.001) return `${formatter.format(volume * 1_000_000_000)} mm³`;
  return `${formatter.format(volume)} m³`;
}

/**
 * Aperçu WebGL d’un modèle converti en GLB par le Space FreeCAD.
 * three.js est chargé à la demande (`import()`) pour ne pas alourdir le bundle.
 */
export default function GlbViewer({ file, onSwitchMode = null }) {
  const containerRef = useRef(null);
  const controlsRef = useRef(null);
  const autoRotateRef = useRef(false);
  const [quality, setQuality] = useState('standard');
  const [loading, setLoading] = useState(true);
  const [loadMessage, setLoadMessage] = useState('Conversion en GLB…');
  const [error, setError] = useState('');
  const [meta, setMeta] = useState(null);
  const [ready, setReady] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!file || !container) return undefined;

    let disposed = false;
    let renderer = null;
    let scene = null;
    let controls = null;
    let resizeObserver = null;
    let raf = 0;
    const controller = new AbortController();

    setLoading(true);
    setReady(false);
    setError('');
    setMeta(null);
    setLoadMessage('Conversion en GLB… (compter jusqu’à une minute si le service dormait)');

    (async () => {
      try {
        const response = await fetch(model3dGlbUrl(file, quality), { signal: controller.signal });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          if (payload.status === 'not-configured') {
            throw new Error('La conversion 3D n’est pas configurée sur ce site.');
          }
          throw new Error(payload.error || 'La conversion en GLB a échoué.');
        }
        const metaHeader = response.headers.get('X-Model3D-Meta');
        const bytes = await response.arrayBuffer();
        if (disposed) return;
        setMeta(decodeModelMeta(metaHeader));

        setLoadMessage('Chargement du moteur 3D…');
        const THREE = await import('three');
        const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');
        if (disposed) return;

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(container.clientWidth || 800, container.clientHeight || 600);
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        container.appendChild(renderer.domElement);

        scene = new THREE.Scene();
        const pmrem = new THREE.PMREMGenerator(renderer);
        scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        pmrem.dispose();

        const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
        keyLight.position.set(3, 5, 4);
        scene.add(keyLight);
        const fillLight = new THREE.DirectionalLight(0xdfe8ff, 0.5);
        fillLight.position.set(-4, 2, -3);
        scene.add(fillLight);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa5a1, 0.9));

        const { scene: modelScene } = await new GLTFLoader().parseAsync(bytes, '');
        if (disposed) return;
        scene.add(modelScene);

        const box = new THREE.Box3().setFromObject(modelScene);
        const center = box.getCenter(new THREE.Vector3());
        const dims = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(dims.x, dims.y, dims.z) || 1;

        const camera = new THREE.PerspectiveCamera(
          45,
          (container.clientWidth || 800) / (container.clientHeight || 600),
          0.001,
          10000,
        );
        const fitDistance = maxDim / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        camera.position.copy(center).addScaledVector(new THREE.Vector3(1, 0.65, 1).normalize(), fitDistance * 1.5);
        camera.near = fitDistance / 100;
        camera.far = fitDistance * 100;
        camera.updateProjectionMatrix();

        const grid = new THREE.GridHelper(maxDim * 2, 20, 0x9fb3ab, 0xc9d4cf);
        grid.position.copy(center);
        grid.position.y = box.min.y - maxDim * 0.01;
        grid.material.transparent = true;
        grid.material.opacity = 0.5;
        scene.add(grid);

        controls = new OrbitControls(camera, renderer.domElement);
        controls.target.copy(center);
        controls.enableDamping = true;
        controls.autoRotate = autoRotateRef.current;
        controls.update();
        controlsRef.current = controls;

        resizeObserver = new ResizeObserver(() => {
          const width = container.clientWidth;
          const height = container.clientHeight;
          if (!width || !height || !renderer) return;
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          renderer.setSize(width, height);
        });
        resizeObserver.observe(container);

        const tick = () => {
          if (disposed) return;
          controls.update();
          renderer.render(scene, camera);
          raf = requestAnimationFrame(tick);
        };
        tick();

        setLoading(false);
        setReady(true);
      } catch (requestError) {
        if (requestError.name === 'AbortError' || disposed) return;
        setError(requestError.message || 'La conversion en GLB a échoué.');
        setLoading(false);
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      cancelAnimationFrame(raf);
      resizeObserver?.disconnect();
      controls?.dispose();
      controlsRef.current = null;
      if (scene) {
        scene.traverse((object) => {
          if (object.geometry) object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => {
            if (!material) return;
            Object.values(material).forEach((value) => {
              if (value && value.isTexture) value.dispose();
            });
            material.dispose();
          });
        });
      }
      renderer?.dispose();
      renderer?.domElement?.remove();
    };
  }, [file, quality]);

  const toggleAutoRotate = () => {
    const next = !autoRotate;
    setAutoRotate(next);
    autoRotateRef.current = next;
    if (controlsRef.current) controlsRef.current.autoRotate = next;
  };

  if (error) {
    return <ViewerError file={file} message={error} action={onSwitchMode} />;
  }

  const stats = meta
    ? [
        { label: 'Triangles', value: formatCount(meta.triangles) },
        { label: 'Sommets', value: formatCount(meta.vertices) },
        { label: 'Dimensions', value: formatSize(meta.size) },
        { label: 'Volume', value: formatVolume(meta.volume) },
      ]
    : [];

  return (
    <div className="model-web-preview">
      <div className="model-toolbar">
        <div className="model-quality" role="group" aria-label="Qualité du maillage">
          {QUALITIES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`model-quality-pill${quality === option.id ? ' active' : ''}`}
              aria-pressed={quality === option.id}
              onClick={() => setQuality(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`model-rotate${autoRotate ? ' active' : ''}`}
          aria-pressed={autoRotate}
          onClick={toggleAutoRotate}
          disabled={!ready}
        >
          ⟳ Rotation auto
        </button>
      </div>
      <div
        ref={containerRef}
        className="model-canvas"
        role="img"
        aria-label={`Aperçu 3D de ${file.name}`}
      />
      {loading && (
        <div className="model-overlay">
          <ViewerLoader message={loadMessage} />
        </div>
      )}
      {ready && stats.length > 0 && (
        <dl className="model-meta">
          {stats.map((stat) => (
            <div key={stat.label} className="model-meta-item">
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
