"""
Color role assignment — deterministic classification of extracted colors
into design system roles based on luminance, saturation, frequency, and contrast.
"""

import colorsys
import math


def hex_to_rgb(hex_color):
    """Convert hex color string to RGB tuple (0-255)."""
    hex_color = hex_color.lstrip("#")
    if len(hex_color) == 3:
        hex_color = "".join(c * 2 for c in hex_color)
    return tuple(int(hex_color[i : i + 2], 16) for i in (0, 2, 4))


def rgb_to_hex(r, g, b):
    """Convert RGB tuple to hex string."""
    return "#{:02x}{:02x}{:02x}".format(int(r), int(g), int(b))


def relative_luminance(r, g, b):
    """Calculate relative luminance per WCAG 2.1 (0.0 = black, 1.0 = white)."""

    def linearize(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)


def contrast_ratio(lum1, lum2):
    """WCAG contrast ratio between two luminance values."""
    lighter = max(lum1, lum2)
    darker = min(lum1, lum2)
    return (lighter + 0.05) / (darker + 0.05)


def color_distance(rgb1, rgb2):
    """Euclidean distance in RGB space."""
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(rgb1, rgb2)))


def get_hsl(r, g, b):
    """Get HSL values. Returns (hue 0-360, saturation 0-1, lightness 0-1)."""
    h, l, s = colorsys.rgb_to_hls(r / 255.0, g / 255.0, b / 255.0)
    return h * 360, s, l


def is_near_grayscale(r, g, b, threshold=15):
    """Check if a color is near grayscale (low saturation in RGB terms)."""
    return max(r, g, b) - min(r, g, b) < threshold


def classify_colors(color_entries):
    """
    Classify a list of color entries into design system roles.

    Args:
        color_entries: list of dicts with keys:
            - "hex": "#rrggbb"
            - "count": int (frequency/area)
            - "context": str, one of "text", "background", "fill", "stroke", "image"

    Returns:
        dict with roles: primary, secondary, accent, text, text_light, bg, bg_alt, surface
    """
    if not color_entries:
        return _default_palette()

    # Deduplicate very similar colors (distance < 20)
    deduped = _deduplicate_colors(color_entries)

    # Separate into chromatic and achromatic
    chromatic = []
    achromatic = []
    for entry in deduped:
        rgb = hex_to_rgb(entry["hex"])
        if is_near_grayscale(*rgb):
            achromatic.append(entry)
        else:
            chromatic.append(entry)

    # Compute luminance for all
    for entry in deduped:
        rgb = hex_to_rgb(entry["hex"])
        entry["rgb"] = rgb
        entry["luminance"] = relative_luminance(*rgb)
        entry["hsl"] = get_hsl(*rgb)

    # --- Assign background (lightest achromatic, or lightest overall) ---
    bg_hex = _find_background(achromatic, deduped)

    # --- Assign text (darkest, preferring text-context entries) ---
    text_hex = _find_text_color(achromatic, deduped)

    # --- Assign text_light (medium-dark achromatic) ---
    text_light_hex = _find_text_light(achromatic, deduped, text_hex, bg_hex)

    # --- Assign bg_alt (slightly darker than bg) ---
    bg_alt_hex = _find_bg_alt(achromatic, deduped, bg_hex)

    # --- Assign surface (between bg and bg_alt) ---
    surface_hex = _find_surface(bg_hex, bg_alt_hex)

    # --- Assign primary (most frequent chromatic color) ---
    primary_hex = _find_primary(chromatic, deduped)

    # --- Assign secondary (second most frequent chromatic, different hue) ---
    secondary_hex = _find_secondary(chromatic, primary_hex)

    # --- Assign accent (most saturated chromatic, different from primary/secondary) ---
    accent_hex = _find_accent(chromatic, primary_hex, secondary_hex)

    # Verify contrast and adjust if needed
    result = {
        "primary": primary_hex,
        "secondary": secondary_hex,
        "accent": accent_hex,
        "text": text_hex,
        "text_light": text_light_hex,
        "bg": bg_hex,
        "bg_alt": bg_alt_hex,
        "surface": surface_hex,
    }

    return _ensure_contrast(result)


def _default_palette():
    """Fallback palette when no colors are extracted."""
    return {
        "primary": "#2563eb",
        "secondary": "#7c3aed",
        "accent": "#f59e0b",
        "text": "#111827",
        "text_light": "#6b7280",
        "bg": "#ffffff",
        "bg_alt": "#f3f4f6",
        "surface": "#f9fafb",
    }


def _deduplicate_colors(entries):
    """Merge colors within distance 20 in RGB space, summing counts."""
    result = []
    used = set()
    sorted_entries = sorted(entries, key=lambda e: e.get("count", 1), reverse=True)

    for i, entry in enumerate(sorted_entries):
        if i in used:
            continue
        rgb_i = hex_to_rgb(entry["hex"])
        merged_count = entry.get("count", 1)
        for j in range(i + 1, len(sorted_entries)):
            if j in used:
                continue
            rgb_j = hex_to_rgb(sorted_entries[j]["hex"])
            if color_distance(rgb_i, rgb_j) < 20:
                merged_count += sorted_entries[j].get("count", 1)
                used.add(j)
        result.append(
            {
                "hex": entry["hex"],
                "count": merged_count,
                "context": entry.get("context", "unknown"),
            }
        )
    return result


def _find_background(achromatic, all_entries):
    """Find the background color — lightest achromatic with high frequency."""
    # Prefer achromatic colors used as backgrounds
    bg_candidates = [
        e for e in achromatic if e.get("context") == "background" and e["luminance"] > 0.8
    ]
    if bg_candidates:
        return max(bg_candidates, key=lambda e: e["luminance"])["hex"]

    # Fall back to lightest achromatic
    light_achromatic = [e for e in achromatic if e["luminance"] > 0.8]
    if light_achromatic:
        return max(light_achromatic, key=lambda e: e["luminance"])["hex"]

    # Fall back to lightest overall
    light_all = [e for e in all_entries if e["luminance"] > 0.7]
    if light_all:
        return max(light_all, key=lambda e: e["luminance"])["hex"]

    return "#ffffff"


def _find_text_color(achromatic, all_entries):
    """Find the text color — darkest, preferring text-context entries."""
    text_candidates = [
        e for e in all_entries if e.get("context") == "text" and e["luminance"] < 0.2
    ]
    if text_candidates:
        return min(text_candidates, key=lambda e: e["luminance"])["hex"]

    dark_achromatic = [e for e in achromatic if e["luminance"] < 0.2]
    if dark_achromatic:
        return min(dark_achromatic, key=lambda e: e["luminance"])["hex"]

    dark_all = [e for e in all_entries if e["luminance"] < 0.3]
    if dark_all:
        return min(dark_all, key=lambda e: e["luminance"])["hex"]

    return "#111827"


def _find_text_light(achromatic, all_entries, text_hex, bg_hex):
    """Find text_light — medium luminance achromatic."""
    text_lum = relative_luminance(*hex_to_rgb(text_hex))
    bg_lum = relative_luminance(*hex_to_rgb(bg_hex))
    target_lum = text_lum + (bg_lum - text_lum) * 0.4  # 40% toward background

    candidates = [
        e
        for e in achromatic
        if e["hex"] != text_hex and e["hex"] != bg_hex and 0.15 < e["luminance"] < 0.6
    ]
    if candidates:
        return min(candidates, key=lambda e: abs(e["luminance"] - target_lum))["hex"]

    # Synthesize
    t = 0.4
    text_rgb = hex_to_rgb(text_hex)
    bg_rgb = hex_to_rgb(bg_hex)
    mixed = tuple(int(text_rgb[i] + t * (bg_rgb[i] - text_rgb[i])) for i in range(3))
    return rgb_to_hex(*mixed)


def _find_bg_alt(achromatic, all_entries, bg_hex):
    """Find bg_alt — slightly darker than bg."""
    bg_lum = relative_luminance(*hex_to_rgb(bg_hex))
    target_lum = bg_lum * 0.92  # slightly darker

    candidates = [
        e
        for e in achromatic
        if e["hex"] != bg_hex and 0.7 < e["luminance"] < bg_lum
    ]
    if candidates:
        return min(candidates, key=lambda e: abs(e["luminance"] - target_lum))["hex"]

    # Synthesize by darkening bg
    bg_rgb = hex_to_rgb(bg_hex)
    darker = tuple(max(0, int(c * 0.95)) for c in bg_rgb)
    return rgb_to_hex(*darker)


def _find_surface(bg_hex, bg_alt_hex):
    """Find surface — between bg and bg_alt."""
    bg_rgb = hex_to_rgb(bg_hex)
    alt_rgb = hex_to_rgb(bg_alt_hex)
    mixed = tuple(int((bg_rgb[i] + alt_rgb[i]) / 2) for i in range(3))
    return rgb_to_hex(*mixed)


def _find_primary(chromatic, all_entries):
    """Find primary — most frequent chromatic color."""
    if chromatic:
        # Sort by count, prefer fill/stroke context
        scored = []
        for e in chromatic:
            score = e.get("count", 1)
            if e.get("context") in ("fill", "stroke"):
                score *= 1.5
            # Prefer medium saturation and luminance (not too dark, not too light)
            _, sat, lum = e["hsl"]
            if 0.2 < lum < 0.8 and sat > 0.3:
                score *= 2.0
            scored.append((score, e))
        scored.sort(key=lambda x: x[0], reverse=True)
        return scored[0][1]["hex"]

    return "#2563eb"


def _find_secondary(chromatic, primary_hex):
    """Find secondary — second most frequent, different hue from primary."""
    if not primary_hex or not chromatic:
        return "#7c3aed"

    primary_rgb = hex_to_rgb(primary_hex)
    primary_hue = get_hsl(*primary_rgb)[0]

    candidates = []
    for e in chromatic:
        if e["hex"] == primary_hex:
            continue
        hue_diff = abs(e["hsl"][0] - primary_hue)
        hue_diff = min(hue_diff, 360 - hue_diff)
        if hue_diff > 30:  # At least 30 degrees apart
            candidates.append(e)

    if candidates:
        return max(candidates, key=lambda e: e.get("count", 1))["hex"]

    # If no sufficiently different hue, shift primary hue
    h, s, l = get_hsl(*primary_rgb)
    new_h = ((h + 120) % 360) / 360.0
    r, g, b = colorsys.hls_to_rgb(new_h, l, s)
    return rgb_to_hex(int(r * 255), int(g * 255), int(b * 255))


def _find_accent(chromatic, primary_hex, secondary_hex):
    """Find accent — most saturated, different from primary and secondary."""
    exclude = {primary_hex, secondary_hex}
    candidates = [e for e in chromatic if e["hex"] not in exclude]

    if candidates:
        # Prefer high saturation
        return max(candidates, key=lambda e: e["hsl"][1])["hex"]

    # Synthesize from primary — complementary with boosted saturation
    if primary_hex:
        rgb = hex_to_rgb(primary_hex)
        h, s, l = get_hsl(*rgb)
        new_h = ((h + 180) % 360) / 360.0
        new_s = min(1.0, s * 1.3)
        new_l = max(0.4, min(0.6, l))
        r, g, b = colorsys.hls_to_rgb(new_h, new_l, new_s)
        return rgb_to_hex(int(r * 255), int(g * 255), int(b * 255))

    return "#f59e0b"


def _ensure_contrast(palette):
    """Ensure WCAG AA contrast ratios between text and background colors."""
    bg_lum = relative_luminance(*hex_to_rgb(palette["bg"]))
    text_lum = relative_luminance(*hex_to_rgb(palette["text"]))

    # Text on bg needs >= 4.5:1 contrast
    if contrast_ratio(text_lum, bg_lum) < 4.5:
        # Darken text until contrast is sufficient
        palette["text"] = _darken_for_contrast(palette["text"], palette["bg"], 4.5)

    # text_light on bg needs >= 4.5:1
    tl_lum = relative_luminance(*hex_to_rgb(palette["text_light"]))
    if contrast_ratio(tl_lum, bg_lum) < 4.5:
        palette["text_light"] = _darken_for_contrast(
            palette["text_light"], palette["bg"], 4.5
        )

    return palette


def _darken_for_contrast(fg_hex, bg_hex, target_ratio):
    """Progressively darken foreground color until contrast ratio is met."""
    fg_rgb = list(hex_to_rgb(fg_hex))
    bg_lum = relative_luminance(*hex_to_rgb(bg_hex))

    for _ in range(50):
        fg_lum = relative_luminance(*fg_rgb)
        if contrast_ratio(fg_lum, bg_lum) >= target_ratio:
            break
        fg_rgb = [max(0, int(c * 0.9)) for c in fg_rgb]

    return rgb_to_hex(*fg_rgb)
