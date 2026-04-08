"""
Typography analyzer — classifies fonts from PDF extraction data into
heading/body roles and builds a typographic scale.
"""

import re
from collections import Counter, defaultdict


# Standard typographic scales for reference
STANDARD_SCALES = {
    "major_third": [42, 28, 20, 16, 13, 10.5, 9],
    "minor_third": [36, 25.6, 19.2, 16, 13.4, 11.2, 9.4],
    "perfect_fourth": [48, 32, 24, 18, 13.5, 10.1, 7.6],
    "augmented_fourth": [54, 36, 24, 16, 10.7, 7.1, 4.8],
}

# Common fallback stacks
FONT_FALLBACKS = {
    "serif": "Georgia, 'Times New Roman', serif",
    "sans": "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    "mono": "'Courier New', Courier, monospace",
    "display": "Impact, 'Arial Black', sans-serif",
}

# Weight name to number mapping
WEIGHT_MAP = {
    "thin": "100",
    "hairline": "100",
    "extralight": "200",
    "ultralight": "200",
    "light": "300",
    "regular": "400",
    "normal": "400",
    "medium": "500",
    "semibold": "600",
    "demibold": "600",
    "bold": "700",
    "extrabold": "800",
    "ultrabold": "800",
    "black": "900",
    "heavy": "900",
}


def analyze_typography(font_entries):
    """
    Analyze font usage data and build typography system.

    Args:
        font_entries: list of dicts with keys:
            - "family": str (font family name, may include weight suffix)
            - "size": float (point size)
            - "weight": str or int (font weight)
            - "count": int (number of characters/spans using this font)
            - "is_bold": bool (optional)
            - "is_italic": bool (optional)

    Returns:
        dict matching the typography schema:
        {
            "heading_family": "Font, fallback",
            "body_family": "Font, fallback",
            "heading_weight": "700",
            "base_size_pt": 10.5,
            "line_height": 1.5,
            "scale": [42, 28, 20, 16, 13, 10.5, 9]
        }
    """
    if not font_entries:
        return _default_typography()

    # Clean and normalize font entries
    normalized = _normalize_entries(font_entries)

    # Group by base family name (strip weight/style suffixes)
    families = _group_by_family(normalized)

    # Identify body font (most frequent by character count at common body sizes)
    body_family, body_size = _identify_body_font(families, normalized)

    # Identify heading font (used at larger sizes, or different family from body)
    heading_family, heading_weight = _identify_heading_font(
        families, normalized, body_family
    )

    # Build typographic scale from actual sizes found
    scale = _build_scale(normalized, body_size)

    # Estimate line height from size distribution
    line_height = _estimate_line_height(normalized, body_size)

    return {
        "heading_family": _build_family_string(heading_family),
        "body_family": _build_family_string(body_family),
        "heading_weight": heading_weight,
        "base_size_pt": round(body_size, 1),
        "line_height": round(line_height, 2),
        "scale": scale,
    }


def _default_typography():
    """Fallback typography when no fonts are extracted."""
    return {
        "heading_family": "Inter, -apple-system, sans-serif",
        "body_family": "Inter, -apple-system, sans-serif",
        "heading_weight": "700",
        "base_size_pt": 10.5,
        "line_height": 1.5,
        "scale": [42, 28, 20, 16, 13, 10.5, 9],
    }


def _normalize_entries(entries):
    """Normalize font entries: clean family names, parse weights."""
    result = []
    for entry in entries:
        family_raw = entry.get("family", "").strip()
        if not family_raw:
            continue

        base_family, detected_weight, detected_style = _parse_font_name(family_raw)

        weight = entry.get("weight", detected_weight or "400")
        if isinstance(weight, str) and weight.lower() in WEIGHT_MAP:
            weight = WEIGHT_MAP[weight.lower()]
        weight = str(weight)

        is_bold = entry.get("is_bold", False) or int(weight) >= 600
        is_italic = entry.get("is_italic", False) or detected_style == "italic"

        size = float(entry.get("size", 10))
        count = int(entry.get("count", 1))

        result.append(
            {
                "family": base_family,
                "family_raw": family_raw,
                "size": size,
                "weight": weight,
                "is_bold": is_bold,
                "is_italic": is_italic,
                "count": count,
            }
        )
    return result


def _parse_font_name(name):
    """
    Parse a font name like 'Helvetica-Bold' or 'Arial,BoldItalic' into
    (base_family, weight, style).
    """
    # Remove common prefixes added by PDF embedders
    name = re.sub(r"^[A-Z]{6}\+", "", name)  # e.g., ABCDEF+Helvetica

    # Split on common separators
    parts = re.split(r"[-,]", name)
    base = parts[0].strip()
    suffix = " ".join(parts[1:]).lower().strip() if len(parts) > 1 else ""

    weight = None
    style = None

    for w_name, w_val in WEIGHT_MAP.items():
        if w_name in suffix:
            weight = w_val
            break

    if "italic" in suffix or "oblique" in suffix:
        style = "italic"

    return base, weight, style


def _group_by_family(entries):
    """Group entries by base family name, aggregate stats."""
    families = defaultdict(lambda: {"total_count": 0, "sizes": [], "weights": set()})

    for entry in entries:
        fam = entry["family"]
        families[fam]["total_count"] += entry["count"]
        families[fam]["sizes"].append((entry["size"], entry["count"]))
        families[fam]["weights"].add(entry["weight"])

    return dict(families)


def _identify_body_font(families, entries):
    """
    Identify the body font — most frequent font at common body text sizes (8-14pt).
    """
    BODY_SIZE_MIN = 7.0
    BODY_SIZE_MAX = 14.0

    # Score each family by total count in body size range
    body_scores = {}
    for entry in entries:
        if BODY_SIZE_MIN <= entry["size"] <= BODY_SIZE_MAX:
            fam = entry["family"]
            body_scores[fam] = body_scores.get(fam, 0) + entry["count"]

    if body_scores:
        body_family = max(body_scores, key=body_scores.get)
    else:
        # Fall back to most frequent family overall
        body_family = max(families, key=lambda f: families[f]["total_count"])

    # Determine body size — most frequent size for this family in body range
    size_counts = Counter()
    for entry in entries:
        if entry["family"] == body_family and BODY_SIZE_MIN <= entry["size"] <= BODY_SIZE_MAX:
            # Round to nearest 0.5pt for grouping
            rounded = round(entry["size"] * 2) / 2
            size_counts[rounded] += entry["count"]

    if size_counts:
        body_size = size_counts.most_common(1)[0][0]
    else:
        # Use the most common size overall for this family
        all_sizes = Counter()
        for entry in entries:
            if entry["family"] == body_family:
                rounded = round(entry["size"] * 2) / 2
                all_sizes[rounded] += entry["count"]
        body_size = all_sizes.most_common(1)[0][0] if all_sizes else 10.5

    return body_family, body_size


def _identify_heading_font(families, entries, body_family):
    """
    Identify the heading font — different family used at larger sizes,
    or the body family if only one family is used.
    """
    # Collect fonts used at sizes > 14pt (heading range)
    heading_scores = {}
    heading_weights = {}

    for entry in entries:
        if entry["size"] > 14:
            fam = entry["family"]
            heading_scores[fam] = heading_scores.get(fam, 0) + entry["count"]
            # Track the most common weight for headings in this family
            if fam not in heading_weights:
                heading_weights[fam] = Counter()
            heading_weights[fam][entry["weight"]] += entry["count"]

    if heading_scores:
        heading_family = max(heading_scores, key=heading_scores.get)
        weight_counter = heading_weights.get(heading_family, Counter())
        heading_weight = weight_counter.most_common(1)[0][0] if weight_counter else "700"
    else:
        heading_family = body_family
        # Check if bold variants are used for this family
        bold_count = sum(
            e["count"]
            for e in entries
            if e["family"] == body_family and e["is_bold"]
        )
        heading_weight = "700" if bold_count > 0 else "600"

    return heading_family, heading_weight


def _build_scale(entries, body_size):
    """
    Build a typographic scale from actual sizes found in the document.
    Returns 7 values from largest to smallest.
    """
    # Collect all unique sizes
    size_counts = Counter()
    for entry in entries:
        rounded = round(entry["size"] * 2) / 2  # Round to 0.5pt
        size_counts[rounded] += entry["count"]

    unique_sizes = sorted(size_counts.keys(), reverse=True)

    if len(unique_sizes) >= 5:
        # Use actual sizes found, pick 7 representative values
        scale = _pick_scale_values(unique_sizes, body_size)
    else:
        # Too few sizes found — snap to nearest standard scale
        scale = _snap_to_standard_scale(body_size)

    # Ensure exactly 7 values, sorted descending
    scale = sorted(set(scale), reverse=True)

    # Pad or trim to 7
    if len(scale) > 7:
        # Keep first 6 and the body size
        top_6 = scale[:6]
        if body_size not in top_6:
            top_6.append(body_size)
        scale = sorted(set(top_6), reverse=True)[:7]

    while len(scale) < 7:
        # Add smaller sizes
        smallest = scale[-1]
        scale.append(round(smallest * 0.8, 1))

    return [round(s, 1) for s in scale[:7]]


def _pick_scale_values(sizes, body_size):
    """Pick 7 representative scale values from a list of sizes."""
    # Always include body size
    result = [body_size]

    # Sizes above body (headings)
    above = [s for s in sizes if s > body_size * 1.1]
    # Sizes below body (small text)
    below = [s for s in sizes if s < body_size * 0.9]

    # Pick up to 5 heading sizes (spread evenly)
    if len(above) >= 5:
        step = len(above) / 5
        for i in range(5):
            idx = int(i * step)
            result.append(above[idx])
    else:
        result.extend(above)

    # Pick 1 small text size
    if below:
        result.append(below[-1])  # Smallest

    return result


def _snap_to_standard_scale(body_size):
    """Find the standard scale closest to the detected body size."""
    best_scale = None
    best_diff = float("inf")

    for name, scale in STANDARD_SCALES.items():
        # Each standard scale has body at index 5 (10.5)
        standard_body = scale[5]
        ratio = body_size / standard_body
        # Scale the standard scale to match
        adjusted = [round(s * ratio, 1) for s in scale]
        diff = abs(adjusted[5] - body_size)
        if diff < best_diff:
            best_diff = diff
            best_scale = adjusted

    return best_scale or STANDARD_SCALES["major_third"]


def _estimate_line_height(entries, body_size):
    """
    Estimate line height from the document's spacing patterns.
    Returns a multiplier (e.g., 1.5).
    """
    # In PDF extraction, we don't always get explicit line-height.
    # Heuristic: based on body size
    if body_size <= 9:
        return 1.6  # Small text needs more leading
    elif body_size <= 11:
        return 1.5
    elif body_size <= 14:
        return 1.45
    else:
        return 1.4


def _build_family_string(family_name):
    """Build a CSS-style font family string with fallbacks."""
    if not family_name:
        return "Inter, -apple-system, sans-serif"

    name_lower = family_name.lower()

    # Detect if serif, sans-serif, or mono
    serif_indicators = [
        "times",
        "georgia",
        "garamond",
        "palatino",
        "cambria",
        "bookman",
        "didot",
        "bodoni",
        "caslon",
        "baskerville",
        "minion",
        "century",
        "charter",
    ]
    mono_indicators = ["courier", "mono", "consolas", "menlo", "fira code", "source code"]

    if any(ind in name_lower for ind in mono_indicators):
        fallback = FONT_FALLBACKS["mono"]
    elif any(ind in name_lower for ind in serif_indicators):
        fallback = FONT_FALLBACKS["serif"]
    else:
        fallback = FONT_FALLBACKS["sans"]

    # Quote family name if it contains spaces
    if " " in family_name:
        return f"'{family_name}', {fallback}"
    return f"{family_name}, {fallback}"
