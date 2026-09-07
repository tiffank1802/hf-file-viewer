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

1. **SolidWorks (.sldprt) → GLB** for web visualization using `<model-viewer>`.
2. **Office documents → PDF** (Word, Excel, PowerPoint, OpenDocument) with
   headless LibreOffice, consumed by the Cloudflare Worker
   (`GET /api/office/pdf` → `POST /api/convert-office`).

## How it works

1. **Upload** a `.sldprt` file
2. **Convert** using FreeCAD (headless) → STL, then trimesh → GLB
3. **Download** the converted `.glb` file for use in your web project

## Architecture

```
.sldprt → FreeCAD (freecadcmd) → .stl → trimesh → .glb
```

- **FreeCAD** handles the proprietary SolidWorks format parsing
- **trimesh** converts STL to GLB with proper scaling (mm → meters)
- Scaling factor: `0.001` (SolidWorks uses mm, glTF expects meters)

## Important Limitations

⚠️ **Experimental Format Support**: The `.sldprt` import module in FreeCAD is experimental.

- ✅ Works best with **geometrically simple parts**
- ⚠️ May fail with complex surfaces or recent SolidWorks features
- ❌ Does **not** preserve:
  - Parametric feature history
  - Colors or materials
  - Assembly structure (only single parts supported)
- ✅ Preserves: **Geometry only** (tessellated mesh)

## Usage from your website

### Python Backend (recommended)

```python
from gradio_client import Client

# Initialize client (do this once, server-side)
client = Client("your-username/sldprt-to-glb")

# Convert a file
result = client.predict(
    uploaded_file="/path/to/your/part.sldprt",
    api_name="/process_file"
)

# result contains the path to the converted .glb file
print(f"Converted file: {result}")
```

### JavaScript/Node.js Backend

```javascript
import { Client } from "@gradio/client";

// Initialize client (server-side only - don't expose HF_TOKEN to client)
const client = new Client("your-username/sldprt-to-glb");

// Convert a file
const result = await client.predict("/process_file", {
    uploaded_file: fileInput.files[0]  // File from HTML input
});

console.log("Converted GLB:", result.data);
```

### Display in your webpage with model-viewer

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

## Cold Start Notice

⏱️ **First request may take 30-60 seconds** - Free Hugging Face Spaces go to sleep after inactivity. Subsequent requests are faster.

## Error Handling

The converter provides clear error messages for:
- Invalid file format (non-.sldprt files)
- FreeCAD parsing failures (unsupported features)
- Timeout (complex parts taking > 2 minutes)
- Missing dependencies

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

The display layer (`<model-viewer>`) remains identical regardless of conversion method.

## Technical Details

- **Base Image**: `python:3.11-slim`
- **FreeCAD**: Installed via apt (`freecad`, `freecad-python3`)
- **LibreOffice**: headless Writer/Calc/Impress + Liberation/DejaVu fonts
- **Python Dependencies**: gradio, trimesh, numpy, uvicorn, python-multipart
- **Server**: FastAPI app (custom `/api/*` routes) with the Gradio UI mounted at `/`
- **Port**: 7860

## License

MIT License
