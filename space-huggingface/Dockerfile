FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/data/hf-cache \
    DOCLING_CACHE_DIR=/data/docling-cache \
    WORKSPACE_DIR=/tmp/enise-reader

# Runtime libraries used by Docling's PDF/image and OCR stack.  Deliberately no
# LibreOffice, FreeCAD, CAD or SolidWorks component is installed in this image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      libgl1 \
      libglib2.0-0 \
      libgomp1 \
      libjpeg62-turbo \
      libpng16-16 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/hf-cache /data/docling-cache /tmp/enise-reader

WORKDIR /app
COPY requirements.txt .
# Install CPU-only PyTorch first. PyPI's generic wheel now pulls several GB of
# CUDA libraries that are unusable on the cpu-basic Space.
RUN pip install --upgrade pip setuptools wheel \
    && pip install --index-url https://download.pytorch.org/whl/cpu \
         torch==2.14.0 torchvision==0.29.0 \
    && pip install -r requirements.txt

COPY app.py reader_pipeline.py README.md ./

# Hugging Face Docker Spaces route traffic to port 7860.  A single worker is
# required: each process would otherwise launch its own background scheduler.
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7860/api/health', timeout=4)" || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860", "--workers", "1"]
