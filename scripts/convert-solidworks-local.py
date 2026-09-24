#!/usr/bin/env python3
"""Convert SolidWorks files locally with HOOPS Converter and upload STEP files.

The script deliberately keeps credentials out of command-line arguments. Set
HF_TOKEN, HOOPS_CONVERTER_PATH and either HOOPS_LICENSE_FILE or
HOOPS_LICENSE_KEY in the local environment. Nothing from those variables is
printed.

Examples:
    # Preview conversion only, preserving local folder structure:
    python3 scripts/convert-solidworks-local.py \
        --root ./bucket-export --output-mode original

    # Convert and upload beside the matching source paths in the HF bucket:
    export HF_TOKEN=...
    export HOOPS_CONVERTER_PATH=/opt/hoops/bin/converter
    export HOOPS_LICENSE_FILE="$HOME/.config/hoops/license.key"
    python3 scripts/convert-solidworks-local.py \
        --root ./bucket-export \
        --bucket-id ktongue/ENISE-SITE \
        --output-mode original \
        --upload

By default, a local copy is written below ./converted-step while the bucket
path stays equal to the source path with .step replacing .sldprt/.sldasm.
Use --output-mode derived to match the website Worker convention:
derived/step/<source-directory>/<stem>.step.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


SOLIDWORKS_EXTENSIONS = frozenset({".sldprt", ".sldasm"})
STEP_MAGIC = b"ISO-10303-21;"
DEFAULT_BUCKET_ID = "ktongue/ENISE-SITE"
DEFAULT_CONVERTER_PATH = "/opt/hoops/bin/converter"
DEFAULT_STEP_EXPORT_FORMAT = "2"  # AP242
DEFAULT_TIMEOUT_SECONDS = 600
DEFAULT_MAX_DEPENDENCY_FILES = 64
DEFAULT_MAX_BUNDLE_BYTES = 250 * 1024 * 1024
DEFAULT_LOCAL_OUTPUT_DIR = "converted-step"


class ConversionError(RuntimeError):
    """A local conversion failed in a user-actionable way."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def redact(value: object) -> str:
    """Avoid exposing license/token values in a subprocess error message."""
    text = str(value or "")
    for variable, replacement in (
        ("HOOPS_LICENSE_KEY", "[redacted-license]"),
        ("HF_TOKEN", "[redacted-hf-token]"),
        ("SOLIDWORKS_CONVERTER_TOKEN", "[redacted-service-token]"),
    ):
        secret = os.getenv(variable, "").strip()
        if secret:
            text = text.replace(secret, replacement)
    return " ".join(text.split())[:1000]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Conversion locale SolidWorks (.sldprt/.sldasm) → STEP + upload HF Bucket."
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path, help="Un fichier SolidWorks local.")
    source.add_argument("--root", type=Path, help="Dossier à parcourir récursivement.")
    parser.add_argument(
        "--source-root",
        type=Path,
        help="Racine relative à utiliser avec --input pour les dépendances et les chemins bucket.",
    )
    parser.add_argument(
        "--bucket-id",
        default=os.getenv("HF_BUCKET_ID", DEFAULT_BUCKET_ID),
        help=f"Bucket Hugging Face cible (défaut: {DEFAULT_BUCKET_ID}).",
    )
    parser.add_argument(
        "--bucket-prefix",
        default=os.getenv("HF_BUCKET_PREFIX", ""),
        help="Préfixe ajouté aux chemins locaux dans le bucket, par exemple GM.",
    )
    parser.add_argument(
        "--output-mode",
        choices=("original", "derived"),
        default="original",
        help="original = à côté du source ; derived = derived/step/... (défaut: original).",
    )
    parser.add_argument(
        "--local-output-dir",
        type=Path,
        default=Path(DEFAULT_LOCAL_OUTPUT_DIR),
        help=f"Dossier de copies STEP locales (défaut: ./{DEFAULT_LOCAL_OUTPUT_DIR}).",
    )
    parser.add_argument(
        "--converter",
        default=os.getenv("HOOPS_CONVERTER_PATH", DEFAULT_CONVERTER_PATH),
        help="Chemin du binaire HOOPS (défaut: HOOPS_CONVERTER_PATH).",
    )
    parser.add_argument(
        "--license-file",
        type=Path,
        default=Path(os.getenv("HOOPS_LICENSE_FILE", "")) if os.getenv("HOOPS_LICENSE_FILE") else None,
        help="Fichier licence HOOPS (défaut: HOOPS_LICENSE_FILE).",
    )
    parser.add_argument(
        "--step-export-format",
        choices=("0", "1", "2"),
        default=os.getenv("HOOPS_STEP_EXPORT_FORMAT", DEFAULT_STEP_EXPORT_FORMAT),
        help="0=AP203, 1=AP214, 2=AP242 (défaut: 2).",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=int(os.getenv("HOOPS_TIMEOUT_SECONDS", str(DEFAULT_TIMEOUT_SECONDS))),
        help="Délai maximum par fichier en secondes.",
    )
    parser.add_argument(
        "--max-dependency-files",
        type=int,
        default=int(os.getenv("MAX_SOLIDWORKS_DEPENDENCY_FILES", str(DEFAULT_MAX_DEPENDENCY_FILES))),
        help="Nombre maximum de dépendances par assemblage.",
    )
    parser.add_argument(
        "--max-bundle-bytes",
        type=int,
        default=int(os.getenv("MAX_SOLIDWORKS_BUNDLE_BYTES", str(DEFAULT_MAX_BUNDLE_BYTES))),
        help="Taille maximum source + dépendances par assemblage.",
    )
    parser.add_argument(
        "--upload",
        action="store_true",
        help="Téléverser les STEP et manifests dans le bucket.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Remplacer les copies locales et préparer l’upload même si elles existent.",
    )
    parser.add_argument(
        "--no-xvfb",
        action="store_true",
        help="Ne pas lancer HOOPS via xvfb-run.",
    )
    parser.add_argument(
        "--continue-on-error",
        action="store_true",
        help="Continuer les autres fichiers après une erreur.",
    )
    return parser.parse_args()


def resolve_source_paths(args: argparse.Namespace) -> tuple[Path, Path, list[Path]]:
    if args.input is not None:
        source = args.input.expanduser().resolve()
        if not source.is_file():
            raise ConversionError(f"Fichier introuvable : {source}")
        if source.suffix.lower() not in SOLIDWORKS_EXTENSIONS:
            raise ConversionError("--input doit être un fichier .sldprt ou .sldasm.")
        root = (args.source_root or source.parent).expanduser().resolve()
        if not root.is_dir():
            raise ConversionError(f"Racine introuvable : {root}")
        try:
            source.relative_to(root)
        except ValueError as exc:
            raise ConversionError("Le fichier --input doit se trouver sous --source-root.") from exc
        return root, source, [source]

    root = args.root.expanduser().resolve()
    if not root.is_dir():
        raise ConversionError(f"Dossier introuvable : {root}")
    files = sorted(
        path
        for path in root.rglob("*")
        if path.is_file()
        and path.suffix.lower() in SOLIDWORKS_EXTENSIONS
        and "derived" not in path.relative_to(root).parts
        and ".git" not in path.relative_to(root).parts
    )
    if not files:
        raise ConversionError(f"Aucun .sldprt/.sldasm trouvé dans {root}")
    return root, files[0], files


def relative_posix(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def bucket_source_path(path: Path, root: Path, bucket_prefix: str) -> str:
    relative = relative_posix(path, root)
    prefix = str(bucket_prefix or "").strip().strip("/")
    return "/".join(part for part in (prefix, relative) if part)


def step_output_path(source_bucket_path: str, mode: str) -> str:
    source = Path(source_bucket_path)
    step_name = f"{source.stem}.step"
    if mode == "original":
        output = source.with_name(step_name)
    else:
        output = Path("derived") / "step" / source.parent / step_name
    return output.as_posix()


def collect_dependencies(
    source: Path,
    root: Path,
    max_files: int,
    max_bundle_bytes: int,
) -> list[tuple[Path, str]]:
    """Return CAD files below the assembly folder with paths relative to it."""
    if source.suffix.lower() != ".sldasm":
        return []
    candidates = sorted(
        path
        for path in source.parent.rglob("*")
        if path.is_file()
        and path != source
        and path.suffix.lower() in SOLIDWORKS_EXTENSIONS
        and ".git" not in path.relative_to(root).parts
    )
    if len(candidates) > max_files:
        raise ConversionError(
            f"{source.name} référence {len(candidates)} fichiers SolidWorks ; limite {max_files}."
        )
    total = source.stat().st_size
    result: list[tuple[Path, str]] = []
    for candidate in candidates:
        total += candidate.stat().st_size
        if total > max_bundle_bytes:
            raise ConversionError(
                f"Le paquet de {source.name} dépasse {max_bundle_bytes / 1024 / 1024:.0f} Mo."
            )
        result.append((candidate, candidate.relative_to(source.parent).as_posix()))
    return result


def ensure_step_signature(step_bytes: bytes) -> None:
    header = step_bytes[:512].lstrip(b"\xef\xbb\xbf \t\r\n")
    if not header.startswith(STEP_MAGIC):
        raise ConversionError("HOOPS n’a pas produit un fichier STEP valide (ISO-10303-21; absent).")


def run_hoops(
    source: Path,
    root: Path,
    dependencies: list[tuple[Path, str]],
    converter: Path,
    license_file: Path | None,
    license_key: str,
    step_export_format: str,
    timeout: int,
    use_xvfb: bool,
) -> bytes:
    if not converter.is_file() or not os.access(converter, os.X_OK):
        raise ConversionError(f"Binaire HOOPS introuvable ou non exécutable : {converter}")
    if license_file is None and not license_key:
        raise ConversionError("Définis HOOPS_LICENSE_FILE ou HOOPS_LICENSE_KEY dans l’environnement.")
    if license_file is not None and not license_file.is_file():
        raise ConversionError(f"Fichier licence introuvable : {license_file}")
    if step_export_format not in {"0", "1", "2"}:
        raise ConversionError("HOOPS_STEP_EXPORT_FORMAT doit être 0, 1 ou 2.")
    if timeout <= 0:
        raise ConversionError("Le délai HOOPS doit être positif.")

    with tempfile.TemporaryDirectory(prefix="solidworks-local-") as temporary:
        workdir = Path(temporary)
        source_relative = source.relative_to(root)
        input_path = workdir / source_relative
        input_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, input_path)
        for dependency, relative_path in dependencies:
            dependency_target = workdir / source.relative_to(root).parent / relative_path
            dependency_target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dependency, dependency_target)

        temporary_license: Path | None = None
        if license_file is not None:
            license_argument = license_file
        else:
            temporary_license = workdir / "hoops-license.key"
            temporary_license.write_text(license_key, encoding="utf-8")
            try:
                temporary_license.chmod(0o600)
            except OSError:
                pass
            license_argument = temporary_license

        output_path = workdir / "converted.step"
        command = [
            str(converter),
            "--input", str(input_path),
            "--license_file", str(license_argument),
            "--output_step", str(output_path),
            "--step_export_format", step_export_format,
            "--read_geometry", "true",
            "--search_directories", str(workdir),
            "--output_logfile", str(workdir / "hoops-converter.log"),
        ]
        if use_xvfb:
            xvfb = shutil.which("xvfb-run")
            if not xvfb:
                raise ConversionError("xvfb-run est introuvable ; utilise --no-xvfb si HOOPS n’en a pas besoin.")
            command = [xvfb, "--auto-servernum", "--server-args=-screen 0 640x480x24", *command]

        try:
            result = subprocess.run(
                command,
                cwd=workdir,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise ConversionError(f"Timeout HOOPS après {timeout} secondes pour {source.name}.") from exc
        except OSError as exc:
            raise ConversionError(f"Impossible de lancer HOOPS : {redact(exc)}") from exc
        finally:
            if temporary_license is not None:
                temporary_license.unlink(missing_ok=True)

        if result.returncode != 0 or not output_path.is_file():
            details = redact(result.stderr or result.stdout)
            raise ConversionError(
                f"HOOPS a échoué pour {source.name} (code {result.returncode})."
                + (f" Détail : {details}" if details else "")
            )
        step_bytes = output_path.read_bytes()
        ensure_step_signature(step_bytes)
        return step_bytes


def local_output_path(local_output_dir: Path, source: Path, root: Path) -> Path:
    return local_output_dir / source.relative_to(root).with_suffix(".step")


def dependency_records(dependencies: list[tuple[Path, str]]) -> list[dict]:
    return [
        {
            "path": relative_path,
            "sourcePath": relative_path,
            "sha256": sha256_file(dependency),
            "size": dependency.stat().st_size,
        }
        for dependency, relative_path in dependencies
    ]


def local_cache_matches(
    manifest_path: Path,
    output_path: Path,
    source_sha: str,
    output_bucket_path: str,
    dependencies: list[dict],
    step_export_format: str,
) -> bool:
    if not output_path.is_file() or not manifest_path.is_file():
        return False
    try:
        recorded = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    expected_format = {"0": "AP203", "1": "AP214", "2": "AP242"}[step_export_format]
    recorded_dependencies = [
        {
            "path": item.get("path"),
            "sha256": item.get("sha256"),
            "size": item.get("size"),
        }
        for item in recorded.get("dependencies", [])
        if isinstance(item, dict)
    ]
    return (
        recorded.get("sourceSha256") == source_sha
        and recorded.get("stepPath") == output_bucket_path
        and recorded.get("stepExportFormat") == expected_format
        and recorded_dependencies == [
            {"path": item["path"], "sha256": item["sha256"], "size": item["size"]}
            for item in dependencies
        ]
    )


def manifest_for(
    source: Path,
    source_bucket_path: str,
    output_bucket_path: str,
    source_sha: str,
    dependencies: list[tuple[Path, str]],
    step_bytes: bytes,
    step_export_format: str,
) -> dict:
    return {
        "kind": "solidworks-step-local",
        "sourcePath": source_bucket_path,
        "sourceSha256": source_sha,
        "sourceFormat": source.suffix.lower().lstrip("."),
        "dependencies": dependency_records(dependencies),
        "stepPath": output_bucket_path,
        "stepSha256": sha256_bytes(step_bytes),
        "size": len(step_bytes),
        "stepExportFormat": {"0": "AP203", "1": "AP214", "2": "AP242"}[step_export_format],
        "converter": "HOOPS Converter (local)",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }


def upload_additions(bucket_id: str, token: str, additions: list[tuple[bytes, str]]) -> None:
    try:
        from huggingface_hub import HfApi
    except ImportError as exc:
        raise ConversionError(
            "huggingface_hub manque. Installe-le avec : python3 -m pip install 'huggingface_hub>=1.0.0'"
        ) from exc
    if not token:
        raise ConversionError("HF_TOKEN est requis avec --upload.")
    api = HfApi(token=token)
    try:
        api.batch_bucket_files(bucket_id, add=additions)
    except Exception as exc:
        raise ConversionError(f"Upload Hugging Face impossible : {redact(exc)}") from exc


def main() -> int:
    args = parse_args()
    try:
        root, _, sources = resolve_source_paths(args)
        converter = Path(args.converter).expanduser().resolve()
        license_file = args.license_file.expanduser().resolve() if args.license_file else None
        license_key = os.getenv("HOOPS_LICENSE_KEY", "")
        local_output_dir = args.local_output_dir.expanduser().resolve()
        if args.force or not local_output_dir.exists():
            local_output_dir.mkdir(parents=True, exist_ok=True)
        elif not local_output_dir.is_dir():
            raise ConversionError(f"Le dossier de sortie locale n’est pas un dossier : {local_output_dir}")
        if args.max_dependency_files <= 0 or args.max_bundle_bytes <= 0:
            raise ConversionError("Les limites de dépendances doivent être positives.")

        prepared_uploads: list[tuple[bytes, str]] = []
        failures = 0
        print(f"Racine locale : {root}")
        print(f"Fichiers SolidWorks : {len(sources)}")
        print(f"Mode bucket : {args.output_mode} ; bucket : {args.bucket_id}")

        for index, source in enumerate(sources, start=1):
            source_bucket_path = bucket_source_path(source, root, args.bucket_prefix)
            output_bucket_path = step_output_path(source_bucket_path, args.output_mode)
            output_local_path = local_output_path(local_output_dir, source, root)
            try:
                dependencies = collect_dependencies(
                    source,
                    root,
                    args.max_dependency_files,
                    args.max_bundle_bytes,
                )
                source_sha = sha256_file(source)
                dependency_manifest = dependency_records(dependencies)
                local_manifest_path = Path(f"{output_local_path}.json")
                if local_cache_matches(
                    local_manifest_path,
                    output_local_path,
                    source_sha,
                    output_bucket_path,
                    dependency_manifest,
                    args.step_export_format,
                ) and not args.force:
                    print(f"[{index}/{len(sources)}] Réutilisation locale : {output_local_path}")
                    step_bytes = output_local_path.read_bytes()
                    ensure_step_signature(step_bytes)
                    manifest = json.loads(local_manifest_path.read_text(encoding="utf-8"))
                else:
                    print(
                        f"[{index}/{len(sources)}] Conversion : {source.relative_to(root)}"
                        f" → {output_bucket_path} ({len(dependencies)} dépendance(s))"
                    )
                    step_bytes = run_hoops(
                        source,
                        root,
                        dependencies,
                        converter,
                        license_file,
                        license_key,
                        args.step_export_format,
                        args.timeout,
                        not args.no_xvfb,
                    )
                    output_local_path.parent.mkdir(parents=True, exist_ok=True)
                    output_local_path.write_bytes(step_bytes)
                    manifest = manifest_for(
                        source,
                        source_bucket_path,
                        output_bucket_path,
                        source_sha,
                        dependencies,
                        step_bytes,
                        args.step_export_format,
                    )
                    local_manifest_path.write_text(
                        json.dumps(manifest, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
                manifest_bytes = json.dumps(
                    manifest, ensure_ascii=False, separators=(",", ":")
                ).encode("utf-8")
                prepared_uploads.extend([
                    (step_bytes, output_bucket_path),
                    (manifest_bytes, f"{output_bucket_path}.json"),
                ])
                print(f"        OK : {output_local_path} ({len(step_bytes)} octets)")
            except (ConversionError, OSError, ValueError) as exc:
                failures += 1
                print(f"        ERREUR : {redact(exc)}", file=sys.stderr)
                if not args.continue_on_error:
                    return 1

        if args.upload and prepared_uploads:
            print(f"Upload de {len(prepared_uploads) // 2} STEP + manifests vers {args.bucket_id}...")
            upload_additions(args.bucket_id, os.getenv("HF_TOKEN", ""), prepared_uploads)
            print("Upload terminé.")
        elif prepared_uploads:
            print("Aucun upload effectué : ajoute --upload après vérification des STEP locaux.")
        else:
            print("Aucun nouveau fichier à préparer.")
        return 1 if failures else 0
    except (ConversionError, OSError, ValueError) as exc:
        print(f"ERREUR : {redact(exc)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
