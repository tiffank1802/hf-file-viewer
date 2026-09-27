"""Incremental Docling preprocessing for Hugging Face Storage Buckets.

This module deliberately keeps all Hub and Docling imports lazy.  The Space can
therefore expose a useful health endpoint even while its model stack is still
initialising, and the pure helpers remain inexpensive to unit test.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import logging
import os
import re
import shutil
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

LOGGER = logging.getLogger("enise.reader_pipeline")
SCHEMA_VERSION = "enise-reader/v1"
DEFAULT_EXTENSIONS = (
    ".pdf,.docx,.pptx,.xlsx,.odt,.ods,.odp,.html,.htm,.md,.txt,.csv,"
    ".adoc,.asciidoc,.tex,.epub,.eml,.msg,.vtt,"
    ".png,.jpg,.jpeg,.tif,.tiff,.webp,.bmp"
)
_BUCKET_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


class InfrastructureError(RuntimeError):
    """A storage/auth failure that must stop the run instead of poisoning every entry."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def env_int(name: str, default: int, minimum: int = 0) -> int:
    value = os.getenv(name)
    if value is None or not value.strip():
        return default
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} doit être un entier") from exc
    if parsed < minimum:
        raise ValueError(f"{name} doit être supérieur ou égal à {minimum}")
    return parsed


def safe_error(error: BaseException, limit: int = 1200) -> str:
    message = f"{type(error).__name__}: {error}".replace("\x00", "")
    return message[:limit]


def jsonable(value: Any) -> Any:
    """Convert Docling/Pydantic values to deterministic JSON-compatible data."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    if dataclasses.is_dataclass(value):
        return jsonable(dataclasses.asdict(value))
    if hasattr(value, "model_dump"):
        return jsonable(value.model_dump(mode="json", exclude_none=True))
    if isinstance(value, dict):
        return {str(key): jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [jsonable(item) for item in value]
    if hasattr(value, "value"):
        return jsonable(value.value)
    return str(value)


def source_signature(path: str, size: int, modified: str, content_hash: str = "") -> str:
    payload = json.dumps(
        {"path": path, "size": size, "modified": modified, "hash": content_hash},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def artifact_id(source_path: str, signature: str, pipeline_version: str) -> str:
    payload = f"{source_path}\0{signature}\0{pipeline_version}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:32]


def document_slug(source_path: str) -> str:
    stem = Path(source_path).stem.lower()
    stem = re.sub(r"[^a-z0-9]+", "-", stem).strip("-")[:48] or "document"
    suffix = hashlib.sha256(source_path.encode("utf-8")).hexdigest()[:12]
    return f"{stem}-{suffix}"


def supported_path(path: str, extensions: frozenset[str]) -> bool:
    return Path(path).suffix.lower() in extensions and not path.startswith("reader/")


@dataclasses.dataclass(frozen=True)
class Settings:
    source_bucket_id: str
    derived_bucket_id: str
    hf_token: str
    pipeline_version: str
    workspace: Path
    supported_extensions: frozenset[str]
    auto_sync_on_start: bool
    sync_interval_seconds: int
    max_documents_per_run: int
    max_source_bytes: int
    max_attempts: int
    catalog_flush_every: int
    derived_bucket_private: bool
    image_scale: float
    sync_token: str

    catalog_key: str = "reader/v1/catalog.json"
    status_key: str = "reader/v1/status.json"
    artifact_prefix: str = "reader/v1/documents"

    @classmethod
    def from_env(cls) -> "Settings":
        source = os.getenv("SOURCE_BUCKET_ID", "ktongue/ENISE-SITE").strip()
        derived = os.getenv("DERIVED_BUCKET_ID", "ktongue/ENISE-SITE-DERIVED").strip()
        for name, value in (("SOURCE_BUCKET_ID", source), ("DERIVED_BUCKET_ID", derived)):
            if not _BUCKET_RE.fullmatch(value):
                raise ValueError(f"{name} invalide: {value!r}")

        raw_extensions = os.getenv("SUPPORTED_EXTENSIONS", DEFAULT_EXTENSIONS)
        extensions = frozenset(
            extension if extension.startswith(".") else f".{extension}"
            for extension in (item.strip().lower() for item in raw_extensions.split(","))
            if extension
        )
        if not extensions:
            raise ValueError("SUPPORTED_EXTENSIONS ne peut pas être vide")

        scale_text = os.getenv("IMAGE_SCALE", "2.0")
        try:
            image_scale = float(scale_text)
        except ValueError as exc:
            raise ValueError("IMAGE_SCALE doit être un nombre") from exc
        if not 0.5 <= image_scale <= 4.0:
            raise ValueError("IMAGE_SCALE doit être compris entre 0.5 et 4.0")

        return cls(
            source_bucket_id=source,
            derived_bucket_id=derived,
            hf_token=os.getenv("HF_TOKEN", "").strip(),
            pipeline_version=os.getenv(
                "PIPELINE_VERSION", "docling-2.130.0-enise-reader-v1"
            ).strip(),
            workspace=Path(os.getenv("WORKSPACE_DIR", "/tmp/enise-reader")),
            supported_extensions=extensions,
            auto_sync_on_start=env_bool("AUTO_SYNC_ON_START", True),
            sync_interval_seconds=env_int("SYNC_INTERVAL_SECONDS", 21600, 300),
            max_documents_per_run=env_int("MAX_DOCUMENTS_PER_RUN", 0),
            max_source_bytes=env_int("MAX_SOURCE_BYTES", 250 * 1024 * 1024, 1),
            max_attempts=env_int("MAX_ATTEMPTS", 3, 1),
            catalog_flush_every=env_int("CATALOG_FLUSH_EVERY", 10, 1),
            derived_bucket_private=env_bool("DERIVED_BUCKET_PRIVATE", False),
            image_scale=image_scale,
            sync_token=os.getenv("SYNC_TOKEN", "").strip(),
        )

    def public_dict(self) -> dict[str, Any]:
        return {
            "sourceBucket": self.source_bucket_id,
            "derivedBucket": self.derived_bucket_id,
            "pipelineVersion": self.pipeline_version,
            "supportedExtensions": sorted(self.supported_extensions),
            "autoSyncOnStart": self.auto_sync_on_start,
            "syncIntervalSeconds": self.sync_interval_seconds,
            "maxDocumentsPerRun": self.max_documents_per_run,
            "maxSourceBytes": self.max_source_bytes,
            "configured": bool(self.hf_token),
            "manualSyncProtected": bool(self.sync_token),
        }


@dataclasses.dataclass(frozen=True)
class SourceObject:
    path: str
    size: int
    modified: str
    content_hash: str

    @property
    def signature(self) -> str:
        return source_signature(self.path, self.size, self.modified, self.content_hash)


class RuntimeState:
    """Thread-safe, process-local progress exposed by the Space API."""

    def __init__(self, settings: Settings):
        self._lock = threading.Lock()
        self._data: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "service": "enise-docling-indexer",
            "startedAt": utc_now(),
            "running": False,
            "stopRequested": False,
            "phase": "idle" if settings.hf_token else "configuration-required",
            "runId": None,
            "runStartedAt": None,
            "runFinishedAt": None,
            "currentDocument": None,
            "bucketFileCount": 0,
            "sourceCount": 0,
            "unsupportedCount": 0,
            "unsupportedExtensions": {},
            "eligibleCount": 0,
            "processed": 0,
            "skipped": 0,
            "failed": 0,
            "oversized": 0,
            "lastError": None,
            "lastSuccessfulSync": None,
            "nextScheduledSync": None,
            "settings": settings.public_dict(),
        }

    def update(self, **values: Any) -> None:
        with self._lock:
            self._data.update(jsonable(values))

    def increment(self, key: str, amount: int = 1) -> None:
        with self._lock:
            self._data[key] = int(self._data.get(key, 0)) + amount

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return json.loads(json.dumps(self._data, ensure_ascii=False))


class ReaderPipeline:
    """Resumable one-document-at-a-time Docling conversion pipeline."""

    def __init__(self, settings: Settings, state: RuntimeState):
        self.settings = settings
        self.state = state
        self.run_lock = threading.Lock()
        self.stop_event = threading.Event()
        self._api: Any = None
        self._converter: Any = None
        self._chunker: Any = None
        self._chunker_unavailable = False

    @property
    def api(self) -> Any:
        if self._api is None:
            from huggingface_hub import HfApi

            self._api = HfApi(token=self.settings.hf_token)
        return self._api

    def request_stop(self) -> None:
        self.stop_event.set()
        self.state.update(stopRequested=True, phase="stopping")

    def sync(self, retry_failed: bool = False) -> bool:
        """Run one incremental scan. Return False when another scan is active."""
        if not self.run_lock.acquire(blocking=False):
            return False
        try:
            self._sync_locked(retry_failed=retry_failed)
            return True
        finally:
            self.run_lock.release()

    def _sync_locked(self, retry_failed: bool) -> None:
        if not self.settings.hf_token:
            self.state.update(
                running=False,
                phase="configuration-required",
                lastError="Le secret HF_TOKEN n'est pas configuré dans le Space.",
            )
            return

        self.stop_event.clear()
        run_id = hashlib.sha256(f"{time.time_ns()}".encode()).hexdigest()[:16]
        self.state.update(
            running=True,
            stopRequested=False,
            phase="preparing",
            runId=run_id,
            runStartedAt=utc_now(),
            runFinishedAt=None,
            currentDocument=None,
            bucketFileCount=0,
            sourceCount=0,
            unsupportedCount=0,
            unsupportedExtensions={},
            eligibleCount=0,
            processed=0,
            skipped=0,
            failed=0,
            oversized=0,
            lastError=None,
        )

        catalog: dict[str, Any] = self._empty_catalog()
        try:
            self._ensure_destination_bucket()
            catalog = self._load_catalog()
            self.state.update(phase="scanning")
            sources = self._list_sources()
            self.state.update(sourceCount=len(sources))
            selected = self._select_sources(sources, catalog, retry_failed=retry_failed)
            self.state.update(eligibleCount=len(selected), phase="converting")
            self._mark_missing_sources(catalog, sources)

            changed_since_flush = 0
            for source in selected:
                if self.stop_event.is_set():
                    break
                self.state.update(currentDocument=source.path)
                try:
                    if source.size > self.settings.max_source_bytes:
                        self._record_oversized(catalog, source)
                        self.state.increment("oversized")
                    else:
                        self._process_source(catalog, source)
                        self.state.increment("processed")
                except InfrastructureError:
                    # Bucket/auth/network failures are global. Continuing would mark
                    # thousands of healthy sources as failed and hammer the Hub.
                    raise
                except Exception as error:  # one bad document must not stop the corpus
                    LOGGER.error("Conversion failed for %s: %s", source.path, error)
                    LOGGER.debug("Conversion traceback:\n%s", traceback.format_exc())
                    self._record_failure(catalog, source, error)
                    self.state.increment("failed")
                    self.state.update(lastError=safe_error(error))
                changed_since_flush += 1
                if changed_since_flush >= self.settings.catalog_flush_every:
                    self._publish_catalog(catalog)
                    self._publish_status()
                    changed_since_flush = 0

            self.state.update(phase="publishing", currentDocument=None)
            self._publish_catalog(catalog)
            stopped = self.stop_event.is_set()
            final_state: dict[str, Any] = {
                "running": False,
                "phase": "stopped" if stopped else "idle",
                "runFinishedAt": utc_now(),
                "currentDocument": None,
            }
            if not stopped:
                final_state["lastSuccessfulSync"] = utc_now()
            self.state.update(**final_state)
            self._publish_status()
        except Exception as error:
            LOGGER.exception("Synchronization aborted")
            self.state.update(
                running=False,
                phase="error",
                runFinishedAt=utc_now(),
                currentDocument=None,
                lastError=safe_error(error),
            )
            try:
                self._publish_status()
            except Exception:
                LOGGER.exception("Could not publish failure status")

    def _empty_catalog(self) -> dict[str, Any]:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "pipelineVersion": self.settings.pipeline_version,
            "sourceBucket": self.settings.source_bucket_id,
            "derivedBucket": self.settings.derived_bucket_id,
            "updatedAt": utc_now(),
            "documents": {},
        }

    def _ensure_destination_bucket(self) -> None:
        try:
            self.api.bucket_info(self.settings.derived_bucket_id)
            return
        except Exception as error:
            status = getattr(getattr(error, "response", None), "status_code", None)
            missing = status == 404 or type(error).__name__ == "BucketNotFoundError"
            if not missing:
                # Authentication/authorization errors must not be mistaken for a
                # missing bucket: attempting creation could hide a bad runtime token.
                raise
        try:
            self.api.create_bucket(
                self.settings.derived_bucket_id,
                private=self.settings.derived_bucket_private,
            )
            LOGGER.info("Created destination bucket %s", self.settings.derived_bucket_id)
        except Exception as error:
            if getattr(getattr(error, "response", None), "status_code", None) != 409:
                raise

    def _download_single(self, bucket_id: str, remote_path: str, local_path: Path) -> None:
        local_path.parent.mkdir(parents=True, exist_ok=True)
        self.api.download_bucket_files(
            bucket_id=bucket_id,
            files=[(remote_path, str(local_path))],
            raise_on_missing_files=True,
        )

    def _load_catalog(self) -> dict[str, Any]:
        path = self.settings.workspace / "state" / "catalog.json"
        shutil.rmtree(path.parent, ignore_errors=True)
        try:
            self._download_single(
                self.settings.derived_bucket_id,
                self.settings.catalog_key,
                path,
            )
        except Exception as error:
            if getattr(getattr(error, "response", None), "status_code", None) == 404:
                return self._empty_catalog()
            # Some bucket download errors do not preserve an HTTP response.
            if "404" in str(error) or "not found" in str(error).lower():
                return self._empty_catalog()
            raise

        parsed = json.loads(path.read_text(encoding="utf-8"))
        if parsed.get("schemaVersion") != SCHEMA_VERSION:
            LOGGER.warning("Ignoring catalog with incompatible schema")
            return self._empty_catalog()
        if not isinstance(parsed.get("documents"), dict):
            LOGGER.warning("Ignoring malformed destination catalog")
            return self._empty_catalog()
        parsed["pipelineVersion"] = self.settings.pipeline_version
        parsed["sourceBucket"] = self.settings.source_bucket_id
        parsed["derivedBucket"] = self.settings.derived_bucket_id
        return parsed

    def _list_sources(self) -> list[SourceObject]:
        sources: list[SourceObject] = []
        bucket_file_count = 0
        unsupported: dict[str, int] = {}
        for item in self.api.list_bucket_tree(
            self.settings.source_bucket_id,
            recursive=True,
        ):
            path = str(getattr(item, "path", ""))
            item_type = str(getattr(item, "type", "file"))
            if not path or item_type not in {"file", "BucketFile"}:
                continue
            bucket_file_count += 1
            if not supported_path(path, self.settings.supported_extensions):
                extension = Path(path).suffix.lower() or "(sans extension)"
                unsupported[extension] = unsupported.get(extension, 0) + 1
                continue
            modified = getattr(item, "last_modified", None) or getattr(item, "mtime", None)
            if isinstance(modified, datetime):
                modified_text = modified.isoformat()
            else:
                modified_text = str(modified or "")
            content_hash = str(
                getattr(item, "xet_hash", None)
                or getattr(item, "blob_id", None)
                or getattr(item, "oid", None)
                or ""
            )
            sources.append(
                SourceObject(
                    path=path,
                    size=int(getattr(item, "size", 0) or 0),
                    modified=modified_text,
                    content_hash=content_hash,
                )
            )
        sources.sort(key=lambda item: item.path.casefold())
        self.state.update(
            bucketFileCount=bucket_file_count,
            unsupportedCount=sum(unsupported.values()),
            unsupportedExtensions=dict(sorted(unsupported.items())),
        )
        return sources

    def _select_sources(
        self,
        sources: list[SourceObject],
        catalog: dict[str, Any],
        retry_failed: bool,
    ) -> list[SourceObject]:
        selected: list[SourceObject] = []
        entries = catalog["documents"]
        for source in sources:
            artifact = artifact_id(source.path, source.signature, self.settings.pipeline_version)
            entry = entries.get(source.path) or {}
            unchanged = (
                entry.get("artifactId") == artifact
                and entry.get("pipelineVersion") == self.settings.pipeline_version
            )
            if unchanged and entry.get("status") == "ready":
                self.state.increment("skipped")
                continue
            if (
                unchanged
                and entry.get("status") == "oversized"
                and source.size > self.settings.max_source_bytes
            ):
                self.state.increment("skipped")
                continue
            if (
                unchanged
                and entry.get("status") == "failed"
                and not retry_failed
                and int(entry.get("attempts", 0)) >= self.settings.max_attempts
            ):
                self.state.increment("skipped")
                continue
            selected.append(source)
            if self.settings.max_documents_per_run:
                if len(selected) >= self.settings.max_documents_per_run:
                    break
        return selected

    @staticmethod
    def _mark_missing_sources(catalog: dict[str, Any], sources: Iterable[SourceObject]) -> None:
        existing = {source.path for source in sources}
        for path, entry in catalog["documents"].items():
            entry["sourcePresent"] = path in existing

    def _entry_base(self, source: SourceObject) -> dict[str, Any]:
        artifact = artifact_id(source.path, source.signature, self.settings.pipeline_version)
        prefix = f"{self.settings.artifact_prefix}/{document_slug(source.path)}/{artifact}"
        return {
            "sourcePath": source.path,
            "sourceSize": source.size,
            "sourceModified": source.modified,
            "sourceContentHash": source.content_hash or None,
            "sourceSignature": source.signature,
            "sourcePresent": True,
            "pipelineVersion": self.settings.pipeline_version,
            "artifactId": artifact,
            "artifactPrefix": prefix,
        }

    def _record_oversized(self, catalog: dict[str, Any], source: SourceObject) -> None:
        previous = catalog["documents"].get(source.path, {})
        catalog["documents"][source.path] = {
            **self._entry_base(source),
            "status": "oversized",
            "attempts": int(previous.get("attempts", 0)),
            "lastError": (
                f"Taille {source.size} supérieure à MAX_SOURCE_BYTES "
                f"({self.settings.max_source_bytes})."
            ),
            "updatedAt": utc_now(),
        }

    def _record_failure(
        self, catalog: dict[str, Any], source: SourceObject, error: BaseException
    ) -> None:
        previous = catalog["documents"].get(source.path, {})
        same_artifact = previous.get("artifactId") == self._entry_base(source)["artifactId"]
        attempts = int(previous.get("attempts", 0)) + 1 if same_artifact else 1
        catalog["documents"][source.path] = {
            **self._entry_base(source),
            "status": "failed",
            "attempts": attempts,
            "lastError": safe_error(error),
            "updatedAt": utc_now(),
        }

    def _process_source(self, catalog: dict[str, Any], source: SourceObject) -> None:
        entry_base = self._entry_base(source)
        work_root = self.settings.workspace / "runs" / entry_base["artifactId"]
        source_path = work_root / "source" / Path(source.path).name
        output_dir = work_root / "artifact"
        shutil.rmtree(work_root, ignore_errors=True)
        output_dir.mkdir(parents=True, exist_ok=True)

        try:
            try:
                self._download_single(self.settings.source_bucket_id, source.path, source_path)
            except Exception as error:
                status = getattr(getattr(error, "response", None), "status_code", None)
                if status == 404 or type(error).__name__ == "EntryNotFoundError":
                    raise RuntimeError(
                        f"La source a disparu pendant le scan: {source.path}"
                    ) from error
                raise InfrastructureError(
                    f"Téléchargement impossible pour {source.path}: {safe_error(error)}"
                ) from error
            file_hash = self._sha256_file(source_path)
            conversion = self._convert(source, source_path, output_dir, entry_base, file_hash)
            try:
                self._upload_artifact(output_dir, entry_base["artifactPrefix"])
            except Exception as error:
                raise InfrastructureError(
                    f"Publication impossible pour {source.path}: {safe_error(error)}"
                ) from error
            previous = catalog["documents"].get(source.path, {})
            same_artifact = previous.get("artifactId") == entry_base["artifactId"]
            attempts = int(previous.get("attempts", 0)) + 1 if same_artifact else 1
            catalog["documents"][source.path] = {
                **entry_base,
                "status": "ready",
                "attempts": attempts,
                "lastError": None,
                "manifestPath": f"{entry_base['artifactPrefix']}/manifest.json",
                "sourceSha256": file_hash,
                "blockCount": conversion["blockCount"],
                "assetCount": conversion["assetCount"],
                "chunkCount": conversion["chunkCount"],
                "updatedAt": utc_now(),
            }
        finally:
            shutil.rmtree(work_root, ignore_errors=True)

    @staticmethod
    def _sha256_file(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _get_converter(self) -> Any:
        if self._converter is not None:
            return self._converter

        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.document_converter import (
            DocumentConverter,
            ImageFormatOption,
            PdfFormatOption,
        )

        options = PdfPipelineOptions()
        options.images_scale = self.settings.image_scale
        options.generate_picture_images = True
        options.generate_page_images = False
        options.do_ocr = True
        self._converter = DocumentConverter(
            format_options={
                InputFormat.PDF: PdfFormatOption(pipeline_options=options),
                InputFormat.IMAGE: ImageFormatOption(pipeline_options=options),
            }
        )
        return self._converter

    def _convert(
        self,
        source: SourceObject,
        source_path: Path,
        output_dir: Path,
        entry_base: dict[str, Any],
        source_sha256: str,
    ) -> dict[str, int]:
        from docling_core.types.doc import ImageRefMode, PictureItem, TableItem

        converter = self._get_converter()
        result = converter.convert(source_path)
        document = result.document

        document.save_as_json(
            output_dir / "docling.json",
            image_mode=ImageRefMode.PLACEHOLDER,
        )
        document.save_as_markdown(
            output_dir / "content.md",
            image_mode=ImageRefMode.PLACEHOLDER,
        )

        assets_dir = output_dir / "assets"
        assets_dir.mkdir(parents=True, exist_ok=True)
        blocks: list[dict[str, Any]] = []
        assets: list[dict[str, Any]] = []
        ordinal = 0

        for item, level in document.iterate_items():
            ordinal += 1
            reference = str(getattr(item, "self_ref", "") or f"ordinal-{ordinal}")
            block_id = "b-" + hashlib.sha256(
                f"{entry_base['artifactId']}\0{reference}".encode("utf-8")
            ).hexdigest()[:20]
            label = getattr(getattr(item, "label", None), "value", None)
            label = str(label or type(item).__name__).lower()
            text = str(getattr(item, "text", "") or "")
            block: dict[str, Any] = {
                "id": block_id,
                "ordinal": ordinal,
                "level": int(level or 0),
                "type": label,
                "text": text,
                "selfRef": reference,
                "parentRef": str(getattr(item, "parent", "") or "") or None,
                "provenance": jsonable(getattr(item, "prov", []) or []),
            }

            caption = ""
            caption_method = getattr(item, "caption_text", None)
            if callable(caption_method):
                try:
                    caption = str(caption_method(document) or "")
                except Exception:
                    caption = ""
            if caption:
                block["caption"] = caption

            if isinstance(item, TableItem):
                try:
                    block["markdown"] = item.export_to_markdown(doc=document)
                except Exception:
                    LOGGER.warning("Could not export table %s from %s", reference, source.path)

            if isinstance(item, PictureItem):
                asset_id = f"figure-{ordinal:05d}"
                image_name = f"{asset_id}.webp"
                try:
                    image = item.get_image(document)
                    if image is not None:
                        image.save(assets_dir / image_name, format="WEBP", quality=88, method=4)
                        width, height = image.size
                        asset = {
                            "id": asset_id,
                            "kind": "figure",
                            "path": f"assets/{image_name}",
                            "width": width,
                            "height": height,
                            "blockId": block_id,
                            "caption": caption or None,
                        }
                        assets.append(asset)
                        block["assetId"] = asset_id
                except Exception as error:
                    LOGGER.warning("Could not export figure %s: %s", reference, error)

            blocks.append(block)

        payload = {
            "schemaVersion": SCHEMA_VERSION,
            "artifactId": entry_base["artifactId"],
            "pipelineVersion": self.settings.pipeline_version,
            "source": {
                "bucket": self.settings.source_bucket_id,
                "path": source.path,
                "size": source.size,
                "modified": source.modified,
                "sha256": source_sha256,
            },
            "title": getattr(document, "name", None) or Path(source.path).stem,
            "blocks": blocks,
            "assets": assets,
        }
        (output_dir / "document.json").write_text(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2),
            encoding="utf-8",
        )

        chunks = self._make_chunks(document, blocks)
        (output_dir / "chunks.jsonl").write_text(
            "".join(json.dumps(chunk, ensure_ascii=False, sort_keys=True) + "\n" for chunk in chunks),
            encoding="utf-8",
        )

        manifest = {
            "schemaVersion": SCHEMA_VERSION,
            **entry_base,
            "status": "ready",
            "createdAt": utc_now(),
            "sourceSha256": source_sha256,
            "files": {
                "document": "document.json",
                "docling": "docling.json",
                "markdown": "content.md",
                "chunks": "chunks.jsonl",
            },
            "counts": {
                "blocks": len(blocks),
                "assets": len(assets),
                "chunks": len(chunks),
            },
        }
        (output_dir / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2),
            encoding="utf-8",
        )
        return {
            "blockCount": len(blocks),
            "assetCount": len(assets),
            "chunkCount": len(chunks),
        }

    def _make_chunks(self, document: Any, blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        chunks: list[dict[str, Any]] = []
        if not self._chunker_unavailable:
            try:
                if self._chunker is None:
                    from docling.chunking import HybridChunker

                    # Reuse the tokenizer for the whole run. Constructing a new
                    # HybridChunker for every document would repeatedly inspect the
                    # Hub cache and add avoidable network latency.
                    self._chunker = HybridChunker()
                for index, chunk in enumerate(
                    self._chunker.chunk(dl_doc=document), start=1
                ):
                    chunks.append(
                        {
                            "id": f"c-{index:06d}",
                            "text": str(getattr(chunk, "text", "") or ""),
                            "meta": jsonable(getattr(chunk, "meta", None)),
                        }
                    )
            except Exception as error:
                self._chunker_unavailable = True
                LOGGER.warning(
                    "Hybrid chunking unavailable for this run, using deterministic fallback: %s",
                    error,
                )

        if chunks:
            return chunks

        current: list[str] = []
        current_ids: list[str] = []
        size = 0
        for block in blocks:
            text = str(block.get("text") or block.get("markdown") or "").strip()
            if not text:
                continue
            if current and size + len(text) > 2400:
                chunks.append(
                    {
                        "id": f"c-{len(chunks) + 1:06d}",
                        "text": "\n\n".join(current),
                        "blockIds": current_ids,
                    }
                )
                current, current_ids, size = [], [], 0
            current.append(text)
            current_ids.append(block["id"])
            size += len(text)
        if current:
            chunks.append(
                {
                    "id": f"c-{len(chunks) + 1:06d}",
                    "text": "\n\n".join(current),
                    "blockIds": current_ids,
                }
            )
        return chunks

    def _upload_artifact(self, output_dir: Path, remote_prefix: str) -> None:
        files = sorted(path for path in output_dir.rglob("*") if path.is_file())
        manifest = output_dir / "manifest.json"
        ordinary = [path for path in files if path != manifest]

        # Keep batches small enough for the Hub request while preserving the
        # publication barrier: manifest.json is uploaded only after all payloads.
        for start in range(0, len(ordinary), 100):
            batch = ordinary[start : start + 100]
            additions = [
                (str(path), f"{remote_prefix}/{path.relative_to(output_dir).as_posix()}")
                for path in batch
            ]
            self.api.batch_bucket_files(
                bucket_id=self.settings.derived_bucket_id,
                add=additions,
            )
        self.api.batch_bucket_files(
            bucket_id=self.settings.derived_bucket_id,
            add=[(str(manifest), f"{remote_prefix}/manifest.json")],
        )

    def _publish_catalog(self, catalog: dict[str, Any]) -> None:
        catalog["updatedAt"] = utc_now()
        catalog["pipelineVersion"] = self.settings.pipeline_version
        payload = json.dumps(catalog, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8")
        self.api.batch_bucket_files(
            bucket_id=self.settings.derived_bucket_id,
            add=[(payload, self.settings.catalog_key)],
        )

    def _publish_status(self) -> None:
        payload = json.dumps(
            self.state.snapshot(), ensure_ascii=False, sort_keys=True, indent=2
        ).encode("utf-8")
        self.api.batch_bucket_files(
            bucket_id=self.settings.derived_bucket_id,
            add=[(payload, self.settings.status_key)],
        )
