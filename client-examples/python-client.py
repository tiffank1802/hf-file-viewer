"""
Client example for calling the ENISE Converters Space (REST API).

This Python example shows how to call the Hugging Face Space from your
backend server with the standard library only (no extra dependency).
The Space is public: no HF token needed. Never expose HF_TOKEN client-side.

Supported 3D inputs: .step, .stp, .iges, .igs, .stl, .obj.
Note: FreeCAD cannot read .sldprt — export SolidWorks parts as STEP first.
"""

import base64
import json
import os
import urllib.request

CONVERTIBLE_3D = (".step", ".stp", ".iges", ".igs", ".stl", ".obj")


def convert_cad_to_glb(cad_file_path, space_runtime_url, quality="standard", timeout=600):
    """
    Convert a CAD file to GLB via POST /api/convert-3d.

    Args:
        cad_file_path: Path to the CAD file on your server.
        space_runtime_url: Space runtime URL (e.g. "https://user-space.hf.space").
        quality: One of "draft", "standard", "fine" (tessellation density).
        timeout: Request timeout in seconds (cold start can take a minute).

    Returns:
        Tuple (glb_bytes, meta dict from the X-Model3D-Meta header).

    Raises:
        ValueError: invalid file format or rejected conversion (4xx).
        TimeoutError: conversion took too long.
        ConnectionError: Space unavailable.
    """
    extension = os.path.splitext(cad_file_path)[1].lower()
    if extension not in CONVERTIBLE_3D:
        raise ValueError(f"Invalid file format: {extension or '(none)'}")

    boundary = "----hfspaceboundary7MA4YWxkTrZu0gW"
    with open(cad_file_path, "rb") as handle:
        file_bytes = handle.read()
    filename = os.path.basename(cad_file_path)
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode() + file_bytes + (
        f"\r\n--{boundary}\r\n"
        'Content-Disposition: form-data; name="quality"\r\n\r\n'
        f"{quality}\r\n--{boundary}--\r\n"
    ).encode()

    request = urllib.request.Request(
        f"{space_runtime_url}/api/convert-3d",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            glb_bytes = response.read()
            meta_header = response.headers.get("X-Model3D-Meta", "")
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode())["detail"]
        except Exception:
            detail = f"HTTP {exc.code}"
        raise ValueError(f"Conversion rejected: {detail}") from exc
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, TimeoutError):
            raise TimeoutError("Conversion timed out.") from exc
        raise ConnectionError(f"Space unavailable: {exc.reason}") from exc

    meta = json.loads(base64.urlsafe_b64decode(meta_header + "==")) if meta_header else {}
    print(f"Converted {filename} -> GLB ({len(glb_bytes)} bytes, {meta.get('triangles')} triangles)")
    return glb_bytes, meta


# Flask endpoint example
def create_flask_endpoint():
    """
    Example Flask endpoint for converting files.

    Usage in your Flask app:
        from convert_client import create_flask_endpoint
        app.add_url_rule('/api/convert-3d', 'convert_3d',
                         create_flask_endpoint(), methods=['POST'])
    """
    from flask import request, send_file

    import io
    import tempfile

    def convert_endpoint():
        from flask import jsonify

        if "file" not in request.files:
            return jsonify({"status": "error", "message": "No file uploaded"}), 400

        file = request.files["file"]
        extension = os.path.splitext(file.filename or "")[1].lower()
        if extension not in CONVERTIBLE_3D:
            return jsonify({"status": "error", "message": f"Invalid file format: {extension}"}), 400

        temp_dir = tempfile.mkdtemp()
        temp_path = os.path.join(temp_dir, os.path.basename(file.filename))
        file.save(temp_path)

        space_runtime_url = os.environ.get("SPACE_RUNTIME_URL", "https://user-space.hf.space")
        try:
            glb_bytes, meta = convert_cad_to_glb(temp_path, space_runtime_url)
        except ValueError as exc:
            return jsonify({"status": "error", "message": str(exc)}), 422
        except (TimeoutError, ConnectionError) as exc:
            return jsonify({"status": "error", "message": str(exc)}), 503

        return send_file(
            io.BytesIO(glb_bytes),
            mimetype="model/gltf-binary",
            as_attachment=False,
            download_name=f"{os.path.splitext(file.filename)[0]}.glb",
        )

    return convert_endpoint


if __name__ == "__main__":
    # Example usage
    SPACE_RUNTIME_URL = os.environ.get("SPACE_RUNTIME_URL", "https://user-space.hf.space")

    try:
        glb_bytes, _meta = convert_cad_to_glb("./example-part.step", SPACE_RUNTIME_URL)
        with open("example-part.glb", "wb") as handle:
            handle.write(glb_bytes)
        print("Converted file available at: example-part.glb")
    except Exception as exc:
        print(f"Error: {exc}")
