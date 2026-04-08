# Design Extractor

Deterministic design parameter extraction from PDFs, images, and URLs. Returns a structured `design_system` JSON with colors, typography, spacing, page layout, and design classification.

No AI/LLM calls -- uses signal processing and heuristics for consistent output.

## Quick start

```bash
pip install -r requirements.txt
python app.py
```

Or with Docker:

```bash
docker build -t design-extractor .
docker run -p 5050:5050 design-extractor
```

## API

### `POST /extract`

Multipart form data. Send one or more files + optional URL.

```bash
curl -X POST http://localhost:5050/extract \
  -F "file=@report.pdf" \
  -F "file=@logo.png"
```

### `POST /extract-url`

JSON body with a URL.

```bash
curl -X POST http://localhost:5050/extract-url \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

### `GET /health`

Returns `{"status": "ok"}`.

## Output schema

```json
{
  "design_system": {
    "colors": {
      "primary": "#hex", "secondary": "#hex", "accent": "#hex",
      "text": "#hex", "text_light": "#hex",
      "bg": "#hex", "bg_alt": "#hex", "surface": "#hex"
    },
    "typography": {
      "heading_family": "Font, fallback",
      "body_family": "Font, fallback",
      "heading_weight": "700",
      "base_size_pt": 10.5,
      "line_height": 1.5,
      "scale": [42, 28, 20, 16, 13, 10.5, 9]
    },
    "spacing": {
      "base_mm": 5, "section_gap_mm": 15, "column_gap_mm": 8
    },
    "page": {
      "size": "A4",
      "margin_top_mm": 20, "margin_bottom_mm": 25,
      "margin_inner_mm": 25, "margin_outer_mm": 20
    },
    "design": {
      "hierarchy": "standard|editorial|data-dense",
      "rhythm": "airy|balanced|compact",
      "density": "airy|balanced|compact"
    }
  }
}
```
