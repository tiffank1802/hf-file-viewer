"""
ENISE conversion Space.

Pipelines:
1. SolidWorks .sldprt → .glb (FreeCAD + trimesh), exposed as a Gradio UI.
2. Office documents (.doc/.docx/.xls/.xlsx/.ppt/.pptx/.odt/...) → .pdf
   (headless LibreOffice), exposed as a plain HTTP API for the Cloudflare
   Worker (`POST /api/convert-office`) and as a second Gradio tab.
3. CAD (.step/.stp/.iges/.igs/.stl/.obj/.sldprt) → .glb (FreeCAD + trimesh),
   exposed as a plain HTTP API (`POST /api/convert-3d`, quality levels) and
   as a third Gradio tab. This is the 3Dfindit-style mesh pipeline feeding
   the website WebGL viewer.

Note: The .sldprt import module in FreeCAD is experimental.
Test with geometrically simple parts first before validating on complex parts.
"""

import base64
import json
import shutil
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
    ".step", ".stp", ".iges", ".igs", ".stl", ".obj", ".sldprt",
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


def friendly_cad_error(extension: str, raw_details: str = "") -> str:
    """
    Map a FreeCAD failure to a short user-facing message (French site).

    The raw freecadcmd output (tracebacks, log noise) is kept as a truncated
    single-line suffix for debuggability; the actionable guidance comes first.
    """
    raw = " ".join((raw_details or "").split())
    suffix = f" Détail technique : {raw[:200]}" if raw else ""
    if extension == ".sldprt":
        return (
            "FreeCAD n’a pas pu lire ce fichier SolidWorks (format propriétaire, "
            "support expérimental). Exportez la pièce en STEP depuis SolidWorks, "
            "ou ouvrez-la avec l’onglet Autodesk." + suffix
        )
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
                details = (result.stderr or result.stdout or "").strip()
                raise RuntimeError(friendly_cad_error(extension, details))
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
# SolidWorks .sldprt → .glb conversion (FreeCAD + trimesh)
# ---------------------------------------------------------------------------


def convert_sldprt_to_glb(sldprt_file_path):
    """
    Convert a .sldprt file to .glb format.

    Args:
        sldprt_file_path: Path to the uploaded .sldprt file

    Returns:
        tuple: (success: bool, result_path_or_error_message: str)
    """
    # Create temporary directory for conversion
    temp_dir = tempfile.mkdtemp()

    try:
        # Define paths
        input_sldprt = Path(sldprt_file_path)
        output_stl = Path(temp_dir) / "output.stl"
        output_glb = Path(temp_dir) / "output.glb"

        # Step 1: Convert .sldprt to .stl using FreeCAD
        freecad_script = Path(__file__).parent / "freecad_convert.py"

        if not freecad_script.exists():
            return False, "FreeCAD conversion script not found."

        # Run freecadcmd in headless mode
        cmd = [
            "freecadcmd",
            "--console",
            str(freecad_script),
            str(input_sldprt),
            str(output_stl)
        ]

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=120  # 2 minute timeout for complex parts
            )

            if result.returncode != 0:
                error_msg = result.stderr.strip() or result.stdout.strip()
                return False, f"FreeCAD conversion failed: {error_msg}"

            # Verify STL was created
            if not output_stl.exists():
                return False, "STL file was not created by FreeCAD."

        except subprocess.TimeoutExpired:
            return False, "FreeCAD conversion timed out. The part may be too complex."
        except FileNotFoundError:
            return False, "freecadcmd not found. FreeCAD may not be properly installed."

        # Step 2: Convert .stl to .glb using trimesh
        try:
            # Load the STL mesh
            mesh = trimesh.load(str(output_stl))

            # Handle Scene objects (multiple meshes)
            if isinstance(mesh, trimesh.Scene):
                # Apply scaling to all geometries in the scene
                for geom in mesh.geometry.values():
                    # Scale from mm to meters (SolidWorks uses mm, glTF expects meters)
                    geom.apply_scale(0.001)
            else:
                # Single mesh - apply scaling directly
                mesh.apply_scale(0.001)

            # Export to GLB
            mesh.export(str(output_glb), file_type='glb')

            # Verify GLB was created
            if not output_glb.exists():
                return False, "GLB file was not created."

            # Move GLB to a permanent location (Gradio will handle cleanup)
            final_glb_path = Path(tempfile.gettempdir()) / f"{Path(sldprt_file_path).stem}.glb"
            final_glb_path.write_bytes(output_glb.read_bytes())

            return True, str(final_glb_path)

        except Exception as e:
            return False, f"STL to GLB conversion failed: {str(e)}"

    except Exception as e:
        return False, f"Conversion pipeline error: {str(e)}"

    finally:
        # Cleanup temporary directory
        try:
            shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception:
            pass


def process_file(input_file):
    """
    Gradio interface function to process uploaded file.

    Args:
        input_file: Path to uploaded .sldprt file

    Returns:
        Path to converted .glb file or raises gr.Error
    """
    if input_file is None:
        raise gr.Error("No file uploaded. Please upload a .sldprt file.")

    # Validate file extension
    file_ext = Path(input_file).suffix.lower()
    if file_ext != '.sldprt':
        raise gr.Error(f"Invalid file format. Expected .sldprt, got {file_ext}")

    # Perform conversion
    success, result = convert_sldprt_to_glb(input_file)

    if not success:
        raise gr.Error(result)

    return result


def process_cad_file(input_file, quality="standard"):
    """Gradio interface function: CAD document → GLB + metadata (manual testing)."""
    if input_file is None:
        raise gr.Error("No file uploaded. Please upload a CAD document.")

    file_ext = Path(input_file).suffix.lower()
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

    - **SolidWorks (.sldprt) → GLB** : visualisation web des pièces.
    - **Office → PDF** : conversion fidèle des documents Word/Excel/PowerPoint
      et OpenDocument (utilisée par le site via `POST /api/convert-office`).
    - **CAD → GLB** : STEP/IGES/STL/OBJ/SolidWorks vers maillage web
      (utilisée par le site via `POST /api/convert-3d`).
    """)

    with gr.Tab("SolidWorks (.sldprt) to GLB"):
        gr.Markdown("""
        Upload a SolidWorks part file (.sldprt) to convert it to GLB format for web visualization.

        **Important Notes:**
        - The .sldprt import module in FreeCAD is **experimental**
        - Test with geometrically simple parts first
        - Complex surfaces or recent SolidWorks features may not be supported
        - Only geometry (tessellated mesh) is preserved - no parametric history, colors, or materials
        - Conversion may take 30-60 seconds for the first request (cold start)
        """)

        with gr.Row():
            with gr.Column():
                sldprt_input = gr.File(
                    label="Upload .sldprt file",
                    file_types=[".sldprt"],
                    type="filepath"
                )
                sldprt_btn = gr.Button("Convert to GLB", variant="primary")

            with gr.Column():
                sldprt_output = gr.File(
                    label="Download converted .glb file",
                    file_types=[".glb"]
                )

        sldprt_btn.click(
            fn=process_file,
            inputs=sldprt_input,
            outputs=sldprt_output
        )

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
        Upload a CAD or mesh file (STEP, IGES, STL, OBJ, simple SolidWorks
        parts) to convert it to GLB with FreeCAD + trimesh. Same engine as the
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
