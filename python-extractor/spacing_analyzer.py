"""
Spacing analyzer — extracts layout measurements from PDF page geometry
and classifies the document's spatial rhythm and density.
"""

import statistics
from collections import Counter


# Standard page sizes in mm
PAGE_SIZES = {
    "A4": (210, 297),
    "A3": (297, 420),
    "A5": (148, 210),
    "Letter": (215.9, 279.4),
    "Legal": (215.9, 355.6),
    "Tabloid": (279.4, 431.8),
}

# Points to mm conversion
PT_TO_MM = 25.4 / 72.0
PX_TO_MM = 25.4 / 96.0


def analyze_spacing(page_data):
    """
    Analyze spacing and layout from PDF page geometry.

    Args:
        page_data: dict with keys:
            - "pages": list of page dicts, each with:
                - "width_pt": float
                - "height_pt": float
                - "text_blocks": list of dicts with:
                    - "x0", "y0", "x1", "y1": float (bounding box in points)
                    - "text": str
                    - "font_size": float (optional)
                - "lines": list of dicts (horizontal/vertical rules) with:
                    - "x0", "y0", "x1", "y1": float
                - "images": list of dicts with:
                    - "x0", "y0", "x1", "y1": float

    Returns:
        dict with spacing, page, and design classification:
        {
            "spacing": {
                "base_mm": 5,
                "section_gap_mm": 15,
                "column_gap_mm": 8
            },
            "page": {
                "size": "A4",
                "margin_top_mm": 20,
                "margin_bottom_mm": 25,
                "margin_inner_mm": 25,
                "margin_outer_mm": 20
            },
            "design": {
                "hierarchy": "standard",
                "rhythm": "balanced",
                "density": "balanced"
            }
        }
    """
    if not page_data or not page_data.get("pages"):
        return _default_spacing()

    pages = page_data["pages"]

    # Analyze page size
    page_info = _analyze_page_size(pages)

    # Analyze margins across all pages
    margins = _analyze_margins(pages)

    # Analyze spacing patterns (gaps between text blocks)
    spacing = _analyze_block_spacing(pages)

    # Analyze column structure
    column_gap = _analyze_columns(pages)

    # Classify the design
    design = _classify_design(pages, margins, spacing)

    return {
        "spacing": {
            "base_mm": round(spacing["base_gap_mm"], 0),
            "section_gap_mm": round(spacing["section_gap_mm"], 0),
            "column_gap_mm": round(column_gap, 0),
        },
        "page": {
            "size": page_info["size"],
            "margin_top_mm": round(margins["top_mm"], 0),
            "margin_bottom_mm": round(margins["bottom_mm"], 0),
            "margin_inner_mm": round(margins["inner_mm"], 0),
            "margin_outer_mm": round(margins["outer_mm"], 0),
        },
        "design": design,
    }


def _default_spacing():
    """Fallback spacing when no page data is available."""
    return {
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


def _analyze_page_size(pages):
    """Determine page size from dimensions."""
    if not pages:
        return {"size": "A4"}

    # Use first page dimensions
    width_pt = pages[0].get("width_pt", 595)  # A4 default
    height_pt = pages[0].get("height_pt", 842)

    width_mm = width_pt * PT_TO_MM
    height_mm = height_pt * PT_TO_MM

    # Match to closest standard size
    best_match = "A4"
    best_diff = float("inf")

    for name, (w, h) in PAGE_SIZES.items():
        # Check both orientations
        diff_portrait = abs(width_mm - w) + abs(height_mm - h)
        diff_landscape = abs(width_mm - h) + abs(height_mm - w)
        diff = min(diff_portrait, diff_landscape)
        if diff < best_diff:
            best_diff = diff
            best_match = name

    return {"size": best_match}


def _analyze_margins(pages):
    """
    Measure margins by finding the content bounding box across pages.
    Uses the innermost content edges to determine margins.
    """
    all_left = []
    all_right = []
    all_top = []
    all_bottom = []

    for page in pages:
        width_pt = page.get("width_pt", 595)
        height_pt = page.get("height_pt", 842)
        blocks = page.get("text_blocks", [])

        if not blocks:
            continue

        # Find content edges
        left_edges = [b["x0"] for b in blocks if b.get("x0") is not None]
        right_edges = [b["x1"] for b in blocks if b.get("x1") is not None]
        top_edges = [b["y0"] for b in blocks if b.get("y0") is not None]
        bottom_edges = [b["y1"] for b in blocks if b.get("y1") is not None]

        if left_edges:
            # Use 10th percentile to ignore outlier elements (page numbers, etc.)
            all_left.append(_percentile(sorted(left_edges), 10))
        if right_edges:
            all_right.append(width_pt - _percentile(sorted(right_edges), 90))
        if top_edges:
            all_top.append(_percentile(sorted(top_edges), 10))
        if bottom_edges:
            all_bottom.append(height_pt - _percentile(sorted(bottom_edges), 90))

    if not all_left:
        return {"top_mm": 20, "bottom_mm": 25, "inner_mm": 25, "outer_mm": 20}

    return {
        "top_mm": max(5, statistics.median(all_top) * PT_TO_MM),
        "bottom_mm": max(5, statistics.median(all_bottom) * PT_TO_MM),
        "inner_mm": max(5, statistics.median(all_left) * PT_TO_MM),
        "outer_mm": max(5, statistics.median(all_right) * PT_TO_MM),
    }


def _percentile(sorted_data, p):
    """Calculate the p-th percentile of sorted data."""
    if not sorted_data:
        return 0
    k = (len(sorted_data) - 1) * p / 100.0
    f = int(k)
    c = f + 1
    if c >= len(sorted_data):
        return sorted_data[f]
    d = k - f
    return sorted_data[f] + d * (sorted_data[c] - sorted_data[f])


def _analyze_block_spacing(pages):
    """
    Measure vertical gaps between consecutive text blocks to determine
    base spacing and section gaps.
    """
    all_gaps = []

    for page in pages:
        blocks = page.get("text_blocks", [])
        if len(blocks) < 2:
            continue

        # Sort blocks by vertical position (top to bottom)
        sorted_blocks = sorted(blocks, key=lambda b: (b.get("y0", 0), b.get("x0", 0)))

        for i in range(1, len(sorted_blocks)):
            prev = sorted_blocks[i - 1]
            curr = sorted_blocks[i]

            # Only measure gaps between vertically adjacent blocks
            # (ignore blocks that are side by side in columns)
            prev_x_range = (prev.get("x0", 0), prev.get("x1", 0))
            curr_x_range = (curr.get("x0", 0), curr.get("x1", 0))

            # Check horizontal overlap
            overlap = min(prev_x_range[1], curr_x_range[1]) - max(
                prev_x_range[0], curr_x_range[0]
            )
            if overlap < 20:  # Less than 20pt overlap = different columns
                continue

            gap = curr.get("y0", 0) - prev.get("y1", 0)
            if 0 < gap < 200:  # Reasonable gap range
                all_gaps.append(gap * PT_TO_MM)

    if not all_gaps:
        return {"base_gap_mm": 5, "section_gap_mm": 15}

    # Cluster gaps into "paragraph" and "section" groups
    sorted_gaps = sorted(all_gaps)
    median_gap = statistics.median(sorted_gaps)

    # Base gap = median of gaps below 2x median (paragraph spacing)
    paragraph_gaps = [g for g in sorted_gaps if g < median_gap * 2]
    section_gaps = [g for g in sorted_gaps if g >= median_gap * 2]

    base_gap = statistics.median(paragraph_gaps) if paragraph_gaps else median_gap
    section_gap = statistics.median(section_gaps) if section_gaps else base_gap * 3

    # Clamp to reasonable values
    base_gap = max(2, min(15, base_gap))
    section_gap = max(base_gap * 2, min(40, section_gap))

    return {"base_gap_mm": base_gap, "section_gap_mm": section_gap}


def _analyze_columns(pages):
    """
    Detect column structure by analyzing horizontal position clustering
    of text blocks.
    """
    all_x_starts = []
    all_x_gaps = []

    for page in pages:
        blocks = page.get("text_blocks", [])
        if not blocks:
            continue

        # Collect left edges of text blocks
        x_starts = sorted(set(round(b.get("x0", 0), 0) for b in blocks))

        if len(x_starts) < 2:
            continue

        all_x_starts.extend(x_starts)

        # Cluster x positions — look for distinct columns
        # Group positions within 10pt of each other
        clusters = []
        current_cluster = [x_starts[0]]
        for x in x_starts[1:]:
            if x - current_cluster[-1] < 15:
                current_cluster.append(x)
            else:
                clusters.append(statistics.median(current_cluster))
                current_cluster = [x]
        clusters.append(statistics.median(current_cluster))

        # If we found multiple column starts, measure the gaps
        if len(clusters) >= 2:
            # Look for right edges near the gap between columns
            right_edges_by_col = []
            for i, col_x in enumerate(clusters[:-1]):
                next_col_x = clusters[i + 1]
                # Find blocks ending near this column's right edge
                col_rights = [
                    b.get("x1", 0)
                    for b in blocks
                    if abs(b.get("x0", 0) - col_x) < 15
                ]
                if col_rights:
                    col_right = max(col_rights)
                    gap = (next_col_x - col_right) * PT_TO_MM
                    if 2 < gap < 40:
                        all_x_gaps.append(gap)

    if all_x_gaps:
        return statistics.median(all_x_gaps)

    return 8  # Default column gap


def _classify_design(pages, margins, spacing_data):
    """
    Classify the document's design characteristics:
    - hierarchy: standard | editorial | data-dense
    - rhythm: airy | balanced | compact
    - density: airy | balanced | compact
    """
    hierarchy = _classify_hierarchy(pages)
    rhythm = _classify_rhythm(spacing_data, margins)
    density = _classify_density(pages, margins)

    return {
        "hierarchy": hierarchy,
        "rhythm": rhythm,
        "density": density,
    }


def _classify_hierarchy(pages):
    """
    Classify hierarchy based on font size variation.
    - editorial: large size range, dramatic headlines
    - data-dense: small size range, many similar-sized elements
    - standard: moderate size range
    """
    all_sizes = []
    for page in pages:
        for block in page.get("text_blocks", []):
            size = block.get("font_size")
            if size:
                all_sizes.append(size)

    if not all_sizes:
        return "standard"

    size_range = max(all_sizes) - min(all_sizes)
    unique_sizes = len(set(round(s) for s in all_sizes))

    if size_range > 24:
        return "editorial"  # Large headlines, dramatic contrast
    elif size_range < 6 or unique_sizes <= 3:
        return "data-dense"  # Minimal size variation
    else:
        return "standard"


def _classify_rhythm(spacing_data, margins):
    """
    Classify rhythm based on spacing ratios.
    - airy: generous spacing, large margins
    - compact: tight spacing, small margins
    - balanced: moderate
    """
    base_gap = spacing_data.get("base_gap_mm", 5)
    margin_avg = (
        margins.get("top_mm", 20)
        + margins.get("bottom_mm", 25)
        + margins.get("inner_mm", 25)
        + margins.get("outer_mm", 20)
    ) / 4

    # Score: higher = more spacious
    spaciousness = (base_gap / 5.0) * 0.5 + (margin_avg / 22.0) * 0.5

    if spaciousness > 1.3:
        return "airy"
    elif spaciousness < 0.7:
        return "compact"
    else:
        return "balanced"


def _classify_density(pages, margins):
    """
    Classify density based on text-to-whitespace ratio.
    """
    total_content_area = 0
    total_page_area = 0

    for page in pages:
        width_pt = page.get("width_pt", 595)
        height_pt = page.get("height_pt", 842)
        page_area = width_pt * height_pt
        total_page_area += page_area

        blocks = page.get("text_blocks", [])
        for block in blocks:
            x0 = block.get("x0", 0)
            y0 = block.get("y0", 0)
            x1 = block.get("x1", 0)
            y1 = block.get("y1", 0)
            area = max(0, (x1 - x0)) * max(0, (y1 - y0))
            total_content_area += area

        # Also count images
        for img in page.get("images", []):
            x0 = img.get("x0", 0)
            y0 = img.get("y0", 0)
            x1 = img.get("x1", 0)
            y1 = img.get("y1", 0)
            area = max(0, (x1 - x0)) * max(0, (y1 - y0))
            total_content_area += area

    if total_page_area == 0:
        return "balanced"

    fill_ratio = total_content_area / total_page_area

    if fill_ratio > 0.55:
        return "compact"
    elif fill_ratio < 0.30:
        return "airy"
    else:
        return "balanced"
