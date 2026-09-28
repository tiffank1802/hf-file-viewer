import importlib.util
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

MODULE_PATH = Path(__file__).parents[1] / "space-huggingface" / "reader_pipeline.py"
SPEC = importlib.util.spec_from_file_location("reader_pipeline", MODULE_PATH)
reader_pipeline = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = reader_pipeline
SPEC.loader.exec_module(reader_pipeline)


def make_settings(**overrides):
    values = {
        "source_bucket_id": "ktongue/ENISE-SITE",
        "derived_bucket_id": "ktongue/ENISE-SITE-DERIVED",
        "hf_token": "secret",
        "pipeline_version": "v1",
        "workspace": Path("/tmp/test-reader"),
        "supported_extensions": frozenset({".pdf"}),
        "auto_sync_on_start": True,
        "sync_interval_seconds": 3600,
        "max_documents_per_run": 0,
        "max_source_bytes": 1000,
        "max_attempts": 3,
        "catalog_flush_every": 10,
        "hub_operation_retries": 5,
        "hub_retry_base_seconds": 1,
        "derived_bucket_private": False,
        "image_scale": 2.0,
        "sync_token": "",
    }
    values.update(overrides)
    return reader_pipeline.Settings(**values)


class ReaderPipelineHelpersTest(unittest.TestCase):
    def test_artifact_id_is_stable_and_versioned(self):
        signature = reader_pipeline.source_signature("Cours/a.pdf", 123, "2026-09-28", "abc")
        first = reader_pipeline.artifact_id("Cours/a.pdf", signature, "pipeline-v1")
        self.assertEqual(first, reader_pipeline.artifact_id("Cours/a.pdf", signature, "pipeline-v1"))
        self.assertNotEqual(first, reader_pipeline.artifact_id("Cours/a.pdf", signature, "pipeline-v2"))
        self.assertEqual(len(first), 32)

    def test_slug_does_not_expose_full_path_and_avoids_collisions(self):
        first = reader_pipeline.document_slug("A/Plan de cours.pdf")
        second = reader_pipeline.document_slug("B/Plan de cours.pdf")
        self.assertTrue(first.startswith("plan-de-cours-"))
        self.assertNotEqual(first, second)
        self.assertNotIn("A/", first)

    def test_supported_path_uses_explicit_allowlist(self):
        extensions = frozenset({".pdf", ".docx"})
        self.assertTrue(reader_pipeline.supported_path("Cours/NOTE.PDF", extensions))
        self.assertFalse(reader_pipeline.supported_path("Cours/legacy.doc", extensions))
        self.assertFalse(reader_pipeline.supported_path("reader/v1/catalog.pdf", extensions))

    def test_settings_have_production_defaults_without_exposing_token(self):
        names = [
            "SOURCE_BUCKET_ID", "DERIVED_BUCKET_ID", "HF_TOKEN", "PIPELINE_VERSION",
            "SUPPORTED_EXTENSIONS", "SYNC_INTERVAL_SECONDS", "IMAGE_SCALE",
            "MAX_SOURCE_BYTES", "HUB_OPERATION_RETRIES", "HUB_RETRY_BASE_SECONDS",
        ]
        with patch.dict(os.environ, {name: "" for name in names}, clear=False):
            for name in names:
                os.environ.pop(name, None)
            settings = reader_pipeline.Settings.from_env()
        self.assertEqual(settings.source_bucket_id, "ktongue/ENISE-SITE")
        self.assertEqual(settings.derived_bucket_id, "ktongue/ENISE-SITE-DERIVED")
        self.assertTrue(settings.auto_sync_on_start)
        self.assertEqual(settings.max_source_bytes, 15 * 1024 * 1024)
        self.assertNotIn(".doc", settings.supported_extensions)
        self.assertNotIn("hf_token", settings.public_dict())

    def test_selection_skips_ready_and_caps_failed_retries(self):
        settings = make_settings()
        state = reader_pipeline.RuntimeState(settings)
        pipeline = reader_pipeline.ReaderPipeline(settings, state)
        ready = reader_pipeline.SourceObject("ready.pdf", 10, "date", "a")
        failed = reader_pipeline.SourceObject("failed.pdf", 10, "date", "b")
        fresh = reader_pipeline.SourceObject("fresh.pdf", 10, "date", "c")
        catalog = pipeline._empty_catalog()
        catalog["documents"][ready.path] = {
            "status": "ready",
            "artifactId": reader_pipeline.artifact_id(ready.path, ready.signature, "v1"),
            "pipelineVersion": "v1",
        }
        catalog["documents"][failed.path] = {
            "status": "failed",
            "attempts": 3,
            "artifactId": reader_pipeline.artifact_id(failed.path, failed.signature, "v1"),
            "pipelineVersion": "v1",
        }
        selected = pipeline._select_sources([ready, failed, fresh], catalog, retry_failed=False)
        self.assertEqual([item.path for item in selected], ["fresh.pdf"])
        selected_retry = pipeline._select_sources([failed], catalog, retry_failed=True)
        self.assertEqual([item.path for item in selected_retry], ["failed.pdf"])

    def test_missing_optional_dependency_aborts_without_consuming_document_attempt(self):
        settings = make_settings(supported_extensions=frozenset({".odt"}))
        state = reader_pipeline.RuntimeState(settings)
        pipeline = reader_pipeline.ReaderPipeline(settings, state)
        source = reader_pipeline.SourceObject("support.odt", 10, "date", "odf")
        catalog = pipeline._empty_catalog()
        missing = ImportError("The 'odfdo' package is required to process OpenDocument files")
        with (
            patch.object(pipeline, "_ensure_destination_bucket"),
            patch.object(pipeline, "_load_catalog", return_value=catalog),
            patch.object(pipeline, "_list_sources", return_value=[source]),
            patch.object(pipeline, "_mark_missing_sources"),
            patch.object(pipeline, "_process_source", side_effect=missing),
            patch.object(pipeline, "_publish_catalog") as publish_catalog,
            patch.object(pipeline, "_publish_status"),
        ):
            self.assertTrue(pipeline.sync())
        self.assertNotIn(source.path, catalog["documents"])
        self.assertEqual(state.snapshot()["failed"], 0)
        self.assertEqual(state.snapshot()["phase"], "error")
        self.assertIn("Dépendance Docling absente", state.snapshot()["lastError"])
        publish_catalog.assert_not_called()

    def test_resolved_optional_dependency_reopens_capped_failures(self):
        settings = make_settings()
        pipeline = reader_pipeline.ReaderPipeline(
            settings, reader_pipeline.RuntimeState(settings)
        )
        source = reader_pipeline.SourceObject("support.odt", 10, "date", "odf")
        catalog = pipeline._empty_catalog()
        catalog["documents"][source.path] = {
            "status": "failed",
            "attempts": 3,
            "lastError": "ImportError: The 'odfdo' package is required to process OpenDocument files.",
            "artifactId": reader_pipeline.artifact_id(source.path, source.signature, "v1"),
            "pipelineVersion": "v1",
        }
        self.assertTrue(reader_pipeline.optional_dependency_failure(catalog["documents"][source.path]["lastError"]))
        with patch.object(reader_pipeline.importlib.util, "find_spec", return_value=object()):
            selected = pipeline._select_sources([source], catalog, retry_failed=False)
        self.assertEqual([item.path for item in selected], [source.path])

    def test_space_declares_the_opendocument_runtime_dependency(self):
        requirements = (MODULE_PATH.parent / "requirements.txt").read_text(encoding="utf-8")
        self.assertRegex(requirements, r"(?m)^odfdo>=3\.22,<4$")

    def test_source_listing_prioritizes_lightweight_files(self):
        settings = make_settings()
        pipeline = reader_pipeline.ReaderPipeline(
            settings, reader_pipeline.RuntimeState(settings)
        )

        class FakeApi:
            @staticmethod
            def list_bucket_tree(_bucket_id, recursive):
                self.assertTrue(recursive)
                return [
                    SimpleNamespace(
                        type="file", path="large.pdf", size=900, mtime=None, xet_hash="l"
                    ),
                    SimpleNamespace(
                        type="file", path="small.pdf", size=10, mtime=None, xet_hash="s"
                    ),
                    SimpleNamespace(
                        type="file", path="medium.pdf", size=200, mtime=None, xet_hash="m"
                    ),
                ]

        pipeline._api = FakeApi()
        self.assertEqual(
            [source.path for source in pipeline._list_sources()],
            ["small.pdf", "medium.pdf", "large.pdf"],
        )

    def test_xet_publication_race_is_retried(self):
        settings = make_settings(hub_operation_retries=3)
        pipeline = reader_pipeline.ReaderPipeline(
            settings, reader_pipeline.RuntimeState(settings)
        )
        bucket_error = type("BucketBatchError", (RuntimeError,), {})

        class FakeApi:
            def __init__(self):
                self.calls = 0

            def batch_bucket_files(self, **_kwargs):
                self.calls += 1
                if self.calls < 3:
                    raise bucket_error("File not found in Xet storage")

        api = FakeApi()
        pipeline._api = api
        with patch.object(reader_pipeline.time, "sleep") as sleep:
            pipeline._add_bucket_files([(b"payload", "reader/v1/status.json")])
        self.assertEqual(api.calls, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2])


if __name__ == "__main__":
    unittest.main()
