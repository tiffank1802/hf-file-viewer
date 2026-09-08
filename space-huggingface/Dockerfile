FROM python:3.11-slim

# Install system dependencies: FreeCAD (sldprt → stl) and headless
# LibreOffice (office documents → pdf). Liberation/DejaVu fonts improve the
# fidelity of converted Office documents.
RUN apt-get update && apt-get install -y --no-install-recommends \
    freecad \
    freecad-python3 \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    fonts-dejavu \
    fonts-liberation \
    libgl1-mesa-glx \
    libegl1-mesa \
    libxrender1 \
    libxi6 \
    libxcursor1 \
    libxcomposite1 \
    libxdamage1 \
    libxtst6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY freecad_convert.py .
COPY freecad_cad_convert.py .

EXPOSE 7860

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
