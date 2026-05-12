import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import ImagePickerDialog from "./ImagePickerDialog";
import { substituteUnits } from "../../lib/units-substitute.js";

const SELECTABLE = new Set([
  "p","h1","h2","h3","h4","h5","h6","hr","img","div","section",
  "blockquote","ul","ol","table","figure","aside","header","footer","pre","dl","span","li","td","th",
]);

const EDITABLE_TEXT_TAGS = new Set([
  "p","h1","h2","h3","h4","h5","h6","span","li","td","th","blockquote","figcaption",
  // Rotor components often put text straight inside divs/sections/headers/
  // footers without wrapping in <p>/<span> (e.g. .kpi-card > .value, .cov-hero__title).
  // Editing those used to silently fail because the tag wasn't in this set.
  "div","section","header","footer","figure","article","aside","small","strong","em",
  "a","label","dt","dd","summary","caption",
]);

/**
 * Elements that should NOT be treated as editable even if their tag is in
 * EDITABLE_TEXT_TAGS — typically layout containers with nested element
 * children (grids, wrappers). Detected at runtime by checking structure.
 */
function hasBlockChildren(el) {
  for (const child of el.children) {
    const tag = child.tagName.toLowerCase();
    // Anything with real structural children (another grid/flex container
    // or a data-visualisation element) should stay non-editable at this
    // level — the user should drill into the child.
    if (child.hasAttribute("data-module-type")) return true;
    if (child.hasAttribute("data-chart")) return true;
    if (tag === "table" || tag === "ul" || tag === "ol" || tag === "dl") return true;
    // A div/section nested inside another div is a layout wrapper.
    if ((tag === "div" || tag === "section" || tag === "article") && child.children.length > 0) return true;
  }
  return false;
}

/**
 * Safe class-name accessor — SVG elements expose `className` as an
 * SVGAnimatedString object, not a plain string, so `.split()` crashes.
 * Everything routes through here so the inspector can't blow up on
 * chart markup or other embedded SVG.
 */
function firstClassName(el) {
  if (!el) return "";
  const raw =
    typeof el.className === "string"
      ? el.className
      : (el.getAttribute?.("class") || "");
  if (!raw) return "";
  return raw.split(/\s+/).filter(Boolean)[0] || "";
}

/**
 * Turn an element into a human-friendly label for the inspector — the
 * user shouldn't have to read <div.kpi-card>. Tries class-based hints
 * first (since brand components usually encode meaning in class names),
 * then falls back to tag-based defaults, then to text content.
 */
function humanLabel(el) {
  if (!el) return "Element";
  const tag = el.tagName?.toLowerCase?.() || "";
  const cls = firstClassName(el);
  const text = (el.textContent || "").trim().replace(/\s+/g, " ");

  // Class-name heuristics — order matters (most specific first).
  const classMap = [
    [/kpi[-_]?value|^val$|^value$|number$/i, "Siffra"],
    [/kpi[-_]?label|^label$|caption$/i, "Etikett"],
    [/kpi[-_]?trend|^trend|delta|change/i, "Trend"],
    [/kpi[-_]?card|stat[-_]?card|metric/i, "KPI-kort"],
    [/kpi[-_]?grid|stats?/i, "KPI-grupp"],
    [/pullquote|blockquote/i, "Citat"],
    [/callout|highlight|notice/i, "Utmärkning"],
    [/eyebrow|kicker/i, "Rubrik-kicker"],
    [/subtitle|tagline|deck/i, "Underrubrik"],
    [/heading|headline|^title|h1|h2|h3/i, "Rubrik"],
    [/body|paragraph|lead|intro/i, "Brödtext"],
    [/cta|button|btn/i, "Knapp"],
    [/logo|brand/i, "Logotyp"],
    [/hero|cover/i, "Omslag"],
    [/footer|colophon/i, "Sidfot"],
    [/chapter/i, "Kapitelmarkering"],
    [/toc/i, "Innehållsförteckning"],
    [/^fact|fs-block|stat[-_]?strip/i, "Faktaruta"],
    [/timeline/i, "Tidslinje"],
    [/team|person/i, "Personkort"],
    [/chart|graph|diagram/i, "Diagram"],
    [/table/i, "Tabell"],
  ];
  for (const [re, label] of classMap) {
    if (cls && re.test(cls)) return label;
  }

  // Tag-based defaults.
  if (tag === "h1" || tag === "h2") return "Rubrik";
  if (tag === "h3" || tag === "h4") return "Underrubrik";
  if (tag === "h5" || tag === "h6") return "Småtitel";
  if (tag === "p") return "Stycke";
  if (tag === "img") return "Bild";
  if (tag === "blockquote") return "Citat";
  if (tag === "ul" || tag === "ol") return "Lista";
  if (tag === "li") return "Listpunkt";
  if (tag === "table") return "Tabell";
  if (tag === "figure") return "Figur";
  if (tag === "figcaption") return "Bildtext";
  if (tag === "a") return "Länk";
  if (tag === "button") return "Knapp";
  if (tag === "span" || tag === "strong" || tag === "em") {
    // Inline elements with short text get the text itself as label.
    if (text && text.length < 40) return text.slice(0, 30);
    return "Text";
  }

  if (tag === "div" || tag === "section" || tag === "article" || tag === "aside") {
    if (el.children?.length > 0) return `Grupp (${el.children.length})`;
    if (text && text.length < 40) return text.slice(0, 30);
    return "Block";
  }

  return tag.toUpperCase();
}

/**
 * Small icon glyph for the inspector's children list. Keeps the list
 * scannable without needing tag labels.
 */
function elementIcon(el) {
  if (!el) return "▫";
  const tag = el.tagName?.toLowerCase?.() || "";
  if (tag === "img") return "🖼";
  if (/h[1-6]/.test(tag)) return "𝐇";
  if (tag === "p") return "¶";
  if (tag === "blockquote") return "❞";
  if (tag === "ul" || tag === "ol") return "≣";
  if (tag === "li") return "•";
  if (tag === "a") return "↗";
  if (tag === "button") return "▭";
  if (tag === "table") return "⊞";
  if (tag === "figure") return "▤";
  if (tag === "svg") return "⊻";
  if (el.children?.length > 0) return "▣";
  return "▫";
}

// Standard paper sizes in millimeters. The preview tries to detect which
// one the module HTML targets and size the frame accordingly.
const PAPER_SIZES = {
  a4_portrait:  { w: 210, h: 297 },
  a4_landscape: { w: 297, h: 210 },
  a5_portrait:  { w: 148, h: 210 },
  a5_landscape: { w: 210, h: 148 },
  letter_portrait:  { w: 216, h: 279 },
  letter_landscape: { w: 279, h: 216 },
  a3_portrait:  { w: 297, h: 420 },
  a3_landscape: { w: 420, h: 297 },
  presentation:     { w: 338, h: 190 },
  presentation_16_9:{ w: 338, h: 190 },
  square:           { w: 210, h: 210 },
  digital:          { w: 381, h: 238 },
};

// Map v2_reports.page_format → PAPER_SIZES entry. Drives the editor frame
// when EditorV2 has the canonical format id; preferred over HTML-class
// detection because non-A4 reports often DON'T carry the format modifier
// on every <section class="page"> (Claude composes against semantic
// page--cover / page--dark modifiers, render.py injects the size class
// at PDF time). Without an explicit prop the editor was stuck on A4 even
// when the PDF rendered correctly at 338×190mm.
const PAGE_FORMAT_TO_SIZE = {
  a4_portrait:        PAPER_SIZES.a4_portrait,
  a4_landscape:       PAPER_SIZES.a4_landscape,
  a5:                 PAPER_SIZES.a5_portrait,
  a5_landscape:       PAPER_SIZES.a5_landscape,
  a3:                 PAPER_SIZES.a3_portrait,
  a3_landscape:       PAPER_SIZES.a3_landscape,
  us_letter:          PAPER_SIZES.letter_portrait,
  us_letter_landscape:PAPER_SIZES.letter_landscape,
  letter:             PAPER_SIZES.letter_portrait,
  letter_landscape:   PAPER_SIZES.letter_landscape,
  presentation:       PAPER_SIZES.presentation,
  presentation_16_9:  PAPER_SIZES.presentation_16_9,
  square:             PAPER_SIZES.square,
  digital:            PAPER_SIZES.digital,
};

/**
 * Detect the page format of a module.
 * Precedence:
 *   1. Caller-supplied `pageFormat` prop (the report's canonical
 *      page_format id from v2_reports.page_format) — always wins when
 *      it matches a known PAGE_FORMAT_TO_SIZE entry. This is the path
 *      that makes the editor follow the report's actual paper size
 *      regardless of whether Claude's HTML carries a modifier class.
 *   2. Explicit class hints on a .page element (.page--landscape,
 *      .page--a5, .page--letter, .page--presentation, ...) — used
 *      for legacy reports that pre-date pageFormat plumbing.
 *   3. Inline width/height style on a .page element.
 *   4. Default to A4 portrait.
 */
function detectPageSize(html, pageFormat) {
  // 1. Explicit prop wins.
  if (pageFormat && PAGE_FORMAT_TO_SIZE[pageFormat]) {
    return PAGE_FORMAT_TO_SIZE[pageFormat];
  }

  if (!html) return PAPER_SIZES.a4_portrait;
  const probe = document.createElement("div");
  probe.innerHTML = html;
  const page = probe.querySelector(".page");
  if (!page) return PAPER_SIZES.a4_portrait;

  const cls = page.className || "";
  const has = (t) => cls.includes(t);
  if (has("page--a3-landscape")) return PAPER_SIZES.a3_landscape;
  if (has("page--a3")) return PAPER_SIZES.a3_portrait;
  if (has("page--letter-landscape") || has("page--us-letter-landscape")) return PAPER_SIZES.letter_landscape;
  if (has("page--letter") || has("page--us-letter")) return PAPER_SIZES.letter_portrait;
  if (has("page--a5-landscape")) return PAPER_SIZES.a5_landscape;
  if (has("page--a5")) return PAPER_SIZES.a5_portrait;
  if (has("page--presentation-16-9") || has("page--presentation")) return PAPER_SIZES.presentation;
  if (has("page--square")) return PAPER_SIZES.square;
  if (has("page--digital")) return PAPER_SIZES.digital;
  if (has("page--landscape")) return PAPER_SIZES.a4_landscape;

  // Inline style: width:297mm;height:210mm etc.
  const style = page.getAttribute("style") || "";
  const widthMatch = style.match(/width\s*:\s*(\d+(?:\.\d+)?)mm/i);
  const heightMatch = style.match(/height\s*:\s*(\d+(?:\.\d+)?)mm/i);
  if (widthMatch && heightMatch) {
    const w = Number(widthMatch[1]);
    const h = Number(heightMatch[1]);
    if (w > 50 && h > 50) return { w, h };
  }
  // width/height swap on element = landscape hint
  if (widthMatch && !heightMatch) {
    const w = Number(widthMatch[1]);
    if (w > 250) return PAPER_SIZES.a4_landscape;
  }

  return PAPER_SIZES.a4_portrait;
}

/**
 * Rewrite references inside the injected HTML so the shadow DOM
 * can actually load logos and tenant assets. smyra-render does this
 * on the server, but the editor needs to do it client-side so the
 * preview isn't peppered with broken-image placeholders.
 */
function resolveAssetRefs(root, logos, assets) {
  // ── data-logo="variant" → resolve to brand_logos row
  const logoByVariant = new Map();
  for (const logo of logos || []) {
    if (logo?.data_uri) logoByVariant.set(logo.variant, logo.data_uri);
  }
  // Fallback order when a module asks for a variant we don't have:
  // default → primary → first whatever we do have.
  const fallbackLogo =
    logoByVariant.get("default") ||
    logoByVariant.get("primary") ||
    (logos && logos[0]?.data_uri) ||
    null;

  root.querySelectorAll("img[data-logo], [data-logo]").forEach((el) => {
    const variant = el.getAttribute("data-logo") || "default";
    const src = logoByVariant.get(variant) || fallbackLogo;
    if (!src) return;
    if (el.tagName.toLowerCase() === "img") {
      el.setAttribute("src", src);
    } else {
      // Non-img element with data-logo: turn it into an inline background.
      el.style.backgroundImage = `url("${src}")`;
      el.style.backgroundRepeat = "no-repeat";
      el.style.backgroundPosition = "center";
      el.style.backgroundSize = "contain";
    }
  });

  // ── data-asset-ref="uuid" → resolve to tenant_assets.url
  const assetById = new Map();
  for (const a of assets || []) {
    if (a?.id && a?.url) assetById.set(String(a.id), a.url);
  }
  root.querySelectorAll("img[data-asset-ref], [data-asset-ref]").forEach((el) => {
    const ref = el.getAttribute("data-asset-ref");
    const src = assetById.get(String(ref));
    if (!src) return;
    if (el.tagName.toLowerCase() === "img") {
      el.setAttribute("src", src);
    } else {
      el.style.backgroundImage = `url("${src}")`;
      el.style.backgroundRepeat = "no-repeat";
      el.style.backgroundPosition = "center";
      el.style.backgroundSize = "cover";
    }
  });

  // ── charts rendered as <div data-chart="..."> are server-rendered
  // to SVG by smyra-render at PDF time. For the editor preview we
  // parse the data-chart JSON ourselves and draw a lightweight SVG
  // that uses the brand's --primary / --accent variables — so the
  // author sees an actual chart shape (not just "chart here") while
  // editing. The real PDF still uses smyra-render's proper chart
  // pipeline.
  root.querySelectorAll("[data-chart]").forEach((el) => {
    if (el.childElementCount > 0) return; // already rendered
    const raw = el.getAttribute("data-chart") || "";
    let cfg = null;
    try { cfg = JSON.parse(raw); } catch { /* fall through to placeholder */ }
    if (!cfg || !Array.isArray(cfg.values) || cfg.values.length === 0) {
      const placeholder = document.createElement("div");
      placeholder.textContent = "📊 Diagram (renderas i PDF)";
      placeholder.style.cssText =
        "display:flex;align-items:center;justify-content:center;" +
        "min-height:120px;border:1px dashed rgba(0,0,0,0.25);" +
        "border-radius:6px;color:rgba(0,0,0,0.55);font-size:12px;" +
        "background:rgba(0,0,0,0.03);";
      el.appendChild(placeholder);
      return;
    }
    el.appendChild(renderPreviewChart(cfg));
  });
}

/**
 * Draws a simple SVG chart (bar or line) inside the editor preview.
 * Uses the shadow host's brand vars (--primary / --accent) so the
 * chart picks up Rotor green / magenta etc. without needing a
 * charting library in the preview bundle.
 *
 * Not meant to be pixel-perfect — the PDF renderer redraws this
 * server-side with a proper chart pipeline. Preview just needs
 * "that's a bar chart with those values", for layout-decision purposes.
 */
function renderPreviewChart(cfg) {
  const type = cfg.chart_type || cfg.type || "bar";
  const values = cfg.values.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  const labels = Array.isArray(cfg.labels) && cfg.labels.length === values.length
    ? cfg.labels
    : values.map((_, i) => String(i + 1));
  const W = 400;
  const H = 180;
  const padL = 34, padR = 12, padT = 12, padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const range = max - min || 1;

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "auto");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", cfg.series_label || "Chart");
  svg.style.maxHeight = "220px";
  svg.style.fontFamily = "var(--font-body, system-ui, sans-serif)";

  // Axis / baseline
  const axis = document.createElementNS(svgNS, "line");
  axis.setAttribute("x1", String(padL));
  axis.setAttribute("y1", String(padT + plotH));
  axis.setAttribute("x2", String(padL + plotW));
  axis.setAttribute("y2", String(padT + plotH));
  axis.setAttribute("stroke", "rgba(0,0,0,0.25)");
  axis.setAttribute("stroke-width", "0.75");
  svg.appendChild(axis);

  if (type === "line" || type === "area") {
    const step = values.length > 1 ? plotW / (values.length - 1) : plotW / 2;
    const points = values.map((v, i) => {
      const x = padL + i * step;
      const y = padT + plotH - ((v - min) / range) * plotH;
      return `${x},${y}`;
    }).join(" ");
    if (type === "area") {
      const first = values[0], last = values[values.length - 1];
      const y0 = padT + plotH - ((first - min) / range) * plotH;
      const yN = padT + plotH - ((last - min) / range) * plotH;
      const area = document.createElementNS(svgNS, "polygon");
      area.setAttribute("points", `${padL},${padT + plotH} ${points} ${padL + (values.length - 1) * step},${padT + plotH}`);
      area.setAttribute("fill", "var(--primary, #1a1a2e)");
      area.setAttribute("opacity", "0.15");
      svg.appendChild(area);
    }
    const poly = document.createElementNS(svgNS, "polyline");
    poly.setAttribute("points", points);
    poly.setAttribute("fill", "none");
    poly.setAttribute("stroke", "var(--primary, #1a1a2e)");
    poly.setAttribute("stroke-width", "2");
    poly.setAttribute("stroke-linejoin", "round");
    poly.setAttribute("stroke-linecap", "round");
    svg.appendChild(poly);
    // Dots at each point
    values.forEach((v, i) => {
      const x = padL + i * step;
      const y = padT + plotH - ((v - min) / range) * plotH;
      const dot = document.createElementNS(svgNS, "circle");
      dot.setAttribute("cx", String(x));
      dot.setAttribute("cy", String(y));
      dot.setAttribute("r", "2.5");
      dot.setAttribute("fill", "var(--accent, #e94560)");
      svg.appendChild(dot);
    });
  } else {
    // Bar (default)
    const gap = 6;
    const barW = Math.max(4, (plotW - gap * (values.length - 1)) / values.length);
    values.forEach((v, i) => {
      const x = padL + i * (barW + gap);
      const h = ((v - Math.min(min, 0)) / range) * plotH;
      const y = padT + plotH - h;
      const bar = document.createElementNS(svgNS, "rect");
      bar.setAttribute("x", String(x));
      bar.setAttribute("y", String(y));
      bar.setAttribute("width", String(barW));
      bar.setAttribute("height", String(Math.max(1, h)));
      bar.setAttribute("fill", i === values.length - 1 ? "var(--accent, #e94560)" : "var(--primary, #1a1a2e)");
      bar.setAttribute("rx", "1");
      svg.appendChild(bar);
    });
  }

  // X labels (show first, middle, last to avoid clutter)
  const pickIdx = values.length <= 4
    ? values.map((_, i) => i)
    : [0, Math.floor((values.length - 1) / 2), values.length - 1];
  pickIdx.forEach((i) => {
    const step = values.length > 1 ? plotW / (values.length - 1) : plotW / 2;
    const x = type === "line" || type === "area"
      ? padL + i * step
      : padL + i * ((plotW - 6 * (values.length - 1)) / values.length) + ((plotW - 6 * (values.length - 1)) / values.length) / 2;
    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("x", String(x));
    text.setAttribute("y", String(H - 10));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", "9");
    text.setAttribute("fill", "rgba(0,0,0,0.55)");
    text.textContent = String(labels[i]);
    svg.appendChild(text);
  });

  // Y max label
  const maxLabel = document.createElementNS(svgNS, "text");
  maxLabel.setAttribute("x", String(padL - 4));
  maxLabel.setAttribute("y", String(padT + 8));
  maxLabel.setAttribute("text-anchor", "end");
  maxLabel.setAttribute("font-size", "8");
  maxLabel.setAttribute("fill", "rgba(0,0,0,0.45)");
  maxLabel.textContent = formatNum(max);
  svg.appendChild(maxLabel);

  const wrapper = document.createElement("div");
  wrapper.style.cssText = "width:100%;padding:4px 0;";
  wrapper.appendChild(svg);
  return wrapper;
}

function formatNum(n) {
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

/**
 * HtmlPreview — renders a module's html_cache in a shadow DOM that mimics
 * the real smyra-render output (paper-size page container + brand fonts +
 * tokens + design-system.css utilities), lets the user click elements to
 * select them, delete/duplicate them, and double-click text to edit in place.
 *
 * Props:
 *  - html: string (html_cache from the module)
 *  - brandCss: string — complete CSS bundle from /api/v2-brand-css
 *  - logos: [{ variant, data_uri }] — brand logos for data-logo resolution
 *  - assets: [{ id, url }] — tenant assets for data-asset-ref resolution
 *  - onHtmlChange: (newHtml: string) => void — fired after structural
 *    edits (delete/duplicate) and after contentEditable commits.
 *  - zoom: number (0–1) — visual shrink factor for the preview. Defaults 0.55.
 *  - interactive: boolean — default true. Set false for thumbnail-only rendering.
 */
const HtmlPreview = forwardRef(function HtmlPreview({
  html,
  brandCss = "",
  logos = [],
  assets = [],
  // Alpha-v3 content units. When non-empty, [data-unit="<id>"] placeholders
  // in `html` are replaced with the rendered unit body before injection.
  // Idempotent — running on already-substituted HTML is a no-op. Legacy
  // reports pass an empty array (or omit the prop) to keep their inline
  // HTML untouched.
  units = [],
  onHtmlChange,
  zoom = 0.55,
  interactive = true,
  lang = "sv",
  tenantId = null,
  showGrid = false,
  showOverflow = true,
  moduleId = null,
  // Module type — when "freeform" we mirror render.py's page wrapping so
  // alpha-v3 pages get the `.page page--freeform` element that the
  // design_system_css rules target. Without this the editor preview
  // misses every `.page { padding: …; background: …; ... }` rule the
  // design language defines.
  moduleType = null,
  // Per-module background layer: photo + gradient overlay + vignette + filter.
  // Shape in migration 022. Rendered as an absolutely-positioned
  // layer under the page content so existing module HTML stays
  // untouched. null / {} = no background.
  background = null,
  // Reflow plan 2026-05-08, Job 4. 'page' (default) keeps the historic
  // behaviour: shadow-DOM canvas clipped to one paper-size sheet.
  // 'chapter' switches to flow mode: the inner canvas grows with content
  // (min-height = paper-size, no max-height clip) and the chrome CSS
  // overlays a dashed page-break indicator at every paper-size boundary
  // so authors can preview where Chromium will paginate at PDF time.
  // Substitution pipeline (units, asset refs, recolor) is identical for
  // both modes — only the size constraint differs.
  blockType = "page",
  // Report's canonical page_format id (from v2_reports.page_format).
  // When set, takes precedence over HTML-class-based page-size detection
  // so the editor frame matches the report's actual paper size even when
  // Claude's <section class="page"> doesn't carry the format modifier
  // (server-side render.py injects it at PDF time, but the raw HTML
  // stored in v2_report_modules.html_cache often lacks it).
  pageFormat = null,
  // Fired on dragstart of a selected component. The parent listens so
  // it can react on sidebar drop (cross-module move). Signature:
  //   ({ sourceModuleId, tempId, outerHTML })
  onComponentDragStart,
  onComponentDragEnd,
  // Fired whenever the internal selection changes. Parent uses this
  // to drive the right-side inspector panel so the user has a
  // persistent, unambiguous tool surface that doesn't depend on the
  // fragile floating bar.
  onSelectionChange,
}, forwardedRef) {
  const containerRef = useRef(null);
  const [selected, setSelected] = useState(null);
  const [barPos, setBarPos] = useState(null);
  // Selection bounding rect in container coordinates. Drives the
  // resize handles so they track the selected element's size.
  const [selRect, setSelRect] = useState(null);
  // Floating format toolbar for contenteditable text selections.
  const [formatBar, setFormatBar] = useState(null); // { left, top, el } | null
  // Image picker — open when the user clicks an <img> or picks "Replace
  // image" from the element action bar. target is the DOM node to rewire
  // once the dialog returns a pick.
  const [imagePicker, setImagePicker] = useState(null); // { target } | null
  // Overflow state: populated after injection when measured preview-root
  // height > page height. Rendered as a red marker at the page boundary.
  // Null = no overflow detected (or still measuring).
  const [overflow, setOverflow] = useState(null); // { overBy, pageH, actualH } | null
  // Local undo/redo stack of HTML snapshots. We push BEFORE any destructive
  // change (typing, delete, duplicate) and pop on Cmd/Ctrl+Z. Separate from
  // the server-side save history — this is just for live editing.
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const MAX_UNDO = 60;

  const pushUndoSnapshot = useCallback(() => {
    const snap = getUpdatedHtmlRef.current?.();
    if (snap == null) return;
    const last = undoStack.current[undoStack.current.length - 1];
    if (last === snap) return; // no change
    undoStack.current.push(snap);
    if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
    redoStack.current = []; // new branch invalidates redo
  }, []);
  // Ref wrapper so pushUndoSnapshot can reach getUpdatedHtml defined later
  // in the closure without circular init.
  const getUpdatedHtmlRef = useRef(null);
  // Ref exposes the shadow-DOM enterEditMode helper to the React-rendered
  // element bar so the ✎ button can put the selected element into
  // contenteditable from light DOM.
  const enterEditModeRef = useRef(null);
  // The ref for "getUpdatedHtml + snapshot-and-notify" used by the
  // imperative API below. Filled on every render so handlers always see
  // the latest onHtmlChange prop.
  const notifyRef = useRef(() => {});

  // Stabilize callback identities — parent passes inline arrows that
  // change every render. Without these refs, injectHtml's useCallback
  // sees new identities on every EditorV2 re-render (which happens
  // whenever any state changes), which forces the shadow DOM to be
  // wiped and re-built. That destroyed any active selection before
  // the user could interact with it — the "nothing works" symptom.
  const onHtmlChangeRef = useRef(onHtmlChange);
  const onComponentDragStartRef = useRef(onComponentDragStart);
  const onComponentDragEndRef = useRef(onComponentDragEnd);
  const onSelectionChangeRef = useRef(onSelectionChange);
  useEffect(() => { onHtmlChangeRef.current = onHtmlChange; });
  useEffect(() => { onComponentDragStartRef.current = onComponentDragStart; });
  useEffect(() => { onComponentDragEndRef.current = onComponentDragEnd; });
  useEffect(() => { onSelectionChangeRef.current = onSelectionChange; });

  // Emit selection info to the parent whenever `selected` changes so
  // the inspector panel can render the right actions. Includes a
  // parent path and an immediate-children list so the user can drill
  // into component parts.
  useEffect(() => {
    if (!onSelectionChange) return;
    if (!selected) { onSelectionChange(null); return; }
    const tag = selected.tagName?.toLowerCase?.() || "";
    const textSample = (selected.textContent || "").replace(/\s+/g, " ").trim().slice(0, 140);
    const isEditable =
      EDITABLE_TEXT_TAGS.has(tag) &&
      !hasBlockChildren(selected) &&
      !selected.querySelector?.("img, svg, video");
    const isImage = tag === "img";

    // Parents (up to .preview-root boundary) — newest first.
    const parents = [];
    let p = selected.parentElement;
    const shadow = containerRef.current?.shadowRoot;
    const root = shadow?.querySelector(".preview-root");
    while (p && p !== root) {
      parents.push({
        tagName: p.tagName.toLowerCase(),
        className: firstClassName(p),
        label: humanLabel(p),
      });
      p = p.parentElement;
      if (parents.length > 6) break;
    }
    // Children — immediate only.
    const children = Array.from(selected.children || []).slice(0, 20).map((c) => ({
      tagName: c.tagName.toLowerCase(),
      className: firstClassName(c),
      label: humanLabel(c),
      icon: elementIcon(c),
      textPreview: (c.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
      isText: EDITABLE_TEXT_TAGS.has(c.tagName.toLowerCase()) && !c.querySelector?.("img, svg, video") && !hasBlockChildren(c),
      childCount: c.children?.length || 0,
    }));

    // Current styles the inspector can surface + reset. Prefer inline
    // (explicit override), fall back to computed style so the field
    // shows the element's actual rendered size instead of an empty
    // placeholder. That matters for the font-size stepper, which
    // otherwise starts from 0 and jumps to the 6px clamp on first
    // click.
    const inlineStyle = selected.getAttribute("style") || "";
    const win = selected.ownerDocument?.defaultView;
    const computed = win ? win.getComputedStyle(selected) : null;
    const readStyle = (prop) => {
      const inline = selected.style?.[prop];
      if (inline) return inline;
      if (!computed) return "";
      try { return computed[prop] || ""; } catch { return ""; }
    };

    onSelectionChange({
      moduleId,
      tagName: tag,
      className: firstClassName(selected),
      label: humanLabel(selected),
      icon: elementIcon(selected),
      textSample,
      isEditable,
      isImage,
      alt: isImage ? (selected.getAttribute("alt") || "") : "",
      parents,
      children,
      style: {
        color: readStyle("color"),
        backgroundColor: readStyle("backgroundColor"),
        fontSize: readStyle("fontSize"),
        fontWeight: readStyle("fontWeight"),
        textAlign: readStyle("textAlign"),
        padding: readStyle("padding"),
        margin: readStyle("margin"),
        width: readStyle("width"),
        height: readStyle("height"),
      },
      inlineStyle,
    });
  }, [selected, onSelectionChange, moduleId]);

  // Imperative API exposed to the parent so buttons in the inspector
  // (light DOM, always reliable) can act on the shadow-DOM selection.
  useImperativeHandle(forwardedRef, () => ({
    startEdit: () => {
      if (!selected) return false;
      return !!enterEditModeRef.current?.(selected);
    },
    duplicateSelected: () => {
      if (!selected) return;
      pushUndoSnapshot();
      const clone = selected.cloneNode(true);
      clone.classList.remove("el-selected");
      selected.after(clone);
      setSelected(null);
      setBarPos(null); setSelRect(null);
      notifyRef.current();
    },
    deleteSelected: () => {
      if (!selected) return;
      pushUndoSnapshot();
      selected.remove();
      setSelected(null);
      setBarPos(null); setSelRect(null);
      notifyRef.current();
    },
    openImagePicker: () => {
      if (!selected || selected.tagName !== "IMG") return;
      setImagePicker({ target: selected });
    },
    editAlt: () => {
      if (!selected || selected.tagName !== "IMG") return;
      const current = selected.getAttribute("alt") || "";
      const next = prompt("Alt-text (beskrivning för skärmläsare)", current);
      if (next == null) return;
      pushUndoSnapshot();
      if (next) selected.setAttribute("alt", next);
      else selected.removeAttribute("alt");
      notifyRef.current();
    },
    // Called by the inspector's drag-handle button at dragstart time.
    // Tags the shadow-DOM selection with a tempId marker, returns the
    // payload to stash in dataTransfer. The parent will then call
    // clearDragStyling() in dragend to restore opacity.
    getDragPayload: () => {
      if (!selected || !moduleId) return null;
      const tempId = `drag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      selected.setAttribute("data-editor-moving", tempId);
      const outerHTML = selected.outerHTML;
      const cleanHtml = outerHTML.replace(
        new RegExp(`\\sdata-editor-moving="${tempId}"`),
        ""
      );
      selected.style.opacity = "0.4";
      return { sourceModuleId: moduleId, tempId, outerHTML: cleanHtml };
    },
    clearDragStyling: () => {
      if (!selected) return;
      selected.style.opacity = "";
    },
    // Select a specific ancestor of the current selection. `steps` is
    // how many levels up to walk (1 = parent, 2 = grandparent).
    selectParent: (steps = 1) => {
      const shadow = containerRef.current?.shadowRoot;
      const root = shadow?.querySelector(".preview-root");
      let node = selected;
      for (let i = 0; i < steps; i++) {
        if (!node?.parentElement || node.parentElement === root) return false;
        node = node.parentElement;
      }
      shadow?.querySelectorAll(".el-selected").forEach((el) => el.classList.remove("el-selected"));
      node.classList.add("el-selected");
      setSelected(node);
      return true;
    },
    // Pick a specific immediate child by index (as reported in
    // info.children).
    selectChildByIndex: (index) => {
      const child = selected?.children?.[index];
      if (!child) return false;
      const shadow = containerRef.current?.shadowRoot;
      shadow?.querySelectorAll(".el-selected").forEach((el) => el.classList.remove("el-selected"));
      child.classList.add("el-selected");
      setSelected(child);
      return true;
    },
    // Set a single CSS property on the selected element. Pass null or
    // empty string to unset. Changes notify via the save channel so
    // the edit persists.
    setStyle: (prop, value) => {
      if (!selected) return;
      pushUndoSnapshot();
      if (value == null || value === "") {
        selected.style[prop] = "";
      } else {
        selected.style[prop] = value;
      }
      // Force a re-read of `selected` so onSelectionChange fires with
      // the new style values. React won't refresh state for a mutation
      // on the same reference, so we bump selection by re-setting it.
      setSelected(selected);
      notifyRef.current();
    },
    // Return the outerHTML + a tempId marker for clipboard / drag
    // payloads. Keeps the marker attribute in place on the source DOM
    // so subsequent cut-style operations can locate the element.
    getClipboardPayload: () => {
      if (!selected || !moduleId) return null;
      return {
        sourceModuleId: moduleId,
        tagName: selected.tagName.toLowerCase(),
        label: humanLabel(selected),
        icon: elementIcon(selected),
        textSample: (selected.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
        outerHTML: selected.outerHTML,
      };
    },
    // Paste an outerHTML string at the current selection (after it) or
    // at the end of the page root if nothing is selected.
    pasteHtml: (html) => {
      if (!html) return false;
      pushUndoSnapshot();
      const shadow = containerRef.current?.shadowRoot;
      const root = shadow?.querySelector(".preview-root");
      if (!root) return false;
      const tpl = document.createElement("template");
      tpl.innerHTML = html;
      const node = tpl.content.firstElementChild;
      if (!node) return false;
      if (selected && root.contains(selected)) selected.after(node);
      else root.appendChild(node);
      // Re-tag selectables on the new subtree
      const tagAll = (el) => {
        const tag = el.tagName.toLowerCase();
        if (SELECTABLE.has(tag)) el.setAttribute("data-editor-selectable", "true");
        if (EDITABLE_TEXT_TAGS.has(tag)
            && !el.querySelector("img, svg, video")
            && !hasBlockChildren(el)
            && (el.textContent || "").trim().length > 0) {
          el.setAttribute("data-editor-text", "true");
        }
        for (const c of el.children) tagAll(c);
      };
      tagAll(node);
      resolveAssetRefs(node, logos, assets);
      notifyRef.current();
      return true;
    },
  }), [selected, moduleId, logos, assets]);

  // Pre-substitute alpha-v3 [data-unit] placeholders in the source HTML.
  // We skip the call entirely when there are no units — the selector
  // matches nothing in legacy HTML anyway, but skipping avoids a needless
  // DOMParser round-trip per render. substituteUnits is pure + idempotent
  // so re-running on already-substituted HTML is a no-op.
  const substitutedHtml = useMemo(() => {
    if (!html) return html || "";
    if (!units || units.length === 0) return html;
    try {
      return substituteUnits(html, units);
    } catch (err) {
      // Never let a bad unit break the preview — log and fall through to
      // raw HTML so the author still sees something.
      // eslint-disable-next-line no-console
      console.warn("[HtmlPreview] substituteUnits failed:", err);
      return html;
    }
  }, [html, units]);

  const injectHtml = useCallback((node) => {
    if (!node) return;
    containerRef.current = node;

    if (node.shadowRoot) node.shadowRoot.innerHTML = "";
    const shadow = node.shadowRoot || node.attachShadow({ mode: "open" });

    const pageSize = detectPageSize(substitutedHtml, pageFormat);

    // 1. Brand CSS bundle (fonts, tokens, design-system classes).
    //
    // IMPORTANT: this CSS lives inside a shadow root. `:root` inside a
    // shadow tree doesn't match anything — it only matches document
    // root, which is outside this shadow. If buildStyleBlock emitted
    // `:root{--primary:#004549;...}`, those variables would be defined
    // on document root, not inside the shadow, and `var(--primary)` in
    // every component rule would resolve to undefined (transparent /
    // initial). Rewrite `:root` to `:host` so the custom-property scope
    // lands on the shadow host element and cascades to every descendant
    // inside the shadow.
    if (brandCss) {
      const brandStyle = document.createElement("style");
      brandStyle.textContent = brandCss.replace(/(^|[^:\w-])(:root)\b/g, "$1:host");
      shadow.appendChild(brandStyle);
    }

    // 2. Editor chrome styles (selection, hover, page frame)
    const chrome = document.createElement("style");
    chrome.textContent = `
      :host {
        display: block;
        background: #e5e7eb;
        padding: 12px;
        overflow: auto;
      }
      .page-frame {
        width: ${pageSize.w}mm;
        min-height: ${pageSize.h}mm;
        background: #fff;
        margin: 0 auto;
        box-shadow: 0 4px 24px rgba(0,0,0,0.15);
        transform-origin: top center;
        position: relative;
        overflow: hidden; /* clip bg image to page bounds */
      }
      /* Reflow plan 2026-05-08, Job 4: chapter blocks paginate naturally
         at PDF time, so the editor canvas must grow with content rather
         than clip to one sheet. The dashed line is a tiled background on
         a non-interactive overlay at every paper-size boundary, mirroring
         where Chromium's print engine WILL break the page. The 296.7mm
         band lets the line itself sit on the boundary without rounding
         it off-screen at high zooms. */
      .page-frame.is-chapter {
        height: auto;
        overflow: visible;
      }
      .page-frame.is-chapter > .preview-root {
        min-height: ${pageSize.h}mm;
        height: auto;
      }
      .page-frame.is-chapter > .page-break-rule {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 4;
        /* Solid translucent rule at every 297mm boundary. */
        background-image: repeating-linear-gradient(
          to bottom,
          transparent 0,
          transparent 296.7mm,
          rgba(120, 120, 120, 0.55) 296.7mm,
          rgba(120, 120, 120, 0.55) 297mm
        );
      }
      /* Dashed effect: a horizontally tiled pseudo overlay masked to the
         same boundary band so the line reads as dashes rather than a
         continuous 210mm stroke. Mask support is universal in editor's
         supported browsers (Chromium/Safari/Firefox 2024+). */
      .page-frame.is-chapter > .page-break-rule::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background-image: repeating-linear-gradient(
          to right,
          #fff 0, #fff 3mm, transparent 3mm, transparent 7mm
        );
        -webkit-mask-image: repeating-linear-gradient(
          to bottom,
          transparent 0, transparent 296.7mm,
          #000 296.7mm, #000 297mm
        );
        mask-image: repeating-linear-gradient(
          to bottom,
          transparent 0, transparent 296.7mm,
          #000 296.7mm, #000 297mm
        );
      }
      .page-frame.is-chapter > .page-break-rule > .pb-label {
        position: absolute;
        right: 4mm;
        font: 600 9px/1 ui-sans-serif, system-ui, sans-serif;
        color: rgba(80, 80, 80, 0.7);
        background: rgba(255, 255, 255, 0.9);
        padding: 2px 5px;
        border-radius: 3px;
        transform: translateY(-50%);
      }
      /* When a background layer is present, lift content layers above
         and make the module's internal .page wrapper transparent so
         the image can show through. */
      .page-frame.has-bg > .preview-root,
      .page-frame.has-bg > .preview-root > .page,
      .page-frame.has-bg > .preview-root > * > .page {
        background: transparent !important;
      }
      .page-frame > .preview-root {
        width: 100%;
        min-height: ${pageSize.h}mm;
        box-sizing: border-box;
        position: relative;
        z-index: 2;
      }
      /* Per-module background image + filter layer */
      .page-frame > .page-bg {
        position: absolute;
        inset: 0;
        z-index: 0;
        pointer-events: none;
        background-size: cover;
        background-position: center;
        background-repeat: no-repeat;
      }
      /* Gradient overlay + vignette layer sits above image but below content */
      .page-frame > .page-bg-overlay {
        position: absolute;
        inset: 0;
        z-index: 1;
        pointer-events: none;
      }
      /* When the module HTML already contains a .page wrapper, let it drive
         its own dimensions; otherwise we add padding so raw fragments still
         feel like a page. The needs-padding class is applied from JS. */
      .page-frame > .preview-root.needs-padding {
        padding: var(--mg-top, 20mm) var(--mg-inner, 18mm) var(--mg-bottom, 20mm) var(--mg-outer, 18mm);
      }
      /* 12-column grid overlay, toggled via .show-grid on .page-frame.
         Uses CSS repeating-linear-gradient so it costs nothing at render
         time and doesn't interfere with pointer events. The column width
         is (100% / 12) and the lines are a 1mm-wide semi-transparent
         magenta tint so they stand out against both light and dark
         backgrounds in covers. */
      .page-frame.show-grid::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 5;
        background:
          repeating-linear-gradient(
            to right,
            rgba(232, 88, 143, 0.18) 0,
            rgba(232, 88, 143, 0.18) 1px,
            transparent 1px,
            transparent calc(100% / 12)
          );
        border-left: 1px solid rgba(232, 88, 143, 0.28);
        border-right: 1px solid rgba(232, 88, 143, 0.28);
      }
      /* Overflow marker — a red horizontal bar at the nominal page
         boundary, shown when content exceeds page height. */
      .page-frame .overflow-marker {
        position: absolute;
        left: -6px;
        right: -6px;
        height: 2px;
        background: #c0392b;
        box-shadow: 0 0 0 2px rgba(192, 57, 43, 0.25);
        pointer-events: none;
        z-index: 6;
      }
      .page-frame .overflow-marker::after {
        content: attr(data-label);
        position: absolute;
        right: 0;
        top: -20px;
        background: #c0392b;
        color: #fff;
        font: 600 10px/1 ui-sans-serif, system-ui, sans-serif;
        padding: 3px 6px;
        border-radius: 3px;
        white-space: nowrap;
      }
      ${interactive ? `
      /* Hover affordance — a rose-tinted outline that is impossible to
         miss. Offset + a soft glow so users can tell the cursor is
         targeting a selectable rectangle even over dense content. */
      .preview-root [data-editor-selectable]:hover {
        outline: 2px solid rgba(199, 115, 137, 0.75);
        outline-offset: 2px;
        box-shadow: 0 0 0 4px rgba(199, 115, 137, 0.12);
        cursor: pointer;
        position: relative;
      }
      /* Label pill — hover shows a small rose chip above the element
         so the user can see WHAT they're about to select before
         clicking. Renders via CSS attr() content. */
      .preview-root [data-editor-selectable][data-editor-label]:hover::before {
        content: attr(data-editor-label);
        position: absolute;
        top: -22px;
        left: 0;
        background: #b85a73;
        color: #fff;
        font: 600 10px/1 ui-sans-serif, system-ui, sans-serif;
        padding: 4px 7px;
        border-radius: 4px 4px 4px 0;
        white-space: nowrap;
        pointer-events: none;
        z-index: 50;
        letter-spacing: .02em;
      }
      /* Stronger affordance for text leaves — caret cursor + rose dash. */
      .preview-root [data-editor-text]:hover {
        outline: 2px solid rgba(184, 90, 115, 0.8);
        outline-offset: 2px;
        cursor: text;
      }
      /* Selected element — thick rose border + constant label pill so
         the user always sees what's active even while interacting with
         the inspector. */
      .el-selected {
        outline: 2.5px solid #b85a73 !important;
        outline-offset: 3px;
        box-shadow: 0 0 0 6px rgba(184, 90, 115, 0.18) !important;
        position: relative;
      }
      .el-selected[data-editor-label]::before {
        content: attr(data-editor-label);
        position: absolute;
        top: -24px;
        left: -2px;
        background: #94445b;
        color: #fff;
        font: 700 10.5px/1 ui-sans-serif, system-ui, sans-serif;
        padding: 5px 9px;
        border-radius: 4px 4px 4px 0;
        white-space: nowrap;
        pointer-events: none;
        z-index: 50;
        letter-spacing: .03em;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
      }
      /* Drop zone markers for intra-page reorder */
      .preview-root [data-editor-selectable].dz-before {
        box-shadow: 0 -3px 0 0 #b85a73, 0 0 0 4px rgba(184, 90, 115, 0.12) !important;
      }
      .preview-root [data-editor-selectable].dz-after {
        box-shadow: 0 3px 0 0 #b85a73, 0 0 0 4px rgba(184, 90, 115, 0.12) !important;
      }
      [contenteditable="true"] {
        outline: 2px solid #5b9bd5 !important;
        outline-offset: 2px;
        cursor: text;
        background: rgba(91,155,213,0.06);
      }
      ` : ""}
    `;
    shadow.appendChild(chrome);

    // 3. Page frame sized to detected paper size
    const frame = document.createElement("div");
    const isChapter = blockType === "chapter";
    frame.className =
      "page-frame" +
      (showGrid ? " show-grid" : "") +
      (isChapter ? " is-chapter" : "");
    frame.style.transform = `scale(${zoom})`;
    // Language hint — helps spell-check + hyphenation pick the right
    // dictionary. Default "sv" for Rotor; override via prop.
    if (lang) frame.setAttribute("lang", lang);

    const root = document.createElement("div");
    root.className = "preview-root";

    // Freeform alpha-v3 modules: persistFreeformPages strips the outer
    // <section class="page"> wrapper before storing html_cache (to avoid
    // double-wrapping when render.py adds its own `<div class="page
    // page--freeform">`). Mirror render.py's wrap here so design_system_css's
    // `.page` rules (padding, background, full-bleed treatments) apply
    // identically in the editor preview and in the rendered PDF.
    //
    // Chapter blocks (reflow plan Job 4) use the `.chapter` class instead
    // of `.page` — design-system.css ships sibling rules so the editor
    // canvas grows with content. The render path already unwraps
    // <section class="chapter"> wrappers (see mcp-v2 unwrapSectionPage),
    // so html_cache here is already the chapter's inner HTML.
    if (isChapter) {
      // Reflow plan 2026-05-08, Job 4 + Daniel 2026-05-07 fix: only
      // synth-wrap when the inner HTML doesn't already have a chapter
      // root. Claude's submitted HTML is `<section class="chapter">…
      // </section>` and persistFreeformPages' unwrapSectionPage KEEPS
      // that wrapper. Adding another `.chapter` div on top doubled
      // padding + border + page-break rules — and worse, every
      // editor-save wrote the doubled HTML back to html_cache, so
      // chapters accumulated nested `.chapter` divs over re-edits.
      // Detection: trim leading whitespace + comments and check the
      // first tag's class.
      const trimmed = (substitutedHtml || "").trimStart();
      const m = trimmed.match(/^<(section|div)\b[^>]*\bclass\s*=\s*["']([^"']*)["']/i);
      const alreadyChapterRooted = m && /\bchapter\b/.test(m[2] || "");
      if (alreadyChapterRooted) {
        root.innerHTML = substitutedHtml || "";
      } else {
        root.innerHTML = `<div class="chapter">${substitutedHtml || ""}</div>`;
      }
    } else if (moduleType === "freeform") {
      const pageCls = "page page--freeform" + (background ? " page--has-bg" : "");
      root.innerHTML = `<div class="${pageCls}">${substitutedHtml || ""}</div>`;
    } else {
      root.innerHTML = substitutedHtml || "";
    }

    // If the module HTML does NOT already wrap itself in a .page element,
    // add outer padding so the content doesn't butt up against the paper.
    // Freeform modules always have a .page wrapper now → never .needs-padding.
    if (!root.querySelector(":scope > .page")) {
      root.classList.add("needs-padding");
    }

    // Resolve data-logo / data-asset-ref / chart placeholders before we
    // tag selectables so the rewritten DOM is what the user sees and edits.
    resolveAssetRefs(root, logos, assets);

    // Auto-recolor SVG icons/illustrations with brand tokens. Most
    // templates hard-code hex fills, so the author can't change them
    // by tweaking tokens. Walk every <svg> and:
    //   - If it carries data-recolor="primary|accent|text", that wins
    //     (CSS rule in brand-css.js handles the actual paint).
    //   - Otherwise look at its first shape's existing fill to decide
    //     which token it most likely wanted to be (dark = text, bright
    //     = accent, primary-looking = primary). Rewrite all matching
    //     fills on its descendants to currentColor + set the parent
    //     element's color to the chosen CSS variable.
    root.querySelectorAll("svg").forEach((svg) => {
      if (svg.hasAttribute("data-recolor")) return;
      if (svg.hasAttribute("data-no-recolor")) return;
      // Collect unique fills on descendants
      const shapes = svg.querySelectorAll("path, circle, rect, polygon, ellipse, line, polyline");
      const fills = new Set();
      shapes.forEach((s) => {
        const inlineFill = s.getAttribute("fill");
        const styleFill = (s.getAttribute("style") || "").match(/fill\s*:\s*([^;"]+)/i)?.[1];
        const v = (inlineFill || styleFill || "").trim().toLowerCase();
        if (v && v !== "none" && v !== "currentcolor" && !v.startsWith("url(")) {
          fills.add(v);
        }
      });
      if (fills.size === 0) return; // all transparent or already currentColor
      // Pick the most common hex — crude but good enough
      const primaryFill = fills.values().next().value;
      // Rewrite descendants with matching fill → currentColor
      shapes.forEach((s) => {
        const f = (s.getAttribute("fill") || "").toLowerCase();
        if (f && f === primaryFill) s.setAttribute("fill", "currentColor");
        const style = s.getAttribute("style") || "";
        if (style && /fill\s*:\s*[^;"]+/i.test(style)) {
          s.setAttribute("style", style.replace(/fill\s*:\s*[^;"]+/i, "fill: currentColor"));
        }
      });
      // Give the <svg> a predictable color — use --primary as default,
      // the CSS rule above will take over if the template marks it.
      if (!svg.style.color) svg.style.color = "var(--primary)";
    });

    // Per-module background layer — sits behind the preview content.
    // Rendered as two stacked divs: image (with CSS filter) on bottom,
    // overlay+vignette gradients on top. All optional.
    const hasBackground = background && typeof background === "object" && Object.keys(background).length > 0;
    if (hasBackground) frame.classList.add("has-bg");
    if (hasBackground) {
      const bg = document.createElement("div");
      bg.className = "page-bg";
      bg.setAttribute("aria-hidden", "true");
      // Resolve image source. Prefer image_url when present (direct src
      // that works even if the asset cache hasn't been refreshed after
      // an upload). Falls back to asset_id lookup in the tenant assets
      // list that ships with v2-brand-css.
      let imageUrl = background.image_url || "";
      if (!imageUrl && background.asset_id) {
        const asset = (assets || []).find((a) => String(a.id) === String(background.asset_id));
        imageUrl = asset?.url || asset?.data_uri || "";
      }
      // DEBUG: log so we can see why an image didn't surface
      if (background.asset_id && !imageUrl) {
        console.warn("[HtmlPreview] Background asset_id set but url not resolved:", {
          asset_id: background.asset_id,
          tenantAssets: (assets || []).length,
          sample: (assets || []).slice(0, 3).map((a) => ({ id: a.id, hasUrl: !!a.url })),
        });
      }
      if (imageUrl) {
        bg.style.backgroundImage = `url("${imageUrl}")`;
        bg.style.backgroundSize = background.size === "contain" ? "contain" : "cover";
        bg.style.backgroundPosition = background.position || "center";
        bg.style.backgroundRepeat = "no-repeat";
      }
      // CSS filter stack
      const f = background.filter || {};
      const parts = [];
      if (typeof f.grayscale === "number" && f.grayscale > 0) parts.push(`grayscale(${f.grayscale})`);
      if (typeof f.sepia === "number" && f.sepia > 0) parts.push(`sepia(${f.sepia})`);
      if (typeof f.saturate === "number" && f.saturate !== 1) parts.push(`saturate(${f.saturate})`);
      if (typeof f.contrast === "number" && f.contrast !== 1) parts.push(`contrast(${f.contrast})`);
      if (typeof f.brightness === "number" && f.brightness !== 1) parts.push(`brightness(${f.brightness})`);
      if (typeof f.blur_px === "number" && f.blur_px > 0) parts.push(`blur(${f.blur_px}px)`);
      if (parts.length) bg.style.filter = parts.join(" ");

      // Overlay + vignette as stacked backgrounds on a sibling layer.
      // Using a separate div so filter() above doesn't apply to overlays.
      const overlay = document.createElement("div");
      overlay.className = "page-bg-overlay";
      overlay.setAttribute("aria-hidden", "true");
      const layers = [];
      const ov = background.overlay;
      if (ov && ov.type && ov.type !== "none") {
        const from = ov.from || "rgba(0,0,0,0.4)";
        const to = ov.to || "rgba(0,0,0,0)";
        if (ov.type === "radial") {
          layers.push(`radial-gradient(circle at center, ${from} 0%, ${to} 70%)`);
        } else {
          const angle = typeof ov.angle === "number" ? ov.angle : 180;
          layers.push(`linear-gradient(${angle}deg, ${from} 0%, ${to} 100%)`);
        }
      }
      if (typeof background.vignette === "number" && background.vignette > 0) {
        const strength = Math.max(0, Math.min(1, background.vignette));
        layers.push(`radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,${strength}) 120%)`);
      }
      if (layers.length) overlay.style.backgroundImage = layers.join(", ");

      frame.appendChild(bg);
      frame.appendChild(overlay);
    }

    frame.appendChild(root);

    // Chapter mode: overlay an absolute-positioned page-break-rule
    // sibling that draws dashed lines at every 297mm boundary inside
    // the chapter canvas. CSS in the inline style block above handles
    // the visual; this just inserts the element to anchor those rules.
    // The element pulses to the canvas's full height via top/bottom:0.
    if (isChapter) {
      const breakRule = document.createElement("div");
      breakRule.className = "page-break-rule";
      breakRule.setAttribute("aria-hidden", "true");
      // Note: we don't know how many breaks there are at insert time —
      // the CSS uses a repeating-linear-gradient + mask so it draws
      // automatically at every 297mm interval over the canvas height.
      frame.appendChild(breakRule);
    }

    shadow.appendChild(frame);

    // Tag every selectable element once so hover styles and click handler
    // can find them without walking the tree every mousemove.
    // Also tag "editable-text" leaves so the dbl-click handler can show
    // a stronger affordance (and Claude-style "edit me" hover).
    root.querySelectorAll("*").forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if (SELECTABLE.has(tag)) {
        el.setAttribute("data-editor-selectable", "true");
        // Human label so the CSS ::before pill shows "Siffra" / "KPI-kort"
        // instead of technical tag names when hovered or selected.
        const label = humanLabel(el);
        if (label) el.setAttribute("data-editor-label", label);
        // Mark groups vs leafs so we can style differently if needed
        if (el.children?.length > 0) el.setAttribute("data-editor-group", "true");
      }
      if (EDITABLE_TEXT_TAGS.has(tag)
          && !el.querySelector("img, svg, video")
          && !hasBlockChildren(el)
          && (el.textContent || "").trim().length > 0) {
        el.setAttribute("data-editor-text", "true");
      }
    });

    // Frame size workaround: shadow host needs to reserve space equal to
    // the scaled page so the outer editor can scroll correctly.
    const pxPerMm = 3.78; // 96dpi
    node.style.height = `${(pageSize.h * pxPerMm * zoom) + 40}px`;
    node.style.minWidth = `${(pageSize.w * pxPerMm * zoom) + 40}px`;

    // Overflow detection — runs once the browser has laid out the page.
    // We measure the preview-root's actual scrollHeight (in px) and
    // compare against the nominal page height. If it overflows by more
    // than ~2mm we render a red bar at the page boundary. Requires
    // rAF to wait for font + image layout.
    if (showOverflow) {
      requestAnimationFrame(() => {
        // Remove any stale markers from a previous injection
        frame.querySelectorAll(".overflow-marker").forEach((m) => m.remove());
        const rootEl = frame.querySelector(".preview-root");
        if (!rootEl) return;
        const pageH = pageSize.h * pxPerMm;
        const actualH = rootEl.scrollHeight;
        const overBy = actualH - pageH;
        if (overBy > 8) {
          const marker = document.createElement("div");
          marker.className = "overflow-marker";
          marker.style.top = `${pageH}px`;
          marker.setAttribute(
            "data-label",
            `+${Math.round(overBy / pxPerMm)} mm över sidan`
          );
          frame.appendChild(marker);
          setOverflow({ overBy, pageH, actualH });
        } else {
          setOverflow(null);
        }
      });
    } else {
      setOverflow(null);
    }

    if (!interactive) return;

    // Click → select (or open image picker when clicking an <img>)
    frame.addEventListener("click", (e) => {
      e.stopPropagation();

      // Direct click on an <img> element → treat as "change this image"
      // shortcut. User can still Alt-click to fall back to regular selection.
      if (e.target.tagName === "IMG" && !e.altKey && !e.metaKey) {
        e.preventDefault();
        setImagePicker({ target: e.target });
        return;
      }

      const el = findSelectable(e.target, root);
      if (!el) {
        clearSelection(shadow);
        setSelected(null);
        setBarPos(null); setSelRect(null);
        return;
      }
      // If clicking an already-editable element, let the caret land naturally.
      if (el.getAttribute("contenteditable") === "true") return;

      clearSelection(shadow);
      // Previous selection loses draggable; we only make the CURRENT
      // selection draggable so dragstart can reliably originate from it.
      root.querySelectorAll("[draggable=\"true\"]").forEach((n) =>
        n.removeAttribute("draggable")
      );
      el.classList.add("el-selected");
      el.setAttribute("draggable", "true");
      setSelected(el);

      const rect = el.getBoundingClientRect();
      const containerRect = node.getBoundingClientRect();
      setBarPos({
        left: rect.left - containerRect.left + rect.width / 2 - 80,
        top: rect.top - containerRect.top - 36,
      });
      setSelRect({
        left: rect.left - containerRect.left,
        top: rect.top - containerRect.top,
        width: rect.width,
        height: rect.height,
      });
    });

    // ── Intra-page drag/drop ─────────────────────────────────────
    // When the user drags a selected element and drops it onto
    // another selectable in the same preview, reorder. Drop-Y in the
    // upper half = insert before target; lower half = insert after.
    let localDragSrc = null;
    frame.addEventListener("dragstart", (e) => {
      // Don't hijack if the drag originated in light DOM (inspector
      // drag handle) — those go through the cross-page payload path.
      const srcEl = e.target?.closest?.("[draggable=\"true\"]");
      if (!srcEl || !root.contains(srcEl)) return;
      localDragSrc = srcEl;
      srcEl.style.opacity = "0.4";
      try {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", "local-drag");
      } catch { /* noop */ }
    });

    frame.addEventListener("dragover", (e) => {
      if (!localDragSrc) return;
      const tgt = e.target?.closest?.("[data-editor-selectable]");
      if (!tgt || tgt === localDragSrc || localDragSrc.contains(tgt)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      // Decide before/after by mid-line
      const rect = tgt.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      // Clear all dz markers, then mark the current one.
      root.querySelectorAll(".dz-before, .dz-after").forEach((n) =>
        n.classList.remove("dz-before", "dz-after")
      );
      tgt.classList.add(e.clientY < midY ? "dz-before" : "dz-after");
    });

    frame.addEventListener("drop", (e) => {
      if (!localDragSrc) return;
      const tgt = e.target?.closest?.("[data-editor-selectable]");
      root.querySelectorAll(".dz-before, .dz-after").forEach((n) =>
        n.classList.remove("dz-before", "dz-after")
      );
      if (!tgt || tgt === localDragSrc || localDragSrc.contains(tgt)) return;
      e.preventDefault();
      pushUndoSnapshot();
      const rect = tgt.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) tgt.before(localDragSrc);
      else tgt.after(localDragSrc);
      localDragSrc.style.opacity = "";
      const srcRestored = localDragSrc;
      localDragSrc = null;
      // Notify parent through the save channel.
      const cb = onHtmlChangeRef.current;
      const newHtml = getUpdatedHtml();
      if (newHtml !== null && cb) cb(newHtml);
      // Keep the moved element selected so the user can immediately
      // keep editing / dragging it.
      clearSelection(shadow);
      srcRestored.classList.add("el-selected");
      setSelected(srcRestored);
    });

    frame.addEventListener("dragend", () => {
      if (localDragSrc) localDragSrc.style.opacity = "";
      localDragSrc = null;
      root.querySelectorAll(".dz-before, .dz-after").forEach((n) =>
        n.classList.remove("dz-before", "dz-after")
      );
    });

    // Turn an element into an in-place contenteditable. Factored out so
    // both the double-click gesture and the ✎ button on the element bar
    // can invoke it. Returns true if entering edit mode succeeded.
    const enterEditMode = (el) => {
      if (!el) return false;
      const tag = el.tagName.toLowerCase();
      if (!EDITABLE_TEXT_TAGS.has(tag)) return false;
      if (el.querySelector("img, svg, video")) return false;
      if (hasBlockChildren(el)) return false;

      pushUndoSnapshot();
      el.setAttribute("contenteditable", "true");
      el.setAttribute("spellcheck", "true");
      el.focus();

      const range = node.ownerDocument.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = node.ownerDocument.getSelection?.();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }

      // Forward-declare to allow selectionchange cleanup below to bind
      // to the real finish closure.
      let onSelChange;
      const finish = () => {
        el.removeAttribute("contenteditable");
        el.removeEventListener("blur", finish);
        el.removeEventListener("keydown", onKey);
        el.removeEventListener("mouseup", onMouseup);
        el.removeEventListener("keyup", onMouseup);
        if (onSelChange) {
          shadow.removeEventListener?.("selectionchange", onSelChange);
          node.ownerDocument.removeEventListener("selectionchange", onSelChange);
        }
        setFormatBar(null);
        const newHtml = getUpdatedHtml();
        const cb = onHtmlChangeRef.current;
        if (newHtml !== null && cb) cb(newHtml);
      };
      const onKey = (ev) => {
        if (ev.key === "Escape") { ev.preventDefault(); finish(); return; }
        if (ev.key === "Enter" && !ev.shiftKey) {
          if (tag === "p" || tag === "li") {
            // let browser insert new <p>/<li>
          } else {
            ev.preventDefault();
            finish();
            return;
          }
        }
        const mod = ev.metaKey || ev.ctrlKey;
        if (mod && !ev.altKey) {
          const k = ev.key.toLowerCase();
          if (k === "b") { ev.preventDefault(); execFormat("bold"); return; }
          if (k === "i") { ev.preventDefault(); execFormat("italic"); return; }
          if (k === "u") { ev.preventDefault(); execFormat("underline"); return; }
          if (k === "k") { ev.preventDefault(); promptLink(); return; }
        }
      };
      const onMouseup = () => {
        // Selection inside a shadow root lives on shadowRoot.getSelection()
        // in Chrome/Safari; Firefox still exposes it on document too.
        // Try both and use whichever has a non-collapsed range.
        const shadowSel = shadow.getSelection?.();
        const docSel = node.ownerDocument.getSelection?.();
        const selection =
          shadowSel && !shadowSel.isCollapsed ? shadowSel :
          docSel && !docSel.isCollapsed ? docSel : null;
        if (!selection) { setFormatBar(null); return; }
        const rng = selection.getRangeAt(0);
        const rect = rng.getBoundingClientRect();
        // Anchor the floating toolbar to the outer container div (the
        // one we return from the component), which is the nearest
        // positioned ancestor in light DOM.
        const host = node.parentElement || node;
        const containerRect = host.getBoundingClientRect();
        if (rect.width < 2 && rect.height < 2) { setFormatBar(null); return; }
        setFormatBar({
          left: rect.left - containerRect.left + rect.width / 2 - 110,
          top: rect.top - containerRect.top - 38,
          el,
        });
      };
      // Also re-check on selectionchange — some browsers don't fire
      // mouseup reliably when the selection is grown via keyboard
      // (shift+arrow). Shadow root has its own selectionchange.
      onSelChange = () => onMouseup();
      shadow.addEventListener?.("selectionchange", onSelChange);
      node.ownerDocument.addEventListener("selectionchange", onSelChange);
      el.addEventListener("blur", finish);
      el.addEventListener("keydown", onKey);
      el.addEventListener("mouseup", onMouseup);
      el.addEventListener("keyup", onMouseup);
      return true;
    };
    // Expose through a ref so React handlers in light DOM can call it.
    enterEditModeRef.current = enterEditMode;

    // Double-click text → inline edit (delegates to enterEditMode which
    // is also invoked by the ✎ button on the element bar).
    frame.addEventListener("dblclick", (e) => {
      const el = findSelectable(e.target, root);
      if (!el) return;
      if (!EDITABLE_TEXT_TAGS.has(el.tagName.toLowerCase())) return;
      e.stopPropagation();
      e.preventDefault();
      enterEditMode(el);
    });

    // Drag-n-drop from desktop → open picker prefilled with the file
    frame.addEventListener("dragover", (e) => {
      if (!interactive) return;
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
        frame.style.outline = "2px dashed #004549";
      }
    });
    frame.addEventListener("dragleave", () => {
      frame.style.outline = "";
    });
    frame.addEventListener("drop", async (e) => {
      if (!interactive) return;
      frame.style.outline = "";
      const file = e.dataTransfer?.files?.[0];
      if (!file || !file.type.startsWith("image/")) return;
      e.preventDefault();
      // Find the nearest <img> to the drop coordinates; that's the one
      // we replace. If no <img> is found, ignore.
      const target = shadow.elementFromPoint?.(e.clientX, e.clientY);
      const img = target?.closest?.("img");
      if (!img) return;
      // Open picker with the file already in queue
      setImagePicker({ target: img, prefillFile: file });
    });

    // Undo / Redo — document-level so it fires even when nothing is
    // contenteditable (e.g. after a delete/duplicate action).
    const onDocKey = (ev) => {
      const mod = ev.metaKey || ev.ctrlKey;
      if (!mod || ev.altKey) return;
      const k = ev.key.toLowerCase();
      if (k === "z" && !ev.shiftKey) {
        if (undoStack.current.length === 0) return;
        ev.preventDefault();
        const cur = getUpdatedHtml();
        const prev = undoStack.current.pop();
        if (cur != null) redoStack.current.push(cur);
        restoreHtml(prev);
      } else if ((k === "z" && ev.shiftKey) || k === "y") {
        if (redoStack.current.length === 0) return;
        ev.preventDefault();
        const cur = getUpdatedHtml();
        const next = redoStack.current.pop();
        if (cur != null) undoStack.current.push(cur);
        restoreHtml(next);
      }
    };
    frame.addEventListener("keydown", onDocKey);
    // Also listen globally so Cmd+Z works when focus is outside the
    // shadow (e.g. user just clicked a toolbar button that blurred the
    // contenteditable).
    node.ownerDocument.addEventListener("keydown", onDocKey);
  }, [substitutedHtml, brandCss, logos, assets, zoom, interactive, showGrid, showOverflow, moduleId, moduleType, background]);

  // Re-run injection when structural props change. Callback props are
  // intentionally NOT in this list (they're read via refs above), so
  // parent-driven rerenders don't nuke the shadow DOM + selection.
  useEffect(() => {
    if (containerRef.current) injectHtml(containerRef.current);
  }, [substitutedHtml, brandCss, logos, assets, zoom, interactive, showGrid, showOverflow, moduleType, background, injectHtml]);

  // Make getUpdatedHtml reachable from pushUndoSnapshot's ref callback
  useEffect(() => { getUpdatedHtmlRef.current = getUpdatedHtml; });

  // Keep notifyRef pointed at a fresh closure that reads the latest
  // onHtmlChange prop. Imperative methods call notifyRef.current()
  // after mutating the shadow DOM so the parent picks up the new HTML.
  useEffect(() => {
    notifyRef.current = () => {
      const newHtml = getUpdatedHtml();
      if (newHtml !== null && onHtmlChange) onHtmlChange(newHtml);
    };
  });

  function findSelectable(target, boundary) {
    let el = target;
    while (el && el !== boundary) {
      if (el.getAttribute?.("data-editor-selectable") === "true") return el;
      el = el.parentElement;
    }
    return null;
  }

  function clearSelection(shadow) {
    shadow.querySelectorAll(".el-selected").forEach((el) => el.classList.remove("el-selected"));
  }

  function execFormat(command, value) {
    // Formatting commands work against the current selection inside the
    // shadow DOM. document.execCommand is deprecated but still the only
    // single-call path that mutates a contenteditable selection cleanly
    // across browsers; successor APIs (Selection.modify + insertNode)
    // are many lines of code and less reliable for bold/italic.
    const doc = containerRef.current?.ownerDocument;
    if (!doc) return;
    doc.execCommand(command, false, value ?? undefined);
  }
  function promptLink() {
    const existing = containerRef.current?.ownerDocument?.getSelection?.();
    const hasSelection = existing && !existing.isCollapsed;
    if (!hasSelection) return;
    const url = prompt("Länk-URL (https://…)");
    if (!url) return;
    execFormat("createLink", url);
  }
  /**
   * Replace the live preview HTML with a snapshot (for undo/redo).
   * We bypass onHtmlChange to avoid double-notifying the parent — they'll
   * see the change in the very next getUpdatedHtml().
   */
  function restoreHtml(snap) {
    const shadow = containerRef.current?.shadowRoot;
    const root = shadow?.querySelector(".preview-root");
    if (!root) return;
    root.innerHTML = snap;
    // Re-resolve logos/assets/charts since we just blew away the DOM
    resolveAssetRefs(root, logos, assets);
    // Re-tag selectables
    root.querySelectorAll("*").forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if (SELECTABLE.has(tag)) {
        el.setAttribute("data-editor-selectable", "true");
        const lbl = humanLabel(el);
        if (lbl) el.setAttribute("data-editor-label", lbl);
      }
      if (EDITABLE_TEXT_TAGS.has(tag)
          && !el.querySelector("img, svg, video")
          && !hasBlockChildren(el)
          && (el.textContent || "").trim().length > 0) {
        el.setAttribute("data-editor-text", "true");
      }
    });
    if (onHtmlChange) onHtmlChange(snap);
  }

  function getUpdatedHtml() {
    const shadow = containerRef.current?.shadowRoot;
    if (!shadow) return null;
    const root = shadow.querySelector(".preview-root");
    if (!root) return null;
    // Strip editor-only attributes and resolved src values before returning
    const clone = root.cloneNode(true);
    clone.querySelectorAll("[data-editor-selectable]").forEach((el) =>
      el.removeAttribute("data-editor-selectable")
    );
    clone.querySelectorAll("[data-editor-label]").forEach((el) =>
      el.removeAttribute("data-editor-label")
    );
    clone.querySelectorAll("[data-editor-group]").forEach((el) =>
      el.removeAttribute("data-editor-group")
    );
    clone.querySelectorAll("[data-editor-text]").forEach((el) =>
      el.removeAttribute("data-editor-text")
    );
    clone.querySelectorAll(".dz-before, .dz-after").forEach((el) => {
      el.classList.remove("dz-before", "dz-after");
    });
    clone.querySelectorAll(".el-selected").forEach((el) =>
      el.classList.remove("el-selected")
    );
    clone.querySelectorAll("[contenteditable]").forEach((el) =>
      el.removeAttribute("contenteditable")
    );
    // Unresolve: data-logo / data-asset-ref images should stay as tokens in
    // the saved HTML so smyra-render re-resolves them at PDF render time.
    clone.querySelectorAll("img[data-logo]").forEach((el) => el.removeAttribute("src"));
    clone.querySelectorAll("img[data-asset-ref]").forEach((el) => el.removeAttribute("src"));
    // Remove placeholder chart markup we injected for visual preview only.
    clone.querySelectorAll("[data-chart]").forEach((el) => {
      while (el.firstChild) el.removeChild(el.firstChild);
    });
    return clone.innerHTML;
  }

  function handleDelete() {
    if (!selected) return;
    const tag = selected.tagName.toLowerCase();
    const text = selected.textContent?.slice(0, 30) || tag;
    if (!confirm(`Ta bort ${tag}-element "${text.trim()}"?`)) return;

    pushUndoSnapshot();
    selected.remove();
    setSelected(null);
    setBarPos(null); setSelRect(null);

    const newHtml = getUpdatedHtml();
    if (newHtml !== null && onHtmlChange) onHtmlChange(newHtml);
  }

  function handleDuplicate() {
    if (!selected) return;
    pushUndoSnapshot();
    const clone = selected.cloneNode(true);
    clone.classList.remove("el-selected");
    selected.after(clone);

    setSelected(null);
    setBarPos(null); setSelRect(null);

    const newHtml = getUpdatedHtml();
    if (newHtml !== null && onHtmlChange) onHtmlChange(newHtml);
  }

  if (!html) {
    return <div className="hint">Ingen HTML-cache — spara modulen för att generera preview.</div>;
  }

  // Drag-resize: the handles are simple absolute-positioned divs that
  // sit on the outside of the selection rect. On pointerdown they start
  // tracking movement and set inline width / height via selected.style.
  // Commits + notifies after pointerup so we don't spam htmlChange.
  const resizeStartRef = useRef(null);
  const startResize = useCallback((e, edge) => {
    if (!selected) return;
    e.preventDefault();
    e.stopPropagation();
    const startW = selected.getBoundingClientRect().width;
    const startH = selected.getBoundingClientRect().height;
    resizeStartRef.current = { edge, startX: e.clientX, startY: e.clientY, startW, startH };
    pushUndoSnapshot();
    const onMove = (ev) => {
      const s = resizeStartRef.current;
      if (!s) return;
      const dx = ev.clientX - s.startX;
      const dy = ev.clientY - s.startY;
      // zoom scales the page frame — undo it so drag feels 1:1.
      const z = zoom || 1;
      if (s.edge === "e" || s.edge === "se") {
        selected.style.width = `${Math.max(20, Math.round((s.startW + dx) / z))}px`;
      }
      if (s.edge === "s" || s.edge === "se") {
        selected.style.height = `${Math.max(20, Math.round((s.startH + dy) / z))}px`;
      }
      // Keep the selection rect overlay in sync while dragging.
      const r = selected.getBoundingClientRect();
      const host = containerRef.current?.getBoundingClientRect();
      if (host) {
        setSelRect({
          left: r.left - host.left,
          top: r.top - host.top,
          width: r.width,
          height: r.height,
        });
      }
    };
    const onUp = () => {
      resizeStartRef.current = null;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      const cb = onHtmlChangeRef.current;
      const newHtml = getUpdatedHtml();
      if (newHtml !== null && cb) cb(newHtml);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [selected, zoom, pushUndoSnapshot]);

  return (
    <div style={{ position: "relative" }}>
      <div
        ref={injectHtml}
        style={{
          borderRadius: "12px",
          background: "#e5e7eb",
          overflow: "auto",
          maxHeight: "calc(100vh - 220px)",
        }}
      />
      {interactive && selected && selRect && (
        <>
          {/* Right edge: drag to resize width */}
          <div
            onPointerDown={(e) => startResize(e, "e")}
            title="Dra för att ändra bredd"
            style={{
              position: "absolute",
              left: selRect.left + selRect.width - 4,
              top: selRect.top + selRect.height / 2 - 14,
              width: 8,
              height: 28,
              background: "#b85a73",
              borderRadius: 3,
              border: "1px solid #fff",
              cursor: "ew-resize",
              zIndex: 9,
              boxShadow: "0 1px 4px rgba(0,0,0,.2)",
            }}
          />
          {/* Bottom edge: drag to resize height */}
          <div
            onPointerDown={(e) => startResize(e, "s")}
            title="Dra för att ändra höjd"
            style={{
              position: "absolute",
              left: selRect.left + selRect.width / 2 - 14,
              top: selRect.top + selRect.height - 4,
              width: 28,
              height: 8,
              background: "#b85a73",
              borderRadius: 3,
              border: "1px solid #fff",
              cursor: "ns-resize",
              zIndex: 9,
              boxShadow: "0 1px 4px rgba(0,0,0,.2)",
            }}
          />
          {/* Bottom-right corner: both axes */}
          <div
            onPointerDown={(e) => startResize(e, "se")}
            title="Dra för att ändra bredd + höjd"
            style={{
              position: "absolute",
              left: selRect.left + selRect.width - 6,
              top: selRect.top + selRect.height - 6,
              width: 12,
              height: 12,
              background: "#94445b",
              borderRadius: 2,
              border: "1px solid #fff",
              cursor: "nwse-resize",
              zIndex: 10,
              boxShadow: "0 1px 4px rgba(0,0,0,.25)",
            }}
          />
        </>
      )}
      {interactive && selected && barPos && (
        <div
          style={{
            position: "absolute",
            left: Math.max(0, barPos.left),
            top: Math.max(0, barPos.top),
            display: "flex",
            gap: "2px",
            padding: "3px",
            background: "#2a1f2a",
            borderRadius: "8px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
            zIndex: 10,
          }}
        >
          {/* Drag handle — draggable element in light DOM so browsers
              reliably fire drag events. We read outerHTML from the
              currently-selected shadow-DOM element at dragstart time
              and tag it with a temporary marker the parent uses to
              locate-and-strip on successful drop. */}
          {moduleId && (
            <button
              title="Dra till en annan sida"
              draggable="true"
              onDragStart={(e) => {
                if (!selected || !moduleId) return;
                const tempId = `drag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
                selected.setAttribute("data-editor-moving", tempId);
                const outerHTML = selected.outerHTML;
                const cleanHtml = outerHTML.replace(
                  new RegExp(`\\sdata-editor-moving="${tempId}"`),
                  ""
                );
                try {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData(
                    "application/x-smyra-component",
                    JSON.stringify({ sourceModuleId: moduleId, tempId, outerHTML: cleanHtml })
                  );
                  e.dataTransfer.setData("text/plain", `[komponent: ${selected.tagName.toLowerCase()}]`);
                } catch { /* noop */ }
                selected.style.opacity = "0.4";
                if (onComponentDragStart) {
                  onComponentDragStart({ sourceModuleId: moduleId, tempId, outerHTML: cleanHtml });
                }
              }}
              onDragEnd={() => {
                if (selected) selected.style.opacity = "";
                if (onComponentDragEnd) onComponentDragEnd();
              }}
              style={{
                width: 28, height: 28, borderRadius: 4, border: "none",
                background: "transparent", color: "#fff",
                cursor: "grab", fontSize: 14,
                display: "flex", alignItems: "center", justifyContent: "center",
                userSelect: "none",
              }}
              onMouseDown={(e) => { e.currentTarget.style.cursor = "grabbing"; }}
              onMouseUp={(e) => { e.currentTarget.style.cursor = "grab"; }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#5b9bd5"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              ⋮⋮
            </button>
          )}
          {/* Edit text — enters contenteditable on the selected element.
              Double-click still works as a shortcut. */}
          {selected && EDITABLE_TEXT_TAGS.has(selected.tagName?.toLowerCase?.() || "") && (
            <button
              title="Redigera text"
              onClick={() => {
                const ok = enterEditModeRef.current?.(selected);
                if (!ok) {
                  // Element has block children / img / svg — give a hint.
                  alert("Det här elementet innehåller andra block. Välj ett mer specifikt textfält.");
                }
              }}
              style={{
                width: 28, height: 28, borderRadius: 4, border: "none",
                background: "transparent", color: "#fff", cursor: "pointer",
                fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#2e7b58"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              ✎
            </button>
          )}
          {selected.tagName === "IMG" && (
            <>
              <button
                onClick={() => setImagePicker({ target: selected })}
                title="Byt bild"
                style={{
                  width: 28, height: 28, borderRadius: 4, border: "none",
                  background: "transparent", color: "#fff", cursor: "pointer",
                  fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "#5b9bd5"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                🖼
              </button>
              <button
                onClick={() => {
                  const current = selected.getAttribute("alt") || "";
                  const next = prompt("Alt-text (beskrivning för skärmläsare)", current);
                  if (next == null) return;
                  pushUndoSnapshot();
                  if (next) selected.setAttribute("alt", next);
                  else selected.removeAttribute("alt");
                  const newHtml = getUpdatedHtml();
                  if (newHtml !== null && onHtmlChange) onHtmlChange(newHtml);
                }}
                title="Redigera alt-text"
                style={{
                  width: 28, height: 28, borderRadius: 4, border: "none",
                  background: "transparent", color: "#fff", cursor: "pointer",
                  fontSize: 11, fontWeight: 600,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "#444"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                ALT
              </button>
            </>
          )}
          <button
            onClick={handleDelete}
            title="Ta bort element"
            style={{
              width: 28, height: 28, borderRadius: 4, border: "none",
              background: "transparent", color: "#fff", cursor: "pointer",
              fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "#c0392b"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            🗑
          </button>
          <button
            onClick={handleDuplicate}
            title="Duplicera element"
            style={{
              width: 28, height: 28, borderRadius: 4, border: "none",
              background: "transparent", color: "#fff", cursor: "pointer",
              fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "#444"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            📋
          </button>
        </div>
      )}
      <ImagePickerDialog
        open={!!imagePicker}
        tenantId={tenantId}
        initialTab="library"
        initialAlt={imagePicker?.target?.getAttribute?.("alt") || ""}
        onClose={() => setImagePicker(null)}
        onPick={({ assetId, url, alt }) => {
          const img = imagePicker?.target;
          if (!img) return;
          pushUndoSnapshot();
          // Wire the img to point at the new asset. When assetId is set
          // we use data-asset-ref so PDF render also resolves it from
          // our storage; when only url is given (direct URL), set src
          // directly.
          if (assetId) {
            img.setAttribute("data-asset-ref", assetId);
            img.setAttribute("src", url);
            img.removeAttribute("data-placeholder");
          } else if (url) {
            img.setAttribute("src", url);
            img.removeAttribute("data-asset-ref");
            img.removeAttribute("data-placeholder");
          }
          if (alt) img.setAttribute("alt", alt);
          const newHtml = getUpdatedHtml();
          if (newHtml !== null && onHtmlChange) onHtmlChange(newHtml);
        }}
      />
      {/* Floating text-format toolbar — appears when a range is selected
          inside a contenteditable leaf. Bold / italic / underline /
          link. execCommand still works in shadow DOM for these. */}
      {interactive && formatBar && (
        <div
          style={{
            position: "absolute",
            left: Math.max(0, formatBar.left),
            top: Math.max(0, formatBar.top),
            display: "flex",
            gap: "1px",
            padding: "3px",
            background: "#2a1f2a",
            borderRadius: "8px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
            zIndex: 11,
          }}
          onMouseDown={(e) => e.preventDefault() /* keep selection */}
        >
          {[
            { cmd: "bold",      label: "𝐁", title: "Fetstil (⌘B)" },
            { cmd: "italic",    label: "𝐼", title: "Kursiv (⌘I)" },
            { cmd: "underline", label: "U", title: "Understruken (⌘U)" },
            { cmd: "__link",    label: "🔗", title: "Länk (⌘K)" },
            { cmd: "insertUnorderedList", label: "•", title: "Punktlista" },
            { cmd: "insertOrderedList",   label: "1.", title: "Numrerad lista" },
            { cmd: "removeFormat", label: "⌫", title: "Rensa formatering" },
          ].map(({ cmd, label, title }) => (
            <button
              key={cmd}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (cmd === "__link") return promptLink();
                execFormat(cmd);
              }}
              title={title}
              style={{
                width: 26, height: 26, borderRadius: 4, border: "none",
                background: "transparent", color: "#fff", cursor: "pointer",
                fontSize: label.length > 1 ? 11 : 13,
                fontWeight: cmd === "bold" ? 700 : 500,
                fontStyle: cmd === "italic" ? "italic" : "normal",
                textDecoration: cmd === "underline" ? "underline" : "none",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#5b9bd5"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

export default HtmlPreview;
