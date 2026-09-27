"""FastAPI control plane for the ENISE Docling preprocessing Space.

Visitors never call this service to open a document.  The Space scans the
source Storage Bucket in the background and publishes immutable reader
artifacts to the derived bucket; the website only reads those artifacts.
"""

from __future__ import annotations

import hmac
import logging
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from html import escape
from typing import Annotated

from fastapi import FastAPI, Header, HTTPException, Query, status
from fastapi.responses import HTMLResponse

from reader_pipeline import ReaderPipeline, RuntimeState, Settings, safe_error

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
LOGGER = logging.getLogger("enise.space")

try:
    SETTINGS = Settings.from_env()
    SETTINGS_ERROR = ""
except Exception as error:  # keep health diagnostics available on bad config
    LOGGER.exception("Invalid Space configuration")
    SETTINGS_ERROR = safe_error(error)
    # Defaults are known-valid; only use them to start the diagnostic server.
    import os

    for name in (
        "SOURCE_BUCKET_ID",
        "DERIVED_BUCKET_ID",
        "SUPPORTED_EXTENSIONS",
        "IMAGE_SCALE",
        "SYNC_INTERVAL_SECONDS",
        "MAX_DOCUMENTS_PER_RUN",
        "MAX_SOURCE_BYTES",
        "MAX_ATTEMPTS",
        "CATALOG_FLUSH_EVERY",
    ):
        os.environ.pop(name, None)
    SETTINGS = Settings.from_env()

STATE = RuntimeState(SETTINGS)
if SETTINGS_ERROR:
    STATE.update(phase="configuration-error", lastError=SETTINGS_ERROR)
PIPELINE = ReaderPipeline(SETTINGS, STATE)
SCHEDULER_STOP = threading.Event()
SYNC_STARTING = threading.Event()
TRIGGER_LOCK = threading.Lock()


def _run_sync(retry_failed: bool = False) -> None:
    try:
        PIPELINE.sync(retry_failed=retry_failed)
    except Exception as error:  # ReaderPipeline normally contains all failures
        LOGGER.exception("Unexpected synchronization error")
        STATE.update(running=False, phase="error", lastError=safe_error(error))
    finally:
        SYNC_STARTING.clear()


def trigger_sync(retry_failed: bool = False) -> bool:
    # Cover the few milliseconds between thread creation and run_lock.acquire().
    # Without this launch guard, two simultaneous HTTP requests could both be
    # reported as accepted even though the pipeline itself rejects the second.
    with TRIGGER_LOCK:
        if SYNC_STARTING.is_set() or PIPELINE.run_lock.locked():
            return False
        SYNC_STARTING.set()
        thread = threading.Thread(
            target=_run_sync,
            args=(retry_failed,),
            name="docling-sync",
            daemon=True,
        )
        thread.start()
        return True


def _scheduler() -> None:
    if SETTINGS.auto_sync_on_start and SETTINGS.hf_token and not SETTINGS_ERROR:
        trigger_sync()

    while not SCHEDULER_STOP.is_set():
        next_sync = datetime.now(timezone.utc) + timedelta(
            seconds=SETTINGS.sync_interval_seconds
        )
        STATE.update(nextScheduledSync=next_sync.isoformat().replace("+00:00", "Z"))
        if SCHEDULER_STOP.wait(SETTINGS.sync_interval_seconds):
            break
        if SETTINGS.hf_token and not SETTINGS_ERROR:
            trigger_sync()


def _authorized(authorization: str | None) -> bool:
    if not SETTINGS.sync_token:
        return False
    if not authorization or not authorization.startswith("Bearer "):
        return False
    return hmac.compare_digest(authorization[7:].strip(), SETTINGS.sync_token)


@asynccontextmanager
async def lifespan(_: FastAPI):
    scheduler = threading.Thread(
        target=_scheduler,
        name="docling-scheduler",
        daemon=True,
    )
    scheduler.start()
    yield
    SCHEDULER_STOP.set()
    PIPELINE.request_stop()


app = FastAPI(
    title="ENISE Docling Indexer",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url=None,
    lifespan=lifespan,
)


@app.get("/api/health")
def health() -> dict:
    snapshot = STATE.snapshot()
    configured = bool(SETTINGS.hf_token) and not bool(SETTINGS_ERROR)
    return {
        "ok": configured,
        "service": snapshot["service"],
        "configured": configured,
        "running": snapshot["running"],
        "phase": snapshot["phase"],
        "pipelineVersion": SETTINGS.pipeline_version,
        "configurationError": SETTINGS_ERROR or None,
    }


@app.get("/api/status")
def pipeline_status() -> dict:
    return STATE.snapshot()


@app.post("/api/sync", status_code=status.HTTP_202_ACCEPTED)
def start_sync(
    retry_failed: Annotated[bool, Query()] = False,
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    if not _authorized(authorization):
        detail = (
            "Déclenchement manuel désactivé: configurez le secret SYNC_TOKEN."
            if not SETTINGS.sync_token
            else "Jeton d'administration invalide."
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)
    if SETTINGS_ERROR:
        raise HTTPException(status_code=503, detail=SETTINGS_ERROR)
    if not SETTINGS.hf_token:
        raise HTTPException(status_code=503, detail="Le secret HF_TOKEN est absent.")
    if not trigger_sync(retry_failed=retry_failed):
        raise HTTPException(status_code=409, detail="Une synchronisation est déjà active.")
    return {"accepted": True, "retryFailed": retry_failed}


@app.post("/api/stop", status_code=status.HTTP_202_ACCEPTED)
def stop_sync(authorization: Annotated[str | None, Header()] = None) -> dict:
    if not _authorized(authorization):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Jeton invalide.")
    PIPELINE.request_stop()
    return {"accepted": True}


@app.get("/", response_class=HTMLResponse)
def dashboard() -> str:
    snapshot = STATE.snapshot()
    source = escape(SETTINGS.source_bucket_id)
    destination = escape(SETTINGS.derived_bucket_id)
    version = escape(SETTINGS.pipeline_version)
    phase = escape(str(snapshot["phase"]))
    config_message = (
        f'<p class="error">Configuration invalide : {escape(SETTINGS_ERROR)}</p>'
        if SETTINGS_ERROR
        else (
            ""
            if SETTINGS.hf_token
            else '<p class="error">Ajoutez le secret <code>HF_TOKEN</code> au Space pour autoriser le bucket dérivé.</p>'
        )
    )
    return f"""<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ENISE · Prétraitement documentaire</title>
<style>
:root{{color-scheme:dark;background:#07111f;color:#e7eef8;font:16px system-ui,sans-serif}}
body{{max-width:940px;margin:0 auto;padding:48px 22px}} h1{{font-size:clamp(2rem,6vw,4rem);line-height:1;margin:.2em 0}}
.tag{{color:#8dd7ff;text-transform:uppercase;letter-spacing:.14em;font-weight:700}} .card{{background:#0d1c30;border:1px solid #253a54;border-radius:16px;padding:22px;margin:22px 0}}
.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}} .metric{{background:#091626;border-radius:10px;padding:14px}}
.metric strong{{display:block;font-size:1.8rem}} code{{color:#8dd7ff}} a{{color:#8dd7ff}} .error{{color:#ffb4ab}} .muted{{color:#a8bacf}}
button{{background:#8dd7ff;color:#04111e;border:0;border-radius:8px;padding:10px 16px;font-weight:700;cursor:pointer}} input{{padding:10px;border-radius:8px;border:1px solid #3b526d;background:#07111f;color:white}}
</style></head><body>
<p class="tag">Batch Docling · Space administrateur</p><h1>Documents préparés avant consultation.</h1>
<p class="muted">Ce Space ne convertit rien à la demande des visiteurs. Il transforme le corpus connu, reprend après interruption et publie des artefacts versionnés que le site peut lire directement.</p>
{config_message}
<section class="card"><h2>Pipeline</h2><p><code>{source}</code> → <code>{destination}</code></p><p>Version : <code>{version}</code> · phase : <strong id="phase">{phase}</strong></p>
<div class="grid"><div class="metric"><span>Sources prises en charge</span><strong id="sources">{snapshot['sourceCount']}</strong></div><div class="metric"><span>Convertis</span><strong id="processed">{snapshot['processed']}</strong></div><div class="metric"><span>Déjà prêts</span><strong id="skipped">{snapshot['skipped']}</strong></div><div class="metric"><span>Formats hors pipeline</span><strong id="unsupported">{snapshot['unsupportedCount']}</strong></div><div class="metric"><span>Échecs</span><strong id="failed">{snapshot['failed']}</strong></div></div></section>
<section class="card"><h2>Commande administrative</h2><p class="muted">Le scan au démarrage et la boucle périodique sont automatiques tant que le Space est réveillé. Le jeton ci-dessous reste uniquement dans votre navigateur.</p>
<input id="token" type="password" placeholder="SYNC_TOKEN"><button onclick="syncNow()">Lancer maintenant</button><p id="action"></p></section>
<p><a href="/api/status">État JSON</a> · <a href="/api/docs">API</a></p>
<script>
async function refresh(){{const s=await fetch('/api/status').then(r=>r.json());for(const k of ['phase','processed','skipped','unsupported','failed'])document.getElementById(k).textContent=k==='unsupported'?s.unsupportedCount:s[k];document.getElementById('sources').textContent=s.sourceCount;}}
async function syncNow(){{const token=document.getElementById('token').value;const r=await fetch('/api/sync',{{method:'POST',headers:{{Authorization:'Bearer '+token}}}});document.getElementById('action').textContent=r.ok?'Synchronisation acceptée.':await r.text();refresh();}}
setInterval(refresh,5000);
</script></body></html>"""
