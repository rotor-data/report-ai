import { useCallback, useEffect, useRef, useState } from "react";

const SELECTABLE = new Set([
  "p","h1","h2","h3","h4","h5","h6","hr","img","div","section",
  "blockquote","ul","ol","table","figure","aside","header","footer","pre","dl","span","li","td","th",
]);

const EDITABLE_TEXT_TAGS = new Set([
  "p","h1","h2","h3","h4","h5","h6","span","li","td","th","blockquote","figcaption",
]);

/**
 * HtmlPreview — renders a module's html_cache in a shadow DOM that mimics
 * the real smyra-render output (A4 page container + brand fonts + tokens
 * + design-system.css utilities), lets the user click elements to select
 * them, delete/duplicate them, and double-click text to edit in place.
 *
 * Props:
 *  - html: string (html_cache from the module)
 *  - brandCss: string — complete CSS bundle from /api/v2-brand-css
 *  - onHtmlChange: (newHtml: string) => void — fired after structural
 *    edits (delete/duplicate) and after contentEditable commits.
 *  - zoom: number (0–1) — visual shrink factor for the A4 preview. Defaults 0.55.
 *  - interactive: boolean — default true. Set false for thumbnail-only rendering.
 */
export default function HtmlPreview({
  html,
  brandCss = "",
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
        width: 210mm;
        min-height: 297mm;
        background: #fff;
        margin: 0 auto;
        box-shadow: 0 4px 24px rgba(0,0,0,0.15);
        transform-origin: top center;
        position: relative;
      }
      .page-frame > .preview-root {
        width: 100%;
        min-height: 297mm;
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

    // 3. A4 page frame
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
    // the scaled A4 page so the outer page can scroll correctly.
    const pageHeightMm = 297;
    const pxPerMm = 3.78; // 96dpi
    node.style.height = `${(pageHeightMm * pxPerMm * zoom) + 40}px`;

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
  }, [html, brandCss, zoom, interactive, onHtmlChange]);

  // Re-run injection when html/brandCss change
  useEffect(() => {
    if (containerRef.current) injectHtml(containerRef.current);
  }, [html, brandCss, zoom, interactive, injectHtml]);

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
    // Strip editor-only attributes before returning
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
