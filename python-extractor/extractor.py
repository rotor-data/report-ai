"""
Core design extraction logic — deterministic extraction of design parameters
from PDFs, images, and URLs using signal processing and heuristics.
"""

import io
import re
import struct
from collections import Counter, defaultdict
from urllib.parse import urlparse

import fitz  # pymupdf
import pdfplumber
from colorthief import ColorThief
from PIL import Image

from color_classifier import classify_colors, hex_to_rgb, rgb_to_hex
from spacing_analyzer import analyze_spacing
from typography_analyzer import analyze_typography


def extract_from_pdf(file_bytes):
    """
    Extract a complete design_system from PDF bytes.

    Uses pymupdf for fonts, colors, and structure.
    Uses pdfplumber for layout geometry.

    Returns: design_system dict
    """
    # --- Phase 1: pymupdf extraction (fonts, colors, text) ---
    font_entries, color_entries, page_data_mupdf = _extract_with_pymupdf(file_bytes)

    # --- Phase 2: pdfplumber extraction (layout, geometry) ---
    page_data_plumber = _extract_with_pdfplumber(file_bytes)

    # --- Phase 3: Merge page data ---
    page_data = _merge_page_data(page_data_mupdf, page_data_plumber)

    # --- Phase 4: Extract embedded images for color analysis ---
    image_colors = _extract_image_colors(file_bytes)
    color_entries.extend(image_colors)

    # --- Phase 5: Classify ---
    colors = classify_colors(color_entries)
    typography = analyze_typography(font_entries)
    layout = analyze_spacing({"pages": page_data})

    return {
        "colors": colors,
        "typography": typography,
        "spacing": layout["spacing"],
        "page": layout["page"],
        "design": layout["design"],
    }


def extract_from_image(file_bytes):
    """
    Extract partial design_system from an image (colors + visual style).

    Returns: partial design_system dict (colors filled, rest are defaults)
    """
    color_entries = _analyze_image_colors(file_bytes)
    colors = classify_colors(color_entries)

    # Analyze image dimensions for page hints
    img = Image.open(io.BytesIO(file_bytes))
    width, height = img.size

    # Determine aspect ratio hint
    aspect = width / height if height else 1
    if 0.68 < aspect < 0.74:
        page_size = "A4"  # Portrait A4-ish
    elif 1.35 < aspect < 1.47:
        page_size = "A4"  # Landscape A4-ish
    elif 0.76 < aspect < 0.80:
        page_size = "Letter"
    else:
        page_size = "A4"

    return {
        "colors": colors,
        "typography": {
            "heading_family": "Inter, -apple-system, sans-serif",
            "body_family": "Inter, -apple-system, sans-serif",
            "heading_weight": "700",
            "base_size_pt": 10.5,
            "line_height": 1.5,
            "scale": [42, 28, 20, 16, 13, 10.5, 9],
        },
        "spacing": {"base_mm": 5, "section_gap_mm": 15, "column_gap_mm": 8},
        "page": {
            "size": page_size,
            "margin_top_mm": 20,
            "margin_bottom_mm": 25,
            "margin_inner_mm": 25,
            "margin_outer_mm": 20,
        },
        "design": {
            "hierarchy": "standard",
            "rhythm": "balanced",
            "density": "balanced",
        },
    }


def extract_from_url(url):
    """
    Extract design_system from a URL.
    Fetches the page content and attempts CSS extraction.
    Falls back to screenshot-based image extraction.

    Returns: design_system dict
    """
    import urllib.request

    parsed = urlparse(url)
    if not parsed.scheme:
        url = "https://" + url

    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            },
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            content_type = resp.headers.get("Content-Type", "")
            data = resp.read()

            # If it's a PDF, extract directly
            if "pdf" in content_type.lower() or url.lower().endswith(".pdf"):
                return extract_from_pdf(data)

            # If it's an image, extract colors
            if any(t in content_type.lower() for t in ["image/png", "image/jpeg", "image/webp"]):
                return extract_from_image(data)

            # It's HTML — extract colors from CSS
            html = data.decode("utf-8", errors="ignore")
            return _extract_from_html(html)

    except Exception as e:
        # Return defaults with error note
        return {
            "colors": {
                "primary": "#2563eb",
                "secondary": "#7c3aed",
                "accent": "#f59e0b",
                "text": "#111827",
                "text_light": "#6b7280",
                "bg": "#ffffff",
                "bg_alt": "#f3f4f6",
                "surface": "#f9fafb",
            },
            "typography": {
                "heading_family": "Inter, -apple-system, sans-serif",
                "body_family": "Inter, -apple-system, sans-serif",
                "heading_weight": "700",
                "base_size_pt": 10.5,
                "line_height": 1.5,
                "scale": [42, 28, 20, 16, 13, 10.5, 9],
            },
            "spacing": {"base_mm": 5, "section_gap_mm": 15, "column_gap_mm": 8},
            "page": {
                "size": "A4",
                "margin_top_mm": 20,
                "margin_bottom_mm": 25,
                "margin_inner_mm": 25,
                "margin_outer_mm": 20,
            },
            "design": {
                "hierarchy": "standard",
                "rhythm": "balanced",
                "density": "balanced",
            },
            "_error": str(e),
        }


def merge_extractions(sources):
    """
    Merge multiple extraction results into a final design_system.
    Prioritizes PDF for typography/spacing, images for colors.

    Args:
        sources: list of (source_type, design_system) tuples
            source_type: "pdf", "image", or "url"

    Returns: merged design_system dict
    """
    if not sources:
        return extract_from_image(b"")  # Returns defaults

    if len(sources) == 1:
        return sources[0][1]

    # Start with first PDF source, or first available
    result = None
    pdf_sources = [s for s in sources if s[0] == "pdf"]
    image_sources = [s for s in sources if s[0] == "image"]
    url_sources = [s for s in sources if s[0] == "url"]

    # Base: use PDF for structure/typography/spacing
    if pdf_sources:
        result = pdf_sources[0][1].copy()
    elif url_sources:
        result = url_sources[0][1].copy()
    else:
        result = image_sources[0][1].copy()

    # Override colors from image if available (usually more accurate for brand colors)
    if image_sources and pdf_sources:
        img_colors = image_sources[0][1].get("colors", {})
        pdf_colors = result.get("colors", {})

        # Use image colors for chromatic roles (primary, secondary, accent)
        # Keep PDF colors for text/bg roles
        result["colors"] = {
            "primary": img_colors.get("primary", pdf_colors.get("primary")),
            "secondary": img_colors.get("secondary", pdf_colors.get("secondary")),
            "accent": img_colors.get("accent", pdf_colors.get("accent")),
            "text": pdf_colors.get("text", img_colors.get("text")),
            "text_light": pdf_colors.get("text_light", img_colors.get("text_light")),
            "bg": pdf_colors.get("bg", img_colors.get("bg")),
            "bg_alt": pdf_colors.get("bg_alt", img_colors.get("bg_alt")),
            "surface": pdf_colors.get("surface", img_colors.get("surface")),
        }

    # Remove internal keys
    result.pop("_error", None)

    return result


# ---------------------------------------------------------------------------
# Internal: pymupdf extraction
# ---------------------------------------------------------------------------


def _extract_with_pymupdf(file_bytes):
    """
    Extract fonts, colors, and basic structure using pymupdf (fitz).

    Returns: (font_entries, color_entries, page_data)
    """
    doc = fitz.open(stream=file_bytes, filetype="pdf")

    font_entries = []
    color_entries = []
    page_data = []

    for page_num in range(len(doc)):
        page = doc[page_num]
        width = page.rect.width
        height = page.rect.height

        text_blocks = []

        # Extract text with font info using get_text("dict")
        page_dict = page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE)

        for block in page_dict.get("blocks", []):
            if block["type"] != 0:  # 0 = text block
                continue

            block_x0 = block["bbox"][0]
            block_y0 = block["bbox"][1]
            block_x1 = block["bbox"][2]
            block_y1 = block["bbox"][3]
            block_text = ""
            block_font_size = None

            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    text = span.get("text", "").strip()
                    if not text:
                        continue

                    font_name = span.get("font", "")
                    font_size = span.get("size", 10)
                    font_flags = span.get("flags", 0)
                    color_int = span.get("color", 0)

                    # Track font usage
                    is_bold = bool(font_flags & 2**4)  # bit 4 = bold
                    is_italic = bool(font_flags & 2**1)  # bit 1 = italic

                    char_count = len(text)
                    font_entries.append(
                        {
                            "family": font_name,
                            "size": font_size,
                            "weight": "700" if is_bold else "400",
                            "is_bold": is_bold,
                            "is_italic": is_italic,
                            "count": char_count,
                        }
                    )

                    # Extract text color
                    hex_color = _int_to_hex(color_int)
                    color_entries.append(
                        {
                            "hex": hex_color,
                            "count": char_count,
                            "context": "text",
                        }
                    )

                    block_text += text + " "
                    if block_font_size is None:
                        block_font_size = font_size

            text_blocks.append(
                {
                    "x0": block_x0,
                    "y0": block_y0,
                    "x1": block_x1,
                    "y1": block_y1,
                    "text": block_text.strip(),
                    "font_size": block_font_size,
                }
            )

        # Extract drawings (rectangles, lines) for colors and rules
        drawings = page.get_drawings()
        for d in drawings:
            fill_color = d.get("fill")
            stroke_color = d.get("color")

            if fill_color and isinstance(fill_color, (tuple, list)):
                hex_c = _color_tuple_to_hex(fill_color)
                if hex_c:
                    # Estimate area for weighting
                    rect = d.get("rect")
                    area = 1
                    if rect:
                        area = max(1, int((rect[2] - rect[0]) * (rect[3] - rect[1])))
                    color_entries.append(
                        {"hex": hex_c, "count": area, "context": "fill"}
                    )

            if stroke_color and isinstance(stroke_color, (tuple, list)):
                hex_c = _color_tuple_to_hex(stroke_color)
                if hex_c:
                    color_entries.append(
                        {"hex": hex_c, "count": 1, "context": "stroke"}
                    )

        # Collect image positions
        image_list = []
        for img in page.get_images(full=True):
            xref = img[0]
            try:
                img_rects = page.get_image_rects(xref)
                for rect in img_rects:
                    image_list.append(
                        {
                            "x0": rect.x0,
                            "y0": rect.y0,
                            "x1": rect.x1,
                            "y1": rect.y1,
                        }
                    )
            except Exception:
                pass

        page_data.append(
            {
                "width_pt": width,
                "height_pt": height,
                "text_blocks": text_blocks,
                "images": image_list,
                "lines": [],  # Will be filled from pdfplumber
            }
        )

    doc.close()
    return font_entries, color_entries, page_data


def _extract_with_pdfplumber(file_bytes):
    """
    Extract layout geometry using pdfplumber.

    Returns: list of page dicts with text_blocks, lines.
    """
    page_data = []

    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        for page in pdf.pages:
            width = page.width
            height = page.height

            text_blocks = []

            # Extract words with positions
            words = page.extract_words(
                x_tolerance=3, y_tolerance=3, keep_blank_chars=False
            )

            # Group words into lines/blocks by y-position proximity
            if words:
                blocks = _group_words_into_blocks(words)
                for block in blocks:
                    text_blocks.append(
                        {
                            "x0": block["x0"],
                            "y0": block["top"],
                            "x1": block["x1"],
                            "y1": block["bottom"],
                            "text": block["text"],
                        }
                    )

            # Extract lines (rules)
            lines = []
            for line in page.lines or []:
                lines.append(
                    {
                        "x0": line.get("x0", 0),
                        "y0": line.get("top", 0),
                        "x1": line.get("x1", 0),
                        "y1": line.get("bottom", 0),
                    }
                )

            # Extract rectangles as potential background/fill areas
            for rect in page.rects or []:
                fill = rect.get("non_stroking_color")
                if fill and isinstance(fill, (tuple, list)):
                    # These contribute to color extraction but we handle that in pymupdf
                    pass

            page_data.append(
                {
                    "width_pt": width,
                    "height_pt": height,
                    "text_blocks": text_blocks,
                    "lines": lines,
                    "images": [],
                }
            )

    return page_data


def _group_words_into_blocks(words):
    """
    Group pdfplumber words into text blocks based on proximity.
    """
    if not words:
        return []

    # Sort by vertical then horizontal position
    sorted_words = sorted(words, key=lambda w: (round(w["top"], 0), w["x0"]))

    blocks = []
    current_block = {
        "x0": sorted_words[0]["x0"],
        "top": sorted_words[0]["top"],
        "x1": sorted_words[0]["x1"],
        "bottom": sorted_words[0]["bottom"],
        "text": sorted_words[0]["text"],
    }

    for word in sorted_words[1:]:
        # Same block if vertically close (within ~1.5x font height)
        v_gap = word["top"] - current_block["bottom"]
        line_height = current_block["bottom"] - current_block["top"]
        threshold = max(5, line_height * 0.8)

        # Check if this is part of the same block
        if v_gap < threshold and abs(word["x0"] - current_block["x0"]) < 50:
            current_block["x1"] = max(current_block["x1"], word["x1"])
            current_block["bottom"] = max(current_block["bottom"], word["bottom"])
            current_block["text"] += " " + word["text"]
        else:
            blocks.append(current_block)
            current_block = {
                "x0": word["x0"],
                "top": word["top"],
                "x1": word["x1"],
                "bottom": word["bottom"],
                "text": word["text"],
            }

    blocks.append(current_block)
    return blocks


def _merge_page_data(mupdf_pages, plumber_pages):
    """
    Merge page data from pymupdf and pdfplumber.
    Prefers pymupdf text blocks (has font info) but adds pdfplumber lines.
    """
    result = []
    for i in range(max(len(mupdf_pages), len(plumber_pages))):
        if i < len(mupdf_pages):
            page = mupdf_pages[i].copy()
            if i < len(plumber_pages):
                # Add lines from pdfplumber
                page["lines"] = plumber_pages[i].get("lines", [])
            result.append(page)
        elif i < len(plumber_pages):
            result.append(plumber_pages[i])

    return result


def _extract_image_colors(file_bytes):
    """
    Extract colors from images embedded in the PDF.
    """
    color_entries = []

    try:
        doc = fitz.open(stream=file_bytes, filetype="pdf")

        for page_num in range(min(len(doc), 5)):  # Limit to first 5 pages
            page = doc[page_num]
            image_list = page.get_images(full=True)

            for img_info in image_list[:5]:  # Limit images per page
                xref = img_info[0]
                try:
                    base_image = doc.extract_image(xref)
                    if not base_image:
                        continue

                    image_bytes = base_image["image"]
                    if len(image_bytes) < 100:
                        continue

                    # Use colorthief on the extracted image
                    img_colors = _get_dominant_colors(image_bytes, count=5)
                    for hex_color, proportion in img_colors:
                        color_entries.append(
                            {
                                "hex": hex_color,
                                "count": max(1, int(proportion * 100)),
                                "context": "image",
                            }
                        )
                except Exception:
                    continue

        doc.close()
    except Exception:
        pass

    return color_entries


def _analyze_image_colors(file_bytes):
    """
    Analyze colors from a standalone image file.
    """
    color_entries = []

    # Get dominant colors using colorthief
    dominant_colors = _get_dominant_colors(file_bytes, count=10)
    for hex_color, proportion in dominant_colors:
        color_entries.append(
            {
                "hex": hex_color,
                "count": max(1, int(proportion * 1000)),
                "context": "fill",
            }
        )

    # Analyze image regions for background detection
    try:
        img = Image.open(io.BytesIO(file_bytes)).convert("RGB")
        w, h = img.size

        # Sample corners for background color detection
        corner_size = max(10, min(w, h) // 20)
        corners = [
            (0, 0, corner_size, corner_size),  # top-left
            (w - corner_size, 0, w, corner_size),  # top-right
            (0, h - corner_size, corner_size, h),  # bottom-left
            (w - corner_size, h - corner_size, w, h),  # bottom-right
        ]

        corner_colors = Counter()
        for box in corners:
            region = img.crop(box)
            pixels = list(region.getdata())
            for r, g, b in pixels:
                # Quantize to reduce noise
                qr = round(r / 16) * 16
                qg = round(g / 16) * 16
                qb = round(b / 16) * 16
                corner_colors[(min(255, qr), min(255, qg), min(255, qb))] += 1

        # Most common corner color is likely background
        if corner_colors:
            bg_rgb = corner_colors.most_common(1)[0][0]
            color_entries.append(
                {
                    "hex": rgb_to_hex(*bg_rgb),
                    "count": 5000,  # High weight for background
                    "context": "background",
                }
            )

    except Exception:
        pass

    return color_entries


def _get_dominant_colors(image_bytes, count=8):
    """
    Extract dominant colors using ColorThief.
    Returns list of (hex_color, proportion) tuples.
    """
    try:
        ct = ColorThief(io.BytesIO(image_bytes))
        palette = ct.get_palette(color_count=count, quality=5)

        # Estimate proportions by sampling (ColorThief doesn't provide them)
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        img_small = img.resize((100, 100), Image.Resampling.LANCZOS)
        pixels = list(img_small.getdata())
        total = len(pixels)

        color_counts = Counter()
        for pixel in pixels:
            # Find closest palette color
            min_dist = float("inf")
            closest = palette[0]
            for pc in palette:
                dist = sum((a - b) ** 2 for a, b in zip(pixel, pc))
                if dist < min_dist:
                    min_dist = dist
                    closest = pc
            color_counts[closest] += 1

        result = []
        for color, cnt in color_counts.most_common(count):
            r, g, b = color
            result.append((rgb_to_hex(r, g, b), cnt / total))

        return result

    except Exception:
        return []


def _extract_from_html(html):
    """
    Extract design signals from HTML/CSS content.
    Parses inline styles, style tags, and common patterns.
    """
    color_entries = []
    font_entries = []

    # Extract hex colors from CSS
    hex_pattern = re.compile(r"#([0-9a-fA-F]{3,8})\b")
    for match in hex_pattern.finditer(html):
        hex_val = match.group(1)
        if len(hex_val) in (3, 6):
            if len(hex_val) == 3:
                hex_val = "".join(c * 2 for c in hex_val)
            color_entries.append(
                {"hex": f"#{hex_val}", "count": 1, "context": "fill"}
            )

    # Extract rgb/rgba colors
    rgb_pattern = re.compile(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)")
    for match in rgb_pattern.finditer(html):
        r, g, b = int(match.group(1)), int(match.group(2)), int(match.group(3))
        color_entries.append(
            {"hex": rgb_to_hex(r, g, b), "count": 1, "context": "fill"}
        )

    # Extract font families
    font_pattern = re.compile(r"font-family\s*:\s*([^;}\n]+)")
    for match in font_pattern.finditer(html):
        families = match.group(1).strip().strip("\"'")
        primary_font = families.split(",")[0].strip().strip("\"'")
        if primary_font:
            font_entries.append(
                {
                    "family": primary_font,
                    "size": 16,  # Assume default web size
                    "weight": "400",
                    "count": 1,
                }
            )

    # Extract font sizes
    size_pattern = re.compile(r"font-size\s*:\s*(\d+(?:\.\d+)?)\s*(px|pt|rem|em)")
    for match in size_pattern.finditer(html):
        size = float(match.group(1))
        unit = match.group(2)
        if unit == "px":
            size = size * 0.75  # px to pt
        elif unit in ("rem", "em"):
            size = size * 12  # Assume 16px = 12pt base
        font_entries.append(
            {"family": "", "size": size, "weight": "400", "count": 1}
        )

    colors = classify_colors(color_entries)
    typography = analyze_typography(font_entries) if font_entries else None

    result = {
        "colors": colors,
        "typography": typography
        or {
            "heading_family": "Inter, -apple-system, sans-serif",
            "body_family": "Inter, -apple-system, sans-serif",
            "heading_weight": "700",
            "base_size_pt": 10.5,
            "line_height": 1.5,
            "scale": [42, 28, 20, 16, 13, 10.5, 9],
        },
        "spacing": {"base_mm": 5, "section_gap_mm": 15, "column_gap_mm": 8},
        "page": {
            "size": "A4",
            "margin_top_mm": 20,
            "margin_bottom_mm": 25,
            "margin_inner_mm": 25,
            "margin_outer_mm": 20,
        },
        "design": {
            "hierarchy": "standard",
            "rhythm": "balanced",
            "density": "balanced",
        },
    }

    return result


# ---------------------------------------------------------------------------
# Color conversion helpers
# ---------------------------------------------------------------------------


def _int_to_hex(color_int):
    """Convert pymupdf integer color to hex string."""
    if color_int == 0:
        return "#000000"
    r = (color_int >> 16) & 0xFF
    g = (color_int >> 8) & 0xFF
    b = color_int & 0xFF
    return rgb_to_hex(r, g, b)


def _color_tuple_to_hex(color_tuple):
    """
    Convert a color tuple (pymupdf uses 0-1 float RGB) to hex.
    Handles both (r, g, b) and (c, m, y, k) formats.
    """
    if not color_tuple:
        return None

    if len(color_tuple) == 3:
        r, g, b = color_tuple
        # pymupdf uses 0-1 floats
        if all(isinstance(v, float) and 0 <= v <= 1.0 for v in (r, g, b)):
            return rgb_to_hex(int(r * 255), int(g * 255), int(b * 255))
        elif all(isinstance(v, int) and 0 <= v <= 255 for v in (r, g, b)):
            return rgb_to_hex(r, g, b)

    elif len(color_tuple) == 4:
        # CMYK
        c, m, y, k = color_tuple
        r = int(255 * (1 - c) * (1 - k))
        g = int(255 * (1 - m) * (1 - k))
        b = int(255 * (1 - y) * (1 - k))
        return rgb_to_hex(r, g, b)

    elif len(color_tuple) == 1:
        # Grayscale
        v = color_tuple[0]
        if isinstance(v, float) and 0 <= v <= 1.0:
            gray = int(v * 255)
        else:
            gray = int(v)
        return rgb_to_hex(gray, gray, gray)

    return None
