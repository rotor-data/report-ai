"""
Flask API for the design extraction service.
"""

import io
import json
import traceback

from flask import Flask, jsonify, request

from extractor import extract_from_image, extract_from_pdf, extract_from_url, merge_extractions

app = Flask(__name__)

# Max upload size: 50 MB
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint."""
    return jsonify({"status": "ok", "service": "design-extractor", "version": "1.0.0"})


@app.route("/extract", methods=["POST"])
def extract():
    """
    Extract design system from uploaded file(s) and/or URL.

    Accepts multipart form data with:
    - file: one or more files (PDF, PNG, JPG)
    - url: optional URL string

    Returns: design_system JSON
    """
    try:
        sources = []

        # Process uploaded files
        files = request.files.getlist("file")
        for f in files:
            if not f or not f.filename:
                continue

            file_bytes = f.read()
            if not file_bytes:
                continue

            filename = f.filename.lower()
            content_type = f.content_type or ""

            if filename.endswith(".pdf") or "pdf" in content_type:
                result = extract_from_pdf(file_bytes)
                sources.append(("pdf", result))
            elif any(
                filename.endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".webp")
            ) or "image" in content_type:
                result = extract_from_image(file_bytes)
                sources.append(("image", result))
            else:
                # Try as PDF first, fall back to image
                try:
                    result = extract_from_pdf(file_bytes)
                    sources.append(("pdf", result))
                except Exception:
                    try:
                        result = extract_from_image(file_bytes)
                        sources.append(("image", result))
                    except Exception:
                        pass

        # Process URL if provided
        url = request.form.get("url")
        if url:
            result = extract_from_url(url)
            sources.append(("url", result))

        if not sources:
            return (
                jsonify(
                    {
                        "error": "No valid files or URL provided. "
                        "Send PDF, PNG, or JPG files as multipart 'file' field, "
                        "or provide a 'url' field."
                    }
                ),
                400,
            )

        # Merge all sources
        design_system = merge_extractions(sources)

        return jsonify(
            {
                "design_system": design_system,
                "sources": len(sources),
                "source_types": [s[0] for s in sources],
            }
        )

    except Exception as e:
        return (
            jsonify({"error": str(e), "traceback": traceback.format_exc()}),
            500,
        )


@app.route("/extract-url", methods=["POST"])
def extract_url():
    """
    Extract design system from a URL.

    Accepts JSON: { "url": "https://..." }

    Returns: design_system JSON
    """
    try:
        data = request.get_json(force=True)
        url = data.get("url")

        if not url:
            return jsonify({"error": "Missing 'url' in request body"}), 400

        result = extract_from_url(url)

        return jsonify(
            {
                "design_system": result,
                "sources": 1,
                "source_types": ["url"],
            }
        )

    except Exception as e:
        return (
            jsonify({"error": str(e), "traceback": traceback.format_exc()}),
            500,
        )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5050, debug=True)
