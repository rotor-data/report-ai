/**
 * UnitTypeIcon — small glyph + colour swatch that visually identifies a
 * content-unit type in the side panel and the inline edit popover.
 *
 * Two render modes:
 *   <UnitTypeIcon type="heading" level={2} />     — chip with glyph
 *   <UnitTypeIcon type="paragraph" compact />     — bare glyph (no chip)
 *
 * Headings render an "H" glyph whose opacity scales with heading level
 * (h1 = solid, h6 = ghost) so the eye can pick up document hierarchy
 * without reading text. Other types use a fixed glyph + colour assigned
 * by category (text-flow, headings, emphasis, lists, data, structured,
 * layout, reference).
 *
 * Pure presentational. No state, no callbacks. Safe to render in tight
 * loops for 100+ units.
 */

const CATEGORY_COLORS = {
  // Text flow — neutral slate.
  paragraph:        { bg: "#e2e8f0", fg: "#0f172a", glyph: "¶" },
  lead:             { bg: "#cbd5e1", fg: "#0f172a", glyph: "L" },
  kicker:           { bg: "#fde68a", fg: "#78350f", glyph: "K" },
  attribution:      { bg: "#e5e7eb", fg: "#374151", glyph: "—" },
  // Headings — purple, level-graded opacity in HeadingChip.
  heading:          { bg: "#ede9fe", fg: "#4c1d95", glyph: "H" },
  eyebrow:          { bg: "#ede9fe", fg: "#4c1d95", glyph: "°" },
  // Emphasis / call-outs — warm.
  blockquote:       { bg: "#fef3c7", fg: "#7c2d12", glyph: "“" },
  pull_quote:       { bg: "#fde68a", fg: "#7c2d12", glyph: "”" },
  callout:          { bg: "#fef3c7", fg: "#92400e", glyph: "⚑" },
  info_box:         { bg: "#dbeafe", fg: "#1e3a8a", glyph: "i" },
  warning_box:      { bg: "#fee2e2", fg: "#991b1b", glyph: "!" },
  success_box:      { bg: "#dcfce7", fg: "#14532d", glyph: "✓" },
  highlight:        { bg: "#fef08a", fg: "#713f12", glyph: "✨" },
  // Reference notes — muted blue.
  caption:          { bg: "#e0f2fe", fg: "#0c4a6e", glyph: "fn" },
  footnote:         { bg: "#e0f2fe", fg: "#0c4a6e", glyph: "fn" },
  sidenote:         { bg: "#e0f2fe", fg: "#0c4a6e", glyph: "§" },
  citation:         { bg: "#e0f2fe", fg: "#0c4a6e", glyph: "©" },
  toc_entry:        { bg: "#f1f5f9", fg: "#334155", glyph: "§" },
  bibliography_entry: { bg: "#e0f2fe", fg: "#0c4a6e", glyph: "…" },
  // Lists — green.
  bullet_list:      { bg: "#dcfce7", fg: "#14532d", glyph: "•" },
  numbered_list:    { bg: "#dcfce7", fg: "#14532d", glyph: "1." },
  check_list:       { bg: "#dcfce7", fg: "#14532d", glyph: "✓" },
  definition_list:  { bg: "#dcfce7", fg: "#14532d", glyph: "A:B" },
  // Data / KPI — rose to stand out from neutral text.
  kpi:              { bg: "#ffe4e6", fg: "#9f1239", glyph: "#" },
  kpi_group:        { bg: "#ffe4e6", fg: "#9f1239", glyph: "##" },
  stat_hero:        { bg: "#ffe4e6", fg: "#9f1239", glyph: "★" },
  table:            { bg: "#ffe4e6", fg: "#9f1239", glyph: "⊞" },
  comparison:       { bg: "#ffe4e6", fg: "#9f1239", glyph: "⇄" },
  // Structured — teal.
  timeline_event:   { bg: "#ccfbf1", fg: "#134e4a", glyph: "⧖" },
  step:             { bg: "#ccfbf1", fg: "#134e4a", glyph: "➜" },
  testimonial:      { bg: "#ccfbf1", fg: "#134e4a", glyph: "❝" },
  glossary_item:    { bg: "#ccfbf1", fg: "#134e4a", glyph: "§" },
  // Layout / decorative — light grey, ghost-glyph.
  divider:          { bg: "#f1f5f9", fg: "#64748b", glyph: "—" },
  spacer:           { bg: "#f1f5f9", fg: "#64748b", glyph: "␣" },
  page_break:       { bg: "#f1f5f9", fg: "#64748b", glyph: "¶" },
};

const TYPE_LABELS_SV = {
  paragraph: "Stycke",
  lead: "Inledning",
  kicker: "Kicker",
  attribution: "Källangivelse",
  heading: "Rubrik",
  eyebrow: "Förrubrik",
  blockquote: "Citatblock",
  pull_quote: "Pull quote",
  callout: "Notis",
  info_box: "Info-ruta",
  warning_box: "Varning",
  success_box: "Klart-ruta",
  highlight: "Markerad",
  caption: "Bildtext",
  footnote: "Fotnot",
  sidenote: "Sidnot",
  citation: "Citat-källa",
  toc_entry: "Innehåll",
  bibliography_entry: "Källförteckning",
  bullet_list: "Punktlista",
  numbered_list: "Numrerad lista",
  check_list: "Checklista",
  definition_list: "Definitionslista",
  kpi: "Nyckeltal",
  kpi_group: "KPI-grupp",
  stat_hero: "Stat-hjälte",
  table: "Tabell",
  comparison: "Jämförelse",
  timeline_event: "Tidslinje",
  step: "Steg",
  testimonial: "Omdöme",
  glossary_item: "Ordbok",
  divider: "Avskiljare",
  spacer: "Mellanrum",
  page_break: "Sidbrytning",
};

const FALLBACK = { bg: "#f4f4f5", fg: "#71717a", glyph: "?" };

export function getUnitTypeMeta(type) {
  const c = CATEGORY_COLORS[type] || FALLBACK;
  return {
    bg: c.bg,
    fg: c.fg,
    glyph: c.glyph,
    label: TYPE_LABELS_SV[type] || type,
  };
}

/**
 * Visual identifier for a content-unit type.
 *
 *   type     — required unit type string.
 *   level    — heading level (1–6) used to grade heading opacity.
 *   compact  — render only the glyph circle, no label / chip border.
 *   className — extra class on the root element.
 */
export default function UnitTypeIcon({ type, level, compact = false, className = "" }) {
  const meta = getUnitTypeMeta(type);
  const isHeading = type === "heading";
  // h1 fully solid, h6 down to 0.45. Linear ramp.
  const opacity = isHeading && level ? Math.max(0.45, 1 - (Math.max(1, Math.min(6, level)) - 1) * 0.11) : 1;
  const glyphText = isHeading && level ? `H${level}` : meta.glyph;

  const dotStyle = {
    backgroundColor: meta.bg,
    color: meta.fg,
    opacity,
  };

  if (compact) {
    return (
      <span
        className={`unit-type-icon unit-type-icon--compact ${className}`}
        style={dotStyle}
        title={meta.label}
        aria-label={meta.label}
      >
        {glyphText}
      </span>
    );
  }

  return (
    <span
      className={`unit-type-chip ${className}`}
      style={{ background: meta.bg, color: meta.fg, opacity }}
      title={meta.label}
    >
      <span className="unit-type-chip-glyph" aria-hidden="true">{glyphText}</span>
      <span className="unit-type-chip-label">{meta.label}</span>
    </span>
  );
}
