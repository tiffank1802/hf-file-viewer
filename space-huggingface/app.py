"""
ENISE conversion Space.

Pipelines:
1. CAD (.step/.stp/.iges/.igs/.stl/.obj) → .glb (FreeCAD + trimesh),
   exposed as a plain HTTP API (`POST /api/convert-3d`, quality levels) and
   as a Gradio tab. This is the 3Dfindit-style mesh pipeline feeding the
   website WebGL viewer.
2. Office documents (.doc/.docx/.xls/.xlsx/.ppt/.pptx/.odt/...) → .pdf
   (headless LibreOffice), exposed as a plain HTTP API for the Cloudflare
   Worker (`POST /api/convert-office`) and as a second Gradio tab.

Note: FreeCAD cannot read proprietary formats (.sldprt, .dwg, ...).
SolidWorks users should export their parts as STEP; other formats stay on
the Autodesk pipeline of the website.
"""

import base64
import json
import subprocess
import tempfile
from pathlib import Path

import gradio as gr
import trimesh
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response

# ---------------------------------------------------------------------------
# Office → PDF conversion (headless LibreOffice)
# ---------------------------------------------------------------------------

OFFICE_CONVERTIBLE_EXTENSIONS = frozenset({
    ".doc", ".docx", ".docm",
    ".xls", ".xlsx", ".xlsm",
    ".ppt", ".pptx", ".pptm",
    ".odt", ".ods", ".odp",
})
MAX_OFFICE_UPLOAD_BYTES = 25 * 1024 * 1024
OFFICE_CONVERT_TIMEOUT_SECONDS = 180


def convert_office_to_pdf_bytes(data: bytes, extension: str) -> bytes:
    """
    Convert an Office document to PDF with headless LibreOffice.

    Args:
        data: Raw bytes of the source document.
        extension: Lowercase suffix including the dot (e.g. ".docx").

    Returns:
        The PDF file as bytes.

    Raises:
        ValueError: when the format is not supported or empty.
        TimeoutError: when LibreOffice takes too long.
        RuntimeError: when LibreOffice fails to produce a PDF.
    """
    if extension not in OFFICE_CONVERTIBLE_EXTENSIONS:
        raise ValueError(f"Unsupported office format: {extension or '(none)'}")
    if not data:
        raise ValueError("Empty document.")

    with tempfile.TemporaryDirectory(prefix="office-convert-") as tmp:
        workdir = Path(tmp)
        source_path = workdir / f"input{extension}"
        source_path.write_bytes(data)
        outdir = workdir / "out"
        outdir.mkdir()
        # Isolated LibreOffice profile: concurrent conversions must not share
        # (and lock) the default user installation.
        profile = workdir / "lo-profile"

        cmd = [
            "soffice",
            "--headless",
            "--nologo",
            "--nolockcheck",
            "--norestore",
            f"-env:UserInstallation=file://{profile}",
            "--convert-to", "pdf",
            "--outdir", str(outdir),
            str(source_path),
        ]
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=OFFICE_CONVERT_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError(
                "LibreOffice conversion timed out. The document may be too complex."
            ) from exc
        except FileNotFoundError as exc:
            raise RuntimeError("soffice not found. LibreOffice may not be installed.") from exc

        pdf_path = outdir / "input.pdf"
        if result.returncode != 0 or not pdf_path.exists():
            details = (result.stderr or result.stdout or "").strip()
            raise RuntimeError(f"LibreOffice conversion failed: {details[:500]}")

        return pdf_path.read_bytes()


# ---------------------------------------------------------------------------
# CAD → GLB conversion (FreeCAD + trimesh, 3Dfindit-style mesh pipeline)
# ---------------------------------------------------------------------------

CAD_CONVERTIBLE_EXTENSIONS = frozenset({
    ".step", ".stp", ".iges", ".igs", ".stl", ".obj",
})
# Tessellation linear deflection in mm per quality level (FreeCAD Shape.tessellate).
CAD_QUALITY_TOLERANCES = {
    "draft": 0.5,
    "standard": 0.1,
    "fine": 0.03,
}
MAX_CAD_UPLOAD_BYTES = 50 * 1024 * 1024
CAD_CONVERT_TIMEOUT_SECONDS = 240


def _trimesh_to_glb(mesh_or_scene):
    """Scale mm → m, export GLB bytes and compute viewer metadata."""
    import numpy as np

    scene = mesh_or_scene
    if isinstance(scene, trimesh.Scene):
        geometries = [g for g in scene.geometry.values()]
        for geom in geometries:
            geom.apply_scale(0.001)
        scene = trimesh.Scene()
        for geom in geometries:
            scene.add_geometry(geom)
        bounds = scene.bounds
        triangles = int(sum(len(g.faces) for g in geometries if hasattr(g, "faces")))
        vertices = int(sum(len(g.vertices) for g in geometries if hasattr(g, "vertices")))
        watertight = bool(geometries) and all(
            bool(getattr(g, "is_watertight", False)) for g in geometries
        )
        volume = None
        if watertight and len(geometries) == 1:
            try:
                volume = float(geometries[0].volume)
            except Exception:
                volume = None
    else:
        scene.apply_scale(0.001)
        bounds = scene.bounds
        triangles = int(len(scene.faces)) if hasattr(scene, "faces") else 0
        vertices = int(len(scene.vertices)) if hasattr(scene, "vertices") else 0
        watertight = bool(getattr(scene, "is_watertight", False))
        try:
            volume = float(scene.volume) if watertight else None
        except Exception:
            volume = None

    bounds = np.asarray(bounds, dtype=float)
    size = (bounds[1] - bounds[0]).tolist()
    meta = {
        "triangles": triangles,
        "vertices": vertices,
        "bboxMin": [round(float(v), 6) for v in bounds[0].tolist()],
        "bboxMax": [round(float(v), 6) for v in bounds[1].tolist()],
        "size": [round(float(v), 6) for v in size],
        "volume": round(volume, 9) if volume is not None else None,
        "watertight": watertight,
        "units": "m",
    }
    return bytes(scene.export(file_type="glb")), meta


def _last_stdout_line(output: str) -> str:
    """Return the last non-empty stdout line (the converter script's message)."""
    lines = [line.strip() for line in (output or "").splitlines() if line.strip()]
    return lines[-1] if lines else ""


def friendly_cad_error(extension: str, raw_details: str = "") -> str:
    """
    Map a FreeCAD failure to a short user-facing message (French site).

    The converter script's own message is kept as a truncated single-line
    suffix for debuggability; the actionable guidance comes first.
    """
    raw = " ".join((raw_details or "").split())
    suffix = f" Détail technique : {raw[:200]}" if raw else ""
    if extension in (".step", ".stp", ".iges", ".igs"):
        return (
            "La pièce n’a pas pu être importée. Le fichier est peut-être corrompu, "
            "vide ou utilise des fonctions non supportées." + suffix
        )
    return raw[:300] or "Conversion failed."


def convert_cad_to_glb_bytes(data: bytes, extension: str, quality: str = "standard"):
    """
    Convert a CAD/mesh document to GLB with headless FreeCAD + trimesh.

    Args:
        data: Raw bytes of the source document.
        extension: Lowercase suffix including the dot (e.g. ".step").
        quality: One of "draft", "standard", "fine" (tessellation density).

    Returns:
        Tuple (glb_bytes, meta dict for the WebGL viewer).

    Raises:
        ValueError: unsupported format, quality or empty document.
        TimeoutError: conversion took too long.
        RuntimeError: conversion failed.
    """
    if extension not in CAD_CONVERTIBLE_EXTENSIONS:
        raise ValueError(f"Unsupported CAD format: {extension or '(none)'}")
    if quality not in CAD_QUALITY_TOLERANCES:
        raise ValueError(f"Unsupported quality: {quality}")
    if not data:
        raise ValueError("Empty document.")
    if len(data) > MAX_CAD_UPLOAD_BYTES:
        raise ValueError("Document too large for conversion (50 MB limit).")

    with tempfile.TemporaryDirectory(prefix="cad-convert-") as tmp:
        workdir = Path(tmp)
        source_path = workdir / f"input{extension}"
        source_path.write_bytes(data)

        if extension in (".stl", ".obj"):
            # Mesh formats need no CAD kernel: trimesh reads them directly.
            try:
                loaded = trimesh.load(str(source_path), force="scene")
            except Exception as exc:
                raise RuntimeError(f"Mesh parsing failed: {exc}") from exc
        else:
            stl_path = workdir / "output.stl"
            script = Path(__file__).parent / "freecad_cad_convert.py"
            if not script.exists():
                raise RuntimeError("FreeCAD conversion script not found.")
            cmd = [
                "freecadcmd",
                "--console",
                str(script),
                str(source_path),
                str(stl_path),
                str(CAD_QUALITY_TOLERANCES[quality]),
            ]
            try:
                result = subprocess.run(
                    cmd, capture_output=True, text=True,
                    timeout=CAD_CONVERT_TIMEOUT_SECONDS,
                )
            except subprocess.TimeoutExpired as exc:
                raise TimeoutError(
                    "FreeCAD conversion timed out. The model may be too complex."
                ) from exc
            except FileNotFoundError as exc:
                raise RuntimeError(
                    "freecadcmd not found. FreeCAD may not be installed."
                ) from exc
            if result.returncode != 0 or not stl_path.exists():
                # Prefer our script's message (stdout) over freecadcmd log noise.
                script_msg = _last_stdout_line(result.stdout)
                fallback = " ".join((result.stderr or "").split())
                raise RuntimeError(friendly_cad_error(extension, script_msg or fallback))
            try:
                loaded = trimesh.load(str(stl_path), force="mesh")
            except Exception as exc:
                raise RuntimeError(f"STL parsing failed: {exc}") from exc

        try:
            glb_bytes, meta = _trimesh_to_glb(loaded)
        except Exception as exc:
            raise RuntimeError(f"GLB export failed: {exc}") from exc
        meta["quality"] = quality
        meta["sourceFormat"] = extension
        return glb_bytes, meta


def encode_model_meta(meta: dict) -> str:
    """Encode viewer metadata for the X-Model3D-Meta HTTP header (base64url)."""
    raw = json.dumps(meta, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


api = FastAPI(title="ENISE conversion API")


@api.get("/api/health")
async def api_health():
    return {"ok": True, "service": "enise-convert"}


@api.post("/api/convert-office")
async def convert_office_endpoint(file: UploadFile = File(...)):
    """
    Convert an uploaded Office document to PDF.

    Used by the Cloudflare Worker (`GET /api/office/pdf`). The original
    filename (with its extension) must be preserved so LibreOffice can
    detect the input format.
    """
    extension = Path(file.filename or "").suffix.lower()
    if extension not in OFFICE_CONVERTIBLE_EXTENSIONS:
        raise HTTPException(
            status_code=422,
            detail=f"Format {extension or '(inconnu)'} non convertible en PDF.",
        )

    data = await file.read()
    if len(data) > MAX_OFFICE_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Document trop volumineux pour la conversion (limite 25 Mo).",
        )
    if not data:
        raise HTTPException(status_code=422, detail="Document vide.")

    try:
        pdf_bytes = convert_office_to_pdf_bytes(data, extension)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    stem = Path(file.filename or "document").stem or "document"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{stem}.pdf"'},
    )


@api.post("/api/convert-3d")
async def convert_3d_endpoint(
    file: UploadFile = File(...),
    quality: str = Form("standard"),
):
    """
    Convert an uploaded CAD/mesh document to GLB (3Dfindit-style pipeline).

    Used by the Cloudflare Worker (`GET /api/model3d/glb`). The original
    filename (with its extension) must be preserved so the converter can
    detect the input format. `quality` is one of draft|standard|fine.
    Viewer metadata travels in the X-Model3D-Meta response header.
    """
    extension = Path(file.filename or "").suffix.lower()
    if extension not in CAD_CONVERTIBLE_EXTENSIONS:
        raise HTTPException(
            status_code=422,
            detail=f"Format {extension or '(inconnu)'} non convertible en GLB.",
        )
    if quality not in CAD_QUALITY_TOLERANCES:
        raise HTTPException(status_code=422, detail=f"Qualité inconnue : {quality}.")

    data = await file.read()
    if len(data) > MAX_CAD_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Modèle trop volumineux pour la conversion (limite 50 Mo).",
        )
    if not data:
        raise HTTPException(status_code=422, detail="Document vide.")

    try:
        glb_bytes, meta = convert_cad_to_glb_bytes(data, extension, quality)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    stem = Path(file.filename or "model").stem or "model"
    return Response(
        content=glb_bytes,
        media_type="model/gltf-binary",
        headers={
            "Content-Disposition": f'inline; filename="{stem}.glb"',
            "X-Model3D-Meta": encode_model_meta(meta),
        },
    )


@api.exception_handler(HTTPException)
async def http_exception_handler(_request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


# ---------------------------------------------------------------------------
# CAD → .glb conversion (FreeCAD + trimesh)
# ---------------------------------------------------------------------------


def process_cad_file(input_file, quality="standard"):
    """Gradio interface function: CAD document → GLB + metadata (manual testing)."""
    if input_file is None:
        raise gr.Error("No file uploaded. Please upload a CAD document.")

    file_ext = Path(input_file).suffix.lower()
    if file_ext == ".sldprt":
        raise gr.Error(
            "FreeCAD cannot read SolidWorks files. Export the part as STEP "
            "from SolidWorks and retry."
        )
    if file_ext not in CAD_CONVERTIBLE_EXTENSIONS:
        raise gr.Error(f"Invalid file format. Got {file_ext}, expected a CAD document.")
    if quality not in CAD_QUALITY_TOLERANCES:
        raise gr.Error(f"Invalid quality: {quality}.")

    try:
        glb_bytes, meta = convert_cad_to_glb_bytes(Path(input_file).read_bytes(), file_ext, quality)
    except (ValueError, RuntimeError, TimeoutError) as exc:
        raise gr.Error(str(exc))

    output_path = Path(tempfile.gettempdir()) / f"{Path(input_file).stem}.glb"
    output_path.write_bytes(glb_bytes)
    return str(output_path), meta


def process_office_file(input_file):
    """Gradio interface function: Office document → PDF (manual testing)."""
    if input_file is None:
        raise gr.Error("No file uploaded. Please upload an Office document.")

    file_ext = Path(input_file).suffix.lower()
    if file_ext not in OFFICE_CONVERTIBLE_EXTENSIONS:
        raise gr.Error(f"Invalid file format. Got {file_ext}, expected an Office document.")

    try:
        pdf_bytes = convert_office_to_pdf_bytes(Path(input_file).read_bytes(), file_ext)
    except (ValueError, RuntimeError, TimeoutError) as exc:
        raise gr.Error(str(exc))

    output_path = Path(tempfile.gettempdir()) / f"{Path(input_file).stem}.pdf"
    output_path.write_bytes(pdf_bytes)
    return str(output_path)


# ---------------------------------------------------------------------------
# Gradio UI (mounted on the FastAPI app)
# ---------------------------------------------------------------------------

with gr.Blocks(title="ENISE Converters") as converter_ui:
    gr.Markdown("""
    # ENISE Converters

    - **CAD → GLB** : STEP/IGES/STL/OBJ vers maillage web
      (utilisée par le site via `POST /api/convert-3d`).
    - **Office → PDF** : conversion fidèle des documents Word/Excel/PowerPoint
      et OpenDocument (utilisée par le site via `POST /api/convert-office`).

    FreeCAD ne lit pas les formats propriétaires (.sldprt, .dwg…) : exportez
    vos pièces en STEP depuis votre CAO.
    """)

    with gr.Tab("Office to PDF"):
        gr.Markdown("""
        Upload a Word, Excel, PowerPoint or OpenDocument file to convert it to PDF
        with headless LibreOffice. Same engine as the automated
        `POST /api/convert-office` endpoint used by the website.
        """)

        with gr.Row():
            with gr.Column():
                office_input = gr.File(
                    label="Upload Office document",
                    file_types=sorted(OFFICE_CONVERTIBLE_EXTENSIONS),
                    type="filepath"
                )
                office_btn = gr.Button("Convert to PDF", variant="primary")

            with gr.Column():
                office_output = gr.File(
                    label="Download converted .pdf file",
                    file_types=[".pdf"]
                )

        office_btn.click(
            fn=process_office_file,
            inputs=office_input,
            outputs=office_output
        )

    with gr.Tab("CAD to GLB"):
        gr.Markdown("""
        Upload a CAD or mesh file (STEP, IGES, STL, OBJ) to convert it to
        GLB with FreeCAD + trimesh. Same engine as the
        automated `POST /api/convert-3d` endpoint used by the website WebGL
        viewer. Quality controls the tessellation density.
        """)

        with gr.Row():
            with gr.Column():
                cad_input = gr.File(
                    label="Upload CAD document",
                    file_types=sorted(CAD_CONVERTIBLE_EXTENSIONS),
                    type="filepath"
                )
                cad_quality = gr.Radio(
                    choices=["draft", "standard", "fine"],
                    value="standard",
                    label="Mesh quality"
                )
                cad_btn = gr.Button("Convert to GLB", variant="primary")

            with gr.Column():
                cad_output = gr.File(
                    label="Download converted .glb file",
                    file_types=[".glb"]
                )
                cad_meta = gr.JSON(label="Viewer metadata")

        cad_btn.click(
            fn=process_cad_file,
            inputs=[cad_input, cad_quality],
            outputs=[cad_output, cad_meta]
        )

    gr.Markdown("""
    ### How to use this API from the Cloudflare Worker:

    ```bash
    curl -X POST https://<your-space>.hf.space/api/convert-office \\
      -F "file=@document.docx;filename=document.docx" \\
      --output document.pdf
    ```

    The original filename **must keep its extension** so LibreOffice can
    detect the input format. Responses are `application/pdf` on success or
    JSON (`{"detail": "..."}`) with a 4xx/5xx status on failure.

    ### 3D conversion:

    ```bash
    curl -X POST https://<your-space>.hf.space/api/convert-3d \\
      -F "file=@part.step;filename=part.step" -F "quality=standard" \\
      --output part.glb -D - | grep -i x-model3d-meta
    ```

    Responses are `model/gltf-binary` with viewer metadata (triangles,
    bounding box, volume) in the `X-Model3D-Meta` header (base64url JSON),
    or JSON (`{\"Detail\": \"...\"}`) with a 4xx/5xx status on failure.
    """)


# Custom API routes (registered above) take precedence over the Gradio mount.
app = gr.mount_gradio_app(api, converter_ui, path="/")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=7860)
