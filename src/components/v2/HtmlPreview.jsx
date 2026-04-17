import { useCallback, useEffect, useRef, useState } from "react";

const SELECTABLE = new Set([
  "p","h1","h2","h3","h4","h5","h6","hr","img","div","section",
  "blockquote","ul","ol","table","figure","aside","header","footer","pre","dl","span","li","td","th",
]);

const EDITABLE_TEXT_TAGS = new Set([
  "p","h1","h2","h3","h4","h5","h6","span","li","td","th","blockquote","figcaption",
]);

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

  // ── charts rendered as <div data-chart="..."> stay empty in the
  // editor preview (smyra-render generates the SVG on the server).
  // Draw a visible placeholder so the author sees "chart here".
  root.querySelectorAll("[data-chart]").forEach((el) => {
    if (el.childElementCount > 0) return; // already rendered
    const placeholder = document.createElement("div");
    placeholder.textContent = "📊 Diagram (renderas i PDF)";
    placeholder.style.cssText =
      "display:flex;align-items:center;justify-content:center;" +
      "min-height:120px;border:1px dashed rgba(0,0,0,0.25);" +
      "border-radius:6px;color:rgba(0,0,0,0.55);font-size:12px;" +
      "background:rgba(0,0,0,0.03);";
    el.appendChild(placeholder);
  });
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
export default function HtmlPreview({
  html,
  brandCss = "",
  logos = [],
  assets = [],
  onHtmlChange,
  zoom = 0.55,
  interactive = true,
}) {
  const containerRef = useRef(null);
  const [selected, setSelected] = useState(null);
  const [barPos, setBarPos] = useState(null);

  const injectHtml = useCallback((node) => {
    if (!node) return;
    containerRef.current = node;

    if (node.shadowRoot) node.shadowRoot.innerHTML = "";
    const shadow = node.shadowRoot || node.attachShadow({ mode: "open" });

    const pageSize = detectPageSize(html);

    // 1. Brand CSS bundle (fonts, tokens, design-system classes)
    if (brandCss) {
      const brandStyle = document.createElement("style");
      brandStyle.textContent = brandCss;
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
      ${interactive ? `
      .preview-root [data-editor-selectable]:hover {
        outline: 1px dashed rgba(91,155,213,0.55);
        outline-offset: 2px;
        cursor: pointer;
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
    frame.className = "page-frame";
    frame.style.transform = `scale(${zoom})`;

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
    root.querySelectorAll("*").forEach((el) => {
      if (SELECTABLE.has(el.tagName.toLowerCase())) {
        el.setAttribute("data-editor-selectable", "true");
      }
    });

    // Frame size workaround: shadow host needs to reserve space equal to
    // the scaled page so the outer editor can scroll correctly.
    const pxPerMm = 3.78; // 96dpi
    node.style.height = `${(pageSize.h * pxPerMm * zoom) + 40}px`;
    node.style.minWidth = `${(pageSize.w * pxPerMm * zoom) + 40}px`;

    if (!interactive) return;

    // Click → select
    frame.addEventListener("click", (e) => {
      e.stopPropagation();
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
        left: rect.left - containerRect.left + rect.width / 2 - 60,
        top: rect.top - containerRect.top - 36,
      });
    });

    // Double-click text → inline edit
    frame.addEventListener("dblclick", (e) => {
      const el = findSelectable(e.target, root);
      if (!el) return;
      const tag = el.tagName.toLowerCase();
      if (!EDITABLE_TEXT_TAGS.has(tag)) return;
      e.stopPropagation();
      e.preventDefault();

      // Don't step on nested clicks — if the el has complex children with
      // their own meaning (img, svg), refuse.
      if (el.querySelector("img, svg, video")) return;

      el.setAttribute("contenteditable", "true");
      el.focus();

      const finish = () => {
        el.removeAttribute("contenteditable");
        el.removeEventListener("blur", finish);
        el.removeEventListener("keydown", onKey);
        const newHtml = getUpdatedHtml();
        if (newHtml !== null && onHtmlChange) onHtmlChange(newHtml);
      };
      const onKey = (ev) => {
        if (ev.key === "Escape") { ev.preventDefault(); finish(); }
        if (ev.key === "Enter" && !ev.shiftKey && tag !== "p" && tag !== "li") {
          ev.preventDefault();
          finish();
        }
      };
      el.addEventListener("blur", finish);
      el.addEventListener("keydown", onKey);
    });
  }, [html, brandCss, logos, assets, zoom, interactive, onHtmlChange]);

  // Re-run injection when html/brandCss/logos/assets change
  useEffect(() => {
    if (containerRef.current) injectHtml(containerRef.current);
  }, [html, brandCss, logos, assets, zoom, interactive, injectHtml]);

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

    selected.remove();
    setSelected(null);
    setBarPos(null);

    const newHtml = getUpdatedHtml();
    if (newHtml !== null && onHtmlChange) onHtmlChange(newHtml);
  }

  function handleDuplicate() {
    if (!selected) return;
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
    </div>
  );
}
