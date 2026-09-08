---
title: ENISE Converters (3D + Office)
emoji: 🔄
colorFrom: blue
colorTo: green
sdk: docker
port: 7860
pinned: false
license: mit
---

# ENISE Converters

This Space powers the file conversions of the ENISE Docs website:

1. **CAD → GLB** for web visualization: `.step`, `.stp`, `.iges`, `.igs`,
   `.stl`, `.obj` and `.sldprt` are tessellated (headless FreeCAD + trimesh)
   and served as `.glb` with viewer metadata. Consumed by the Cloudflare
   Worker (`GET /api/model3d/glb` → `POST /api/convert-3d`).
2. **Office documents → PDF** (Word, Excel, PowerPoint, OpenDocument) with
   headless LibreOffice, consumed by the Cloudflare Worker
   (`GET /api/office/pdf` → `POST /api/convert-office`).

## 3D → GLB conversion API

`POST /api/convert-3d` accepts a multipart upload (`file` field, original
filename **must keep its extension** so the converter detects the format) and
an optional `quality` field (`draft`, `standard` or `fine`, default
`standard`). It returns `model/gltf-binary` on success, with viewer metadata
(triangles, vertices, bounding box, size, volume) as base64url JSON in the
`X-Model3D-Meta` response header:

```bash
curl -X POST https://<your-space>.hf.space/api/convert-3d \
  -F "file=@part.step;filename=part.step" -F "quality=standard" \
  --output part.glb -D - | grep -i x-model3d-meta
```

Pipeline:

```text
.step/.stp/.iges/.igs/.sldprt → FreeCAD (freecadcmd) → .stl → trimesh → .glb
.stl/.obj                      → trimesh directly → .glb
```

- **FreeCAD** parses STEP/IGES and the experimental SolidWorks importer, then
  tessellates (`Shape.tessellate`) with a tolerance of 0.5 mm (`draft`),
  0.1 mm (`standard`) or 0.03 mm (`fine`).
- **trimesh** converts STL/OBJ to GLB with proper scaling (mm → meters,
  factor `0.001`) and computes the metadata.
- Conversions run in a thread pool (5 min tessellation timeout, 15 min total)
  so the Gradio UI stays responsive; files are capped at 25 MB.

Supported inputs: `.step`, `.stp`, `.iges`, `.igs`, `.stl`, `.obj`, `.sldprt`
(DWG, RVT, CATIA and assemblies stay on the Autodesk pipeline).
Failures return JSON (`{"detail": "..."}`) with a `4xx`/`5xx` status
(`422` = unsupported format or corrupt model, `413` = file too large).
A `GET /api/health` endpoint is available for monitoring, and the
"CAD to GLB" Gradio tab exposes the same engine for manual testing.

## Office → PDF conversion API

`POST /api/convert-office` accepts a multipart upload (`file` field, original
filename **must keep its extension** so LibreOffice detects the format) and
returns `application/pdf` on success:

```bash
curl -X POST https://<your-space>.hf.space/api/convert-office \
  -F "file=@document.docx;filename=document.docx" \
  --output document.pdf
```

Supported inputs: `.doc`, `.docx`, `.docm`, `.xls`, `.xlsx`, `.xlsm`,
`.ppt`, `.pptx`, `.pptm`, `.odt`, `.ods`, `.odp` (max 25 MB).
Failures return JSON (`{"detail": "..."}`) with a `4xx`/`5xx` status.
A `GET /api/health` endpoint is available for monitoring, and the
"Office to PDF" Gradio tab exposes the same engine for manual testing.

## Important Limitations (3D)

⚠️ **Experimental Format Support**: the `.sldprt` import module in FreeCAD is experimental.

- ✅ Works best with **geometrically simple parts**
- ⚠️ May fail with complex surfaces or recent SolidWorks features
- ❌ Does **not** preserve:
  - Parametric feature history
  - Colors or materials
  - Assembly structure (only single parts supported)
- ✅ Preserves: **Geometry only** (tessellated mesh)

For best results with recent SolidWorks files, export to **STEP** first.

## Display the GLB in your webpage

Any glTF viewer works (three.js, `<model-viewer>`, Babylon.js):

```html
<!-- Include model-viewer script -->
<script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js"></script>

<!-- Display the converted model -->
<model-viewer
    src="URL_TO_YOUR_GLB_FILE.glb"
    camera-controls
    auto-rotate
    shadow-intensity="1"
    style="width: 100%; height: 500px;">
</model-viewer>
```

The ENISE Docs website renders the GLB with three.js (orbit controls,
quality switch, triangle/bounding-box metadata from `X-Model3D-Meta`).

## Cold Start Notice

⏱️ **First request may take 30-60 seconds** - Free Hugging Face Spaces go to sleep after inactivity. Subsequent requests are faster.

## Error Handling

The converter provides clear error messages for:

- Unsupported format (anything outside `.step`/`.iges`/`.stl`/`.obj`/`.sldprt`)
- Corrupt or empty models (`422`)
- Oversized files (`413`, max 25 MB)
- FreeCAD parsing failures (unsupported features)
- Timeout (complex parts taking > 5 minutes to tessellate)

## Deployment

From the repository root (requires a Hugging Face write token, never commit it):

```bash
HF_TOKEN="hf_..." npm run deploy:space -- --space-id <user>/<space-id>
```

This uploads `Dockerfile`, `requirements.txt`, `app.py`, the FreeCAD helpers
and this README (which switches the Space to the Docker SDK). It overwrites
the Space content — back up any existing Space app first.

## For Production Use

This pipeline is suitable for:

- ✅ Personal projects
- ✅ Portfolios
- ✅ Prototypes
- ✅ Simple part visualization

For industrial-grade reliability (complex assemblies, critical tolerances), consider migrating the conversion step to a commercial SDK:

- HOOPS Exchange
- CAD Exchanger
- Open Design Alliance

The display layer (three.js / `<model-viewer>`) remains identical regardless of conversion method.

## Technical Details

- **Base Image**: `python:3.11-slim`
- **FreeCAD**: Installed via apt (`freecad`, `freecad-python3`)
- **LibreOffice**: headless Writer/Calc/Impress + Liberation/DejaVu fonts
- **Python Dependencies**: gradio, fastapi, uvicorn, trimesh, numpy, python-multipart
- **Server**: FastAPI app (custom `/api/*` routes) with the Gradio UI mounted at `/`
- **Port**: 7860

## License

MIT License
