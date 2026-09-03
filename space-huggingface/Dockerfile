FROM python:3.11-slim

# Install system dependencies including FreeCAD
RUN apt-get update && apt-get install -y --no-install-recommends \
    freecad \
    freecad-python3 \
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

EXPOSE 7860

CMD ["python", "app.py"]
