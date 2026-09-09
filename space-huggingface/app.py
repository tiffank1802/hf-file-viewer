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
3. SolidWorks (.sldprt/.sldasm) → .step via a separately installed HOOPS
   Converter binary, followed by an upload into a Hugging Face Storage Bucket.
   This endpoint is disabled until the licensed HOOPS binary, license and
   write-scoped HF token are configured.

Note: FreeCAD cannot read proprietary formats (.sldprt, .dwg, ...). The
SolidWorks pipeline is deliberately isolated from the free FreeCAD pipeline.
"""

import base64
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import gradio as gr
import trimesh
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
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
# SolidWorks → STEP conversion (licensed HOOPS Converter)
# ---------------------------------------------------------------------------

SOLIDWORKS_EXTENSIONS = frozenset({".sldprt", ".sldasm"})
SOLIDWORKS_OUTPUT_PREFIX = "derived/step/"
DEFAULT_HOOPS_CONVERTER_PATH = "/opt/hoops/bin/converter"
DEFAULT_HOOPS_STEP_EXPORT_FORMAT = "2"  # AP242
DEFAULT_HOOPS_TIMEOUT_SECONDS = 600
DEFAULT_SOLIDWORKS_UPLOAD_BYTES = 100 * 1024 * 1024
DEFAULT_SOLIDWORKS_BUNDLE_BYTES = 250 * 1024 * 1024
DEFAULT_HF_BUCKET_ID = "ktongue/ENISE-SITE"
STEP_MAGIC = b"ISO-10303-21;"


class SolidworksNotConfiguredError(RuntimeError):
    """The licensed HOOPS runtime or the bucket writer is not configured."""


def _env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _solidworks_output_path(value: str) -> str:
    """Validate the bucket-relative derived STEP path supplied by the Worker."""
    path = str(value or "").strip().replace("\\", "/")
    if not path.startswith(SOLIDWORKS_OUTPUT_PREFIX):
        raise ValueError("The STEP output path must be under derived/step/.")
    if len(path) > 1500 or "\x00" in path:
        raise ValueError("Invalid STEP output path.")
    parts = path.split("/")
    if any(not part or part in {".", ".."} for part in parts):
        raise ValueError("Invalid STEP output path.")
    if not path.lower().endswith(".step"):
        raise ValueError("The STEP output path must end with .step.")
    return path


def _solidworks_manifest_path(output_path: str) -> str:
    return f"{output_path}.json"


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _redact_secrets(value: str) -> str:
    text = str(value or "")
    for name, replacement in (
        ("HOOPS_LICENSE_KEY", "[redacted-license]"),
        ("HF_TOKEN", "[redacted-hf-token]"),
        ("SOLIDWORKS_CONVERTER_TOKEN", "[redacted-service-token]"),
    ):
        secret = os.getenv(name, "").strip()
        if secret:
            text = text.replace(secret, replacement)
    return text


def _redact_converter_output(value: str) -> str:
    """Keep diagnostics useful without ever echoing a configured secret."""
    return " ".join(_redact_secrets(value).split())[:800]


def _write_hoops_license(workdir: Path):
    """Return a temporary license file path, or the configured file path."""
    configured = os.getenv("HOOPS_LICENSE_FILE", "").strip()
    if configured:
        license_path = Path(configured)
        if not license_path.is_file():
            raise SolidworksNotConfiguredError("HOOPS_LICENSE_FILE does not exist.")
        return license_path, False

    license_value = os.getenv("HOOPS_LICENSE_KEY", "").strip()
    if not license_value:
        raise SolidworksNotConfiguredError(
            "HOOPS license missing. Configure HOOPS_LICENSE_FILE or HOOPS_LICENSE_KEY."
        )

    license_path = workdir / "hoops-license.key"
    license_path.write_text(license_value, encoding="utf-8")
    try:
        license_path.chmod(0o600)
    except OSError:
        pass
    return license_path, True


def _run_hoops_converter(input_path: Path, output_path: Path, workdir: Path) -> None:
    """Run the licensed native converter without shell interpolation."""
    converter_value = os.getenv("HOOPS_CONVERTER_PATH", DEFAULT_HOOPS_CONVERTER_PATH).strip()
    converter = Path(converter_value)
    if not converter.is_file() or not os.access(converter, os.X_OK):
        raise SolidworksNotConfiguredError(
            f"HOOPS Converter introuvable ou non exécutable : {converter}."
        )

    export_format = os.getenv(
        "HOOPS_STEP_EXPORT_FORMAT", DEFAULT_HOOPS_STEP_EXPORT_FORMAT
    ).strip()
    if export_format not in {"0", "1", "2"}:
        raise ValueError("HOOPS_STEP_EXPORT_FORMAT must be 0 (AP203), 1 (AP214) or 2 (AP242).")

    license_path, temporary_license = _write_hoops_license(workdir)
    command = [
        str(converter),
        "--input", str(input_path),
        "--license_file", str(license_path),
        "--output_step", str(output_path),
        "--step_export_format", export_format,
        "--read_geometry", "true",
        "--search_directories", str(workdir),
        "--output_logfile", str(workdir / "hoops-converter.log"),
    ]

    use_xvfb = _env_flag("HOOPS_USE_XVFB", default=True)
    if use_xvfb:
        xvfb = shutil.which("xvfb-run")
        if not xvfb:
            raise SolidworksNotConfiguredError(
                "HOOPS_USE_XVFB est activé mais xvfb-run est introuvable."
            )
        command = [
            xvfb,
            "--auto-servernum",
            "--server-args=-screen 0 640x480x24",
            *command,
        ]

    timeout = int(os.getenv("HOOPS_TIMEOUT_SECONDS", str(DEFAULT_HOOPS_TIMEOUT_SECONDS)))
    if timeout <= 0:
        raise ValueError("HOOPS_TIMEOUT_SECONDS must be positive.")

    try:
        result = subprocess.run(
            command,
            cwd=str(workdir),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError("HOOPS Converter a dépassé le délai de conversion.") from exc
    except OSError as exc:
        raise RuntimeError(f"Impossible de lancer HOOPS Converter : {exc}") from exc
    finally:
        if temporary_license:
            try:
                license_path.unlink(missing_ok=True)
            except OSError:
                pass

    if result.returncode != 0 or not output_path.is_file():
        details = _redact_converter_output(result.stderr or result.stdout)
        raise RuntimeError(
            "HOOPS Converter a échoué."
            + (f" Détail technique : {details}" if details else "")
        )


def _validate_step_bytes(data: bytes) -> None:
    """Reject empty/non-STEP output before publishing it to the bucket."""
    if not data:
        raise RuntimeError("HOOPS Converter a produit un fichier STEP vide.")
    header = data[:512].lstrip(b"\xef\xbb\xbf \t\r\n")
    if not header.startswith(STEP_MAGIC):
        raise RuntimeError("La sortie HOOPS n’est pas un fichier STEP valide.")


def _upload_solidworks_step(output_path: str, step_bytes: bytes, manifest: dict) -> None:
    """Publish the STEP and its provenance manifest to the HF Storage Bucket."""
    bucket_id = os.getenv("HF_BUCKET_ID", DEFAULT_HF_BUCKET_ID).strip()
    token = os.getenv("HF_TOKEN", "").strip()
    if not bucket_id or "/" not in bucket_id:
        raise SolidworksNotConfiguredError("HF_BUCKET_ID est requis pour publier le STEP.")
    if not token:
        raise SolidworksNotConfiguredError(
            "HF_TOKEN avec droit d’écriture est requis pour publier le STEP."
        )

    try:
        from huggingface_hub import HfApi
    except ImportError as exc:
        raise SolidworksNotConfiguredError(
            "huggingface_hub est requis pour écrire dans le bucket."
        ) from exc

    manifest_path = _solidworks_manifest_path(output_path)
    try:
        api = HfApi(token=token)
        api.batch_bucket_files(
            bucket_id,
            add=[
                (step_bytes, output_path),
                (json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), manifest_path),
            ],
        )
    except Exception as exc:
        raise RuntimeError(
            f"Écriture du STEP dans le bucket impossible : {_redact_secrets(exc)}"
        ) from exc


def _normalize_dependency_path(value: str) -> str:
    """Validate a relative assembly reference before writing it to the workspace."""
    path = str(value or "").strip().replace("\\", "/").lstrip("/")
    parts = path.split("/")
    if not path or any(not part or part in {".", ".."} for part in parts):
        raise ValueError("Référence d’assemblage invalide.")
    if Path(path).suffix.lower() not in SOLIDWORKS_EXTENSIONS:
        raise ValueError("Les dépendances d’assemblage doivent être .sldprt ou .sldasm.")
    if len(path) > 1500:
        raise ValueError("Référence d’assemblage trop longue.")
    return path


def convert_solidworks_to_step_and_upload(
    data: bytes,
    extension: str,
    output_path: str,
    source_path: str = "",
    source_sha256: str = "",
    dependencies: list[tuple[str, bytes]] | None = None,
    dependency_manifest: list[dict] | None = None,
):
    """Convert one SolidWorks part/assembly and publish STEP + manifest."""
    extension = str(extension or "").lower()
    if extension not in SOLIDWORKS_EXTENSIONS:
        raise ValueError(f"Format SolidWorks non supporté : {extension or '(inconnu)'}.")
    if not data:
        raise ValueError("Le fichier SolidWorks est vide.")
    max_bytes = int(os.getenv("MAX_SOLIDWORKS_UPLOAD_BYTES", str(DEFAULT_SOLIDWORKS_UPLOAD_BYTES)))
    if max_bytes <= 0 or len(data) > max_bytes:
        raise ValueError(
            f"Le fichier SolidWorks dépasse la limite de {max_bytes // 1024 // 1024} Mo."
        )
    max_dependency_files = int(
        os.getenv("MAX_SOLIDWORKS_DEPENDENCY_FILES", "64")
    )
    max_bundle_bytes = int(
        os.getenv("MAX_SOLIDWORKS_BUNDLE_BYTES", str(DEFAULT_SOLIDWORKS_BUNDLE_BYTES))
    )
    if max_dependency_files <= 0 or max_bundle_bytes <= 0:
        raise ValueError("Les limites des dépendances SolidWorks doivent être positives.")

    normalized_output = _solidworks_output_path(output_path)
    actual_source_sha256 = _sha256_bytes(data)
    if source_sha256 and source_sha256 != actual_source_sha256:
        raise ValueError("L’empreinte du fichier SolidWorks ne correspond pas au contenu reçu.")

    source_name = Path(source_path or f"source{extension}").name
    if Path(source_name).suffix.lower() != extension:
        source_name = f"source{extension}"

    dependency_entries = []
    dependency_records = []
    total_input_bytes = len(data)
    for dependency in dependencies or []:
        try:
            relative_path, dependency_data = dependency
        except (TypeError, ValueError) as exc:
            raise ValueError("Format de dépendance d’assemblage invalide.") from exc
        relative_path = _normalize_dependency_path(relative_path)
        if relative_path == source_name or any(
            item[0] == relative_path for item in dependency_entries
        ):
            raise ValueError("Une dépendance d’assemblage est dupliquée.")
        if not isinstance(dependency_data, bytes):
            dependency_data = bytes(dependency_data)
        if not dependency_data or len(dependency_data) > max_bytes:
            raise ValueError("Une dépendance SolidWorks est vide ou trop volumineuse.")
        if len(dependency_entries) >= max_dependency_files:
            raise ValueError(
                f"Trop de dépendances SolidWorks (limite {max_dependency_files})."
            )
        total_input_bytes += len(dependency_data)
        if total_input_bytes > max_bundle_bytes:
            raise ValueError(
                f"Les fichiers de l’assemblage dépassent la limite de {max_bundle_bytes // 1024 // 1024} Mo."
            )
        dependency_entries.append((relative_path, dependency_data))
        dependency_records.append({
            "path": relative_path,
            "sha256": _sha256_bytes(dependency_data),
            "size": len(dependency_data),
        })

    if dependency_manifest is not None:
        expected_records = [
            {
                "path": _normalize_dependency_path(item.get("path", "")),
                "sha256": str(item.get("sha256", "")).lower(),
            }
            for item in dependency_manifest
            if isinstance(item, dict)
        ]
        actual_signature = [
            {"path": item["path"], "sha256": item["sha256"]}
            for item in dependency_records
        ]
        if expected_records != actual_signature:
            raise ValueError("L’empreinte des dépendances SolidWorks ne correspond pas au contenu reçu.")

    with tempfile.TemporaryDirectory(prefix="solidworks-step-") as tmp:
        workdir = Path(tmp)
        input_path = workdir / source_name
        output_file = workdir / "converted.step"
        input_path.write_bytes(data)
        for relative_path, dependency_data in dependency_entries:
            dependency_path = workdir / relative_path
            dependency_path.parent.mkdir(parents=True, exist_ok=True)
            dependency_path.write_bytes(dependency_data)
        _run_hoops_converter(input_path, output_file, workdir)
        step_bytes = output_file.read_bytes()

    _validate_step_bytes(step_bytes)
    step_sha256 = _sha256_bytes(step_bytes)
    export_format = os.getenv(
        "HOOPS_STEP_EXPORT_FORMAT", DEFAULT_HOOPS_STEP_EXPORT_FORMAT
    ).strip()
    manifest = {
        "kind": "solidworks-step",
        "sourcePath": source_path or None,
        "sourceSha256": actual_source_sha256,
        "sourceFormat": extension.lstrip("."),
        "dependencies": dependency_records,
        "stepPath": normalized_output,
        "stepSha256": step_sha256,
        "size": len(step_bytes),
        "stepExportFormat": {"0": "AP203", "1": "AP214", "2": "AP242"}.get(export_format, export_format),
        "converter": "HOOPS Converter",
        "converterVersion": os.getenv("HOOPS_CONVERTER_VERSION", "configured-runtime"),
    }
    _upload_solidworks_step(normalized_output, step_bytes, manifest)
    return {
        "status": "success",
        "stepPath": normalized_output,
        "manifestPath": _solidworks_manifest_path(normalized_output),
        "sourceSha256": actual_source_sha256,
        "dependencies": dependency_records,
        "stepSha256": step_sha256,
        "size": len(step_bytes),
        "stepExportFormat": manifest["stepExportFormat"],
    }


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
    return {
        "ok": True,
        "service": "enise-convert",
        "solidworks": {
            "converterConfigured": bool(
                Path(os.getenv("HOOPS_CONVERTER_PATH", DEFAULT_HOOPS_CONVERTER_PATH)).is_file()
            ),
            "bucketConfigured": bool(
                os.getenv("HF_BUCKET_ID", DEFAULT_HF_BUCKET_ID).strip()
                and os.getenv("HF_TOKEN", "").strip()
            ),
        },
    }


def _solidworks_request_is_authorized(authorization: str | None) -> bool:
    expected = os.getenv("SOLIDWORKS_CONVERTER_TOKEN", "").strip()
    if not expected:
        # Local development can run without an internal token. Production
        # should always set it when the endpoint is exposed publicly.
        return True
    provided = str(authorization or "")
    scheme, separator, token = provided.partition(" ")
    return (
        scheme.lower() == "bearer"
        and bool(separator)
        and hmac.compare_digest(token.strip(), expected)
    )


@api.post("/api/convert-solidworks-step")
async def convert_solidworks_step_endpoint(
    file: UploadFile = File(...),
    output_path: str = Form(...),
    source_path: str = Form(""),
    source_sha256: str = Form(""),
    dependency_manifest: str = Form(""),
    dependencies: list[UploadFile] | None = File(default=None),
    authorization: str | None = Header(default=None),
):
    """Convert one SolidWorks file with HOOPS and publish STEP + manifest."""
    if not _solidworks_request_is_authorized(authorization):
        raise HTTPException(status_code=401, detail="Service de conversion non autorisé.")

    extension = Path(file.filename or "").suffix.lower()
    if extension not in SOLIDWORKS_EXTENSIONS:
        raise HTTPException(
            status_code=422,
            detail=f"Format {extension or '(inconnu)'} non supporté. Attendu : .sldprt ou .sldasm.",
        )

    data = await file.read()
    max_bytes = int(os.getenv("MAX_SOLIDWORKS_UPLOAD_BYTES", str(DEFAULT_SOLIDWORKS_UPLOAD_BYTES)))
    if len(data) > max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Fichier SolidWorks trop volumineux (limite {max_bytes // 1024 // 1024} Mo).",
        )
    if not data:
        raise HTTPException(status_code=422, detail="Le fichier SolidWorks est vide.")

    dependency_files = dependencies or []
    manifest_items = []
    manifest_supplied = bool(str(dependency_manifest or "").strip())
    if manifest_supplied:
        try:
            manifest_items = json.loads(dependency_manifest)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=422, detail="Manifest de dépendances invalide.") from exc
        if not isinstance(manifest_items, list) or len(manifest_items) != len(dependency_files):
            raise HTTPException(status_code=422, detail="Le manifest des dépendances ne correspond pas aux fichiers reçus.")
        if any(not isinstance(item, dict) for item in manifest_items):
            raise HTTPException(status_code=422, detail="Manifest de dépendances invalide.")

    dependency_data = []
    for index, dependency_file in enumerate(dependency_files):
        relative_path = (
            manifest_items[index].get("path")
            if manifest_supplied
            else dependency_file.filename
        )
        content = await dependency_file.read()
        dependency_data.append((relative_path, content))

    try:
        return convert_solidworks_to_step_and_upload(
            data,
            extension,
            output_path,
            source_path=source_path,
            source_sha256=source_sha256,
            dependencies=dependency_data,
            dependency_manifest=manifest_items if manifest_supplied else None,
        )
    except SolidworksNotConfiguredError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)[:500]) from exc


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
