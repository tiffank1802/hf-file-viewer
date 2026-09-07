"""
ENISE conversion Space.

Pipelines:
1. SolidWorks .sldprt → .glb (FreeCAD + trimesh), exposed as a Gradio UI.
2. Office documents (.doc/.docx/.xls/.xlsx/.ppt/.pptx/.odt/...) → .pdf
   (headless LibreOffice), exposed as a plain HTTP API for the Cloudflare
   Worker (`POST /api/convert-office`) and as a second Gradio tab.

Note: The .sldprt import module in FreeCAD is experimental.
Test with geometrically simple parts first before validating on complex parts.
"""

import shutil
import subprocess
import tempfile
from pathlib import Path

import gradio as gr
import trimesh
from fastapi import FastAPI, File, HTTPException, UploadFile
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
    """)


# Custom API routes (registered above) take precedence over the Gradio mount.
app = gr.mount_gradio_app(api, converter_ui, path="/")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=7860)
