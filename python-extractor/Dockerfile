FROM python:3.12-slim

WORKDIR /app

# Install system dependencies for pymupdf and Pillow
RUN apt-get update && apt-get install -y --no-install-recommends \
    libmupdf-dev \
    libjpeg62-turbo-dev \
    libpng-dev \
    libfreetype6-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5050

CMD ["gunicorn", "--bind", "0.0.0.0:5050", "--workers", "2", "--timeout", "120", "app:app"]
