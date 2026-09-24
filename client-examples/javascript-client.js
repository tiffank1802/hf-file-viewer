/**
 * Client example for calling the ENISE Converters Space (REST API).
 *
 * This Node.js example (v20+, no dependency) shows how to call the Hugging
 * Face Space from your backend server. The Space is public: no HF token
 * needed. Never expose HF_TOKEN to the client side.
 *
 * Supported 3D inputs: .step, .stp, .iges, .igs, .stl, .obj.
 * Note: FreeCAD cannot read .sldprt — export SolidWorks parts as STEP first.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

const CONVERTIBLE_3D = new Set(['.step', '.stp', '.iges', '.igs', '.stl', '.obj']);

/**
 * Convert a CAD file to GLB via POST /api/convert-3d.
 *
 * @param {string} cadFilePath - Path to the CAD file on your server.
 * @param {string} spaceRuntimeUrl - Space runtime URL (e.g. "https://user-space.hf.space").
 * @param {string} [quality] - "draft", "standard" or "fine" (tessellation density).
 * @returns {Promise<{glb: Buffer, meta: object}>} - GLB bytes + X-Model3D-Meta header.
 */
async function convertCadToGlb(cadFilePath, spaceRuntimeUrl, quality = 'standard') {
  const extension = extname(cadFilePath).toLowerCase();
  if (!CONVERTIBLE_3D.has(extension)) {
    throw new Error(`Invalid file format: ${extension || '(none)'}`);
  }

  const form = new FormData();
  form.append('file', new Blob([readFileSync(cadFilePath)]), basename(cadFilePath));
  form.append('quality', quality);

  let response;
  try {
    response = await fetch(`${spaceRuntimeUrl}/api/convert-3d`, { method: 'POST', body: form });
  } catch (error) {
    throw new Error(`Space unavailable: ${error.message}`);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(`Conversion rejected: ${payload.detail || `HTTP ${response.status}`}`);
  }

  const metaHeader = response.headers.get('x-model3d-meta') || '';
  const meta = metaHeader ? JSON.parse(Buffer.from(metaHeader, 'base64url').toString('utf8')) : {};
  const glb = Buffer.from(await response.arrayBuffer());
  console.log(`Converted ${basename(cadFilePath)} -> GLB (${glb.byteLength} bytes, ${meta.triangles} triangles)`);
  return { glb, meta };
}

/**
 * Express.js endpoint example.
 *
 * Usage in your Express app:
 *   app.post('/api/convert-3d', upload.single('file'), convertEndpoint);
 */
async function convertEndpoint(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const extension = extname(req.file.originalname || '').toLowerCase();
    if (!CONVERTIBLE_3D.has(extension)) {
      return res.status(400).json({ error: `Invalid file format: ${extension}` });
    }

    const spaceRuntimeUrl = process.env.SPACE_RUNTIME_URL || 'https://user-space.hf.space';
    const { glb } = await convertCadToGlb(req.file.path, spaceRuntimeUrl);
    res.setHeader('Content-Type', 'model/gltf-binary');
    return res.send(glb);
  } catch (error) {
    console.error('Conversion error:', error);
    return res.status(502).json({ error: error.message || 'Conversion failed' });
  }
}

// Example usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const spaceRuntimeUrl = process.env.SPACE_RUNTIME_URL || 'https://user-space.hf.space';
  convertCadToGlb('./example-part.step', spaceRuntimeUrl)
    .then(({ glb }) => {
      writeFileSync('./example-part.glb', glb);
      console.log('Converted file available at: ./example-part.glb');
    })
    .catch((error) => console.error('Error:', error.message));
}

export { convertCadToGlb, convertEndpoint };
