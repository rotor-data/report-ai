import React from "react";

/**
 * Renders a small warning glyph when a unit has been heavily rewritten
 * relative to its parsed-from-source text. "Heavy" = the Levenshtein
 * edit-distance exceeds 50% of the current text length.
 *
 * Stand-alone: intentionally NOT imported by EditorV2.jsx / HtmlPreview.jsx
 * to avoid merge conflicts with the Fas 3+4 polish agent. See
 * units-feedback/index.js for the integration entry point — Fas 3+4
 * (or whoever lands next) wires it into the per-unit row in the side
 * panel of EditorV2.
 *
 * Props:
 *   editDistance: number  — Levenshtein distance between original and current text
 *   textLength:   number  — current text length (used as the denominator)
 *   title?:       string  — optional override for the hover tooltip
 */
export default function HeavyEditIndicator({ editDistance, textLength, title }) {
  if (typeof editDistance !== "number" || typeof textLength !== "number") return null;
  if (textLength <= 0) return null;
  if (editDistance <= textLength * 0.5) return null;

  const pct = Math.min(100, Math.round((editDistance / textLength) * 100));
  const tip = title ?? `Heavy edit: ~${pct}% of the text differs from the parsed original.`;

  return (
    <span
      className="unit-heavy-edit"
      title={tip}
      aria-label={tip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 6px",
        fontSize: 11,
        lineHeight: 1.2,
        borderRadius: 4,
        background: "#fff4d6",
        color: "#8a5a00",
        border: "1px solid #f0c97a",
      }}
    >
      <span aria-hidden="true">⚠</span>
      <span>{pct}% edited</span>
    </span>
  );
}
