import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import ImagePickerDialog from "./ImagePickerDialog";

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
};

/**
 * Detect the page format of a module by inspecting its HTML.
 * Precedence:
 *   1. Explicit class hints on a .page element (.page--landscape, .page--a5, .page--letter, ...)
 *   2. Inline width/height style on a .page element
 *   3. Default to A4 portrait
 */
function detectPageSize(html) {
  if (!html) return PAPER_SIZES.a4_portrait;
  const probe = document.createElement("div");
  probe.innerHTML = html;
  const page = probe.querySelector(".page");
  if (!page) return PAPER_SIZES.a4_portrait;

  const cls = page.className || "";
  const has = (t) => cls.includes(t);
  if (has("page--a3-landscape")) return PAPER_SIZES.a3_landscape;
  if (has("page--a3")) return PAPER_SIZES.a3_portrait;
  if (has("page--letter-landscape")) return PAPER_SIZES.letter_landscape;
  if (has("page--letter")) return PAPER_SIZES.letter_portrait;
  if (has("page--a5-landscape")) return PAPER_SIZES.a5_landscape;
  if (has("page--a5")) return PAPER_SIZES.a5_portrait;
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
  onHtmlChange,
  zoom = 0.55,
  interactive = true,
  lang = "sv",
  tenantId = null,
  showGrid = false,
  showOverflow = true,
  moduleId = null,
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

    // Current inline styles the inspector can surface + reset.
    const inlineStyle = selected.getAttribute("style") || "";
    const readStyle = (prop) => selected.style?.[prop] || "";

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
      setBarPos(null);
      notifyRef.current();
    },
    deleteSelected: () => {
      if (!selected) return;
      pushUndoSnapshot();
      selected.remove();
      setSelected(null);
      setBarPos(null);
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

  const injectHtml = useCallback((node) => {
    if (!node) return;
    containerRef.current = node;

    if (node.shadowRoot) node.shadowRoot.innerHTML = "";
    const shadow = node.shadowRoot || node.attachShadow({ mode: "open" });

    const pageSize = detectPageSize(html);

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
      }
      .page-frame > .preview-root {
        width: 100%;
        min-height: ${pageSize.h}mm;
        box-sizing: border-box;
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
      .preview-root [data-editor-selectable]:hover {
        outline: 1px dashed rgba(91,155,213,0.55);
        outline-offset: 2px;
        cursor: pointer;
      }
      /* Stronger affordance for pure-text leaves: user can double-click
         to edit in place. Visual cue: caret cursor on hover. */
      .preview-root [data-editor-text]:hover {
        outline: 1px dashed rgba(232,168,56,0.65);
        outline-offset: 2px;
        cursor: text;
      }
      .el-selected {
        outline: 2px solid #e8a838 !important;
        outline-offset: 2px;
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
    frame.className = "page-frame" + (showGrid ? " show-grid" : "");
    frame.style.transform = `scale(${zoom})`;
    // Language hint — helps spell-check + hyphenation pick the right
    // dictionary. Default "sv" for Rotor; override via prop.
    if (lang) frame.setAttribute("lang", lang);

    const root = document.createElement("div");
    root.className = "preview-root";
    root.innerHTML = html || "";

    // If the module HTML does NOT already wrap itself in a .page element,
    // add outer padding so the content doesn't butt up against the paper.
    if (!root.querySelector(":scope > .page")) {
      root.classList.add("needs-padding");
    }

    // Resolve data-logo / data-asset-ref / chart placeholders before we
    // tag selectables so the rewritten DOM is what the user sees and edits.
    resolveAssetRefs(root, logos, assets);

    frame.appendChild(root);
    shadow.appendChild(frame);

    // Tag every selectable element once so hover styles and click handler
    // can find them without walking the tree every mousemove.
    // Also tag "editable-text" leaves so the dbl-click handler can show
    // a stronger affordance (and Claude-style "edit me" hover).
    root.querySelectorAll("*").forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if (SELECTABLE.has(tag)) {
        el.setAttribute("data-editor-selectable", "true");
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
        setBarPos(null);
        return;
      }
      // If clicking an already-editable element, let the caret land naturally.
      if (el.getAttribute("contenteditable") === "true") return;

      clearSelection(shadow);
      el.classList.add("el-selected");
      setSelected(el);

      const rect = el.getBoundingClientRect();
      const containerRect = node.getBoundingClientRect();
      setBarPos({
        left: rect.left - containerRect.left + rect.width / 2 - 80,
        top: rect.top - containerRect.top - 36,
      });
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

      const finish = () => {
        el.removeAttribute("contenteditable");
        el.removeEventListener("blur", finish);
        el.removeEventListener("keydown", onKey);
        el.removeEventListener("mouseup", onMouseup);
        el.removeEventListener("keyup", onMouseup);
        setFormatBar(null);
        const newHtml = getUpdatedHtml();
        // Use ref so the latest onHtmlChange is reached — injectHtml's
        // useCallback intentionally doesn't depend on onHtmlChange,
        // which means the closure here captures the first-render value.
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
        const selection = node.ownerDocument.getSelection?.();
        if (!selection || selection.isCollapsed) { setFormatBar(null); return; }
        const rng = selection.getRangeAt(0);
        const rect = rng.getBoundingClientRect();
        const containerRect = node.getBoundingClientRect();
        if (rect.width < 2 && rect.height < 2) { setFormatBar(null); return; }
        setFormatBar({
          left: rect.left - containerRect.left + rect.width / 2 - 110,
          top: rect.top - containerRect.top - 38,
          el,
        });
      };
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
  }, [html, brandCss, logos, assets, zoom, interactive, showGrid, showOverflow, moduleId]);

  // Re-run injection when structural props change. Callback props are
  // intentionally NOT in this list (they're read via refs above), so
  // parent-driven rerenders don't nuke the shadow DOM + selection.
  useEffect(() => {
    if (containerRef.current) injectHtml(containerRef.current);
  }, [html, brandCss, logos, assets, zoom, interactive, showGrid, showOverflow, injectHtml]);

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
      if (SELECTABLE.has(tag)) el.setAttribute("data-editor-selectable", "true");
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
    setBarPos(null);

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
    setBarPos(null);

    const newHtml = getUpdatedHtml();
    if (newHtml !== null && onHtmlChange) onHtmlChange(newHtml);
  }

  if (!html) {
    return <div className="hint">Ingen HTML-cache — spara modulen för att generera preview.</div>;
  }

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
