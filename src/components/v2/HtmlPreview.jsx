import { useCallback, useRef, useState } from "react";

const SELECTABLE = new Set([
  "p","h1","h2","h3","h4","h5","h6","hr","img","div","section",
  "blockquote","ul","ol","table","figure","aside","header","footer","pre","dl",
]);

/**
 * HtmlPreview — renders a module's html_cache in a sandboxed shadow DOM,
 * lets the user click elements to select them, and delete/duplicate.
 *
 * Props:
 *  - html: string (html_cache from the module)
 *  - onHtmlChange: (newHtml: string) => void — called when the user edits the HTML
 */
export default function HtmlPreview({ html, onHtmlChange }) {
  const containerRef = useRef(null);
  const [selected, setSelected] = useState(null); // DOM element
  const [barPos, setBarPos] = useState(null);

  const injectHtml = useCallback((node) => {
    if (!node) return;
    containerRef.current = node;

    // Clear previous content
    if (node.shadowRoot) {
      node.shadowRoot.innerHTML = "";
    }
    const shadow = node.shadowRoot || node.attachShadow({ mode: "open" });

    // Inject styles for element selection
    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; }
      .preview-root { position: relative; }
      .preview-root > *:hover { outline: 1px dashed rgba(91,155,213,0.3); outline-offset: 1px; cursor: pointer; }
      .el-selected { outline: 2px solid #e8a838 !important; outline-offset: 1px; }
    `;
    shadow.appendChild(style);

    const root = document.createElement("div");
    root.className = "preview-root";
    root.innerHTML = html || "";
    shadow.appendChild(root);

    // Bind click handler for element selection
    root.addEventListener("click", (e) => {
      e.stopPropagation();
      const el = findSelectable(e.target, root);
      if (!el) {
        clearSelection(shadow);
        setSelected(null);
        setBarPos(null);
        return;
      }
      clearSelection(shadow);
      el.classList.add("el-selected");
      setSelected(el);

      // Position action bar
      const rect = el.getBoundingClientRect();
      const containerRect = node.getBoundingClientRect();
      setBarPos({
        left: rect.left - containerRect.left + rect.width / 2 - 40,
        top: rect.top - containerRect.top - 36,
      });
    });
  }, [html]);

  function findSelectable(target, boundary) {
    let el = target;
    while (el && el !== boundary) {
      if (SELECTABLE.has(el.tagName?.toLowerCase())) return el;
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
    return root ? root.innerHTML : null;
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
          border: "1px solid var(--line-strong)",
          borderRadius: "12px",
          padding: "16px",
          background: "#fff",
          overflow: "auto",
          maxHeight: "600px",
        }}
      />
      {selected && barPos && (
        <div
          style={{
            position: "absolute",
            left: Math.max(0, barPos.left),
            top: Math.max(0, barPos.top),
            display: "flex",
            gap: "2px",
            padding: "3px",
            background: "var(--ink, #2a1f2a)",
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
            onMouseEnter={(e) => { e.target.style.background = "#c0392b"; }}
            onMouseLeave={(e) => { e.target.style.background = "transparent"; }}
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
            onMouseEnter={(e) => { e.target.style.background = "#444"; }}
            onMouseLeave={(e) => { e.target.style.background = "transparent"; }}
          >
            📋
          </button>
        </div>
      )}
    </div>
  );
}
