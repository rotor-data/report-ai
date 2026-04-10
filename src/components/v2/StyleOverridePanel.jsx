import { useState } from "react";

const NUMERIC_FIELDS = [
  { key: "heading_size_pt", label: "Rubrikstorlek (pt)", step: 0.5 },
  { key: "heading_tracking_em", label: "Rubrik letter-spacing (em)", step: 0.01 },
  { key: "body_size_pt", label: "Brödtextstorlek (pt)", step: 0.5 },
  { key: "body_leading_pt", label: "Radavstånd (pt)", step: 0.5 },
  { key: "padding_top_mm", label: "Padding topp (mm)", step: 1 },
  { key: "padding_bottom_mm", label: "Padding botten (mm)", step: 1 },
  { key: "gap_mm", label: "Gap mellan kolumner (mm)", step: 1 },
];

const COLOR_FIELDS = [
  { key: "background_color", label: "Bakgrundsfärg" },
  { key: "text_color", label: "Textfärg" },
];

/**
 * Collapsible style override panel. Emits the full style object on change.
 */
export default function StyleOverridePanel({ style, onChange }) {
  const [open, setOpen] = useState(false);
  const current = style || {};

  const setField = (key, value) => {
    const next = { ...current };
    if (value === "" || value == null) {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange(next);
  };

  const setNumericField = (key, value) => {
    if (value === "") return setField(key, null);
    const num = Number(value);
    if (Number.isNaN(num)) return;
    setField(key, num);
  };

  return (
    <div className="panel stack" style={{ padding: "12px" }}>
      <button
        className="btn-ghost"
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ textAlign: "left" }}
      >
        {open ? "▾" : "▸"} Stil-override
      </button>

      {open ? (
        <div className="stack">
          {NUMERIC_FIELDS.map((f) => (
            <label key={f.key}>
              {f.label}
              <input
                type="number"
                step={f.step}
                value={current[f.key] ?? ""}
                onChange={(e) => setNumericField(f.key, e.target.value)}
              />
            </label>
          ))}
          {COLOR_FIELDS.map((f) => (
            <label key={f.key}>
              {f.label}
              <input
                type="text"
                placeholder="#rrggbb"
                value={current[f.key] || ""}
                onChange={(e) => setField(f.key, e.target.value)}
              />
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
