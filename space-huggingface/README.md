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
   `.stl` and `.obj` are tessellated (headless FreeCAD + trimesh)
   and served as `.glb` with viewer metadata. Consumed by the Cloudflare
   Worker (`GET /api/model3d/glb` → `POST /api/convert-3d`).
2. **Office documents → PDF** (Word, Excel, PowerPoint, OpenDocument) with
   headless LibreOffice, consumed by the Cloudflare Worker
   (`GET /api/office/pdf` → `POST /api/convert-office`).
3. **SolidWorks → STEP** (`.sldprt` / `.sldasm`) with the separately supplied
   licensed HOOPS Converter, then publication of the STEP and a provenance
   manifest in the Hugging Face Storage Bucket.

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
.step/.stp/.iges/.igs → FreeCAD (freecadcmd) → .stl → trimesh → .glb
.stl/.obj              → trimesh directly → .glb
```

- **FreeCAD** parses STEP/IGES, then tessellates (`Shape.tessellate`) with a
  tolerance of 0.5 mm (`draft`), 0.1 mm (`standard`) or 0.03 mm (`fine`).
- **trimesh** converts STL/OBJ to GLB with proper scaling (mm → meters,
  factor `0.001`) and computes the metadata.
- Conversions run in a thread pool (5 min tessellation timeout, 15 min total)
  so the Gradio UI stays responsive; files are capped at 25 MB.

Supported inputs: `.step`, `.stp`, `.iges`, `.igs`, `.stl`, `.obj`.
Proprietary formats (`.sldprt`, `.dwg`, `.rvt`, CATIA…) and assemblies stay
on the Autodesk pipeline: FreeCAD has no importer for them.
Failures return JSON (`{"detail": "..."}`) with a `4xx`/`5xx` status
(`422` = unsupported format or corrupt model, `413` = file too large).
A `GET /api/health` endpoint is available for monitoring, and the
"CAD to GLB" Gradio tab exposes the same engine for manual testing.

## SolidWorks → STEP + bucket API

`POST /api/convert-solidworks-step` accepts a multipart upload and publishes
both the generated STEP and a JSON manifest to the configured bucket. It is
called by the Cloudflare Worker, not directly by the browser:

```bash
curl -X POST https://<hoops-space>.hf.space/api/convert-solidworks-step \\
  -H "Authorization: Bearer <internal-service-token>" \\
  -F "file=@piece.sldprt;filename=piece.sldprt" \\
  -F "source_path=GM/piece.sldprt" \\
  -F "output_path=derived/step/GM/piece.step" \\
  -F "source_sha256=<sha256>"
```

For an assembly, the Worker repeats the `dependencies` field and sends a JSON
`dependency_manifest` with relative paths and SHA-256 values. The Space writes
those files beside the `.sldasm` before launching HOOPS:

```bash
curl -X POST https://<hoops-space>.hf.space/api/convert-solidworks-step \\
  -H "Authorization: Bearer <internal-service-token>" \\
  -F "file=@assembly.sldasm;filename=assembly.sldasm" \\
  -F 'dependency_manifest=[{"path":"parts/base.sldprt","sha256":"<sha256>"}]' \\
  -F "dependencies=@parts/base.sldprt;filename=parts/base.sldprt" \\
  -F "source_path=GM/assembly.sldasm" \\
  -F "output_path=derived/step/GM/assembly.step" \\
  -F "source_sha256=<sha256>"
```

Required runtime configuration:

- `HOOPS_CONVERTER_PATH` (default `/opt/hoops/bin/converter`) pointing to the
  licensed native HOOPS Converter binary;
- `HOOPS_LICENSE_FILE` **or** `HOOPS_LICENSE_KEY` (secret; never commit it);
- `HOOPS_STEP_EXPORT_FORMAT=2` for AP242, `1` for AP214 or `0` for AP203;
- `HF_BUCKET_ID=ktongue/ENISE-SITE` (surchargeable avec `namespace/bucket`);
- `HF_TOKEN` with write permission on that bucket;
- `SOLIDWORKS_CONVERTER_TOKEN` shared only with the Worker;
- `HOOPS_USE_XVFB=1` when the converter needs the headless X server;
- `MAX_SOLIDWORKS_UPLOAD_BYTES=104857600` per file, plus
  `MAX_SOLIDWORKS_BUNDLE_BYTES=262144000` and
  `MAX_SOLIDWORKS_DEPENDENCY_FILES=64` for assembly workspaces.

The proprietary HOOPS package is intentionally not committed or uploaded by
this repository’s deployment script. Build a private image/Space containing
the package or set `HOOPS_CONVERTER_PATH` to a mounted installation. Without
it, the endpoint returns `501` and the existing Autodesk viewer remains the
fallback.

The result is written under `derived/step/`, and the source SolidWorks file is
never overwritten. The manifest records the source SHA-256, dependency paths
and SHA-256 values, STEP SHA-256, export AP and converter version. The Worker
collects referenced-looking `.sldprt`/`.sldasm` files from the assembly folder
and its subfolders; external references outside that workspace still require
manual packaging or may produce an incomplete assembly.

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

⚠️ The free **FreeCAD → GLB** pipeline cannot read `.sldprt`, `.sldasm`,
`.dwg`, `.rvt`, CATIA or other vendor-locked formats. SolidWorks conversion is
a separate licensed HOOPS pipeline described above.

The STEP export does not preserve SolidWorks feature history, equations or
mates. AP242 may preserve PMI and validation properties, but this must be
verified on representative files. Assemblies need their referenced parts and
sub-assemblies; drawings (`.slddrw`) are not converted to STEP.

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

- Unsupported format (anything outside `.step`/`.iges`/`.stl`/`.obj`, including `.sldprt`)
- Corrupt or empty models (`422`)
- Oversized files (`413`, max 25 MB)
- FreeCAD parsing failures (unsupported features)
- Timeout (complex parts taking > 5 minutes to tessellate)

## Deployment

From the repository root (requires a Hugging Face write token, never commit it):

```bash
HF_TOKEN="hf_..." npm run deploy:space -- --space-id <user>/<space-id>
```

This uploads `Dockerfile`, `requirements.txt`, `app.py`, the FreeCAD helper
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
