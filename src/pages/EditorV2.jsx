import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { useUiStore } from "../stores/uiStore";
import HtmlPreview from "../components/v2/HtmlPreview";
import ModuleInspector from "../components/v2/ModuleInspector";
import "./EditorV2.css";

const MODULE_TYPES = ["cover", "chapter_break", "back_cover", "layout"];

/**
 * Scoped editor opened via HMAC capability token (`/editor/v2?token=...`).
 *
 * Three-pane layout:
 *   ┌───────────── topbar ──────────────┐
 *   │ brand · title · PDF preview       │
 *   ├─────┬─────────────────┬───────────┤
 *   │ nav │ live preview    │ inspector │
 *   │ list│ (brand-styled   │ (structured│
 *   │     │  shadow DOM)    │  fields)   │
 *   └─────┴─────────────────┴───────────┘
 */
export default function EditorV2() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";

  const setEditorAuth = useUiStore((s) => s.setEditorAuth);
  const clearEditorAuth = useUiStore((s) => s.clearEditorAuth);

  const [session, setSession] = useState(null);
  const [report, setReport] = useState(null);
  const [modules, setModules] = useState([]);
  const [brandCss, setBrandCss] = useState("");
  const [logos, setLogos] = useState([]);
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState({});
  const [saveStatus, setSaveStatus] = useState(""); // 'saving' | 'saved' | ''
  const [newType, setNewType] = useState("layout");
  const [adding, setAdding] = useState(false);
  const [renderBusy, setRenderBusy] = useState(false);
  const [pdfUrl, setPdfUrl] = useState("");

  // Debounced save timer for contentEditable live edits
  const saveTimerRef = useRef(null);

  // Verify token + load report + brand CSS
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setError("Ingen token i länken. Be Claude skapa en ny redigeringslänk.");
        setLoading(false);
        return;
      }
      try {
        const res = await fetch(`/api/editor-session?token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        if (cancelled) return;

        const scope = {
          reportId: data.report_id,
          tenantId: data.report?.tenant_id,
          brandId: data.report?.brand_id,
        };
        setEditorAuth(token, scope);
        setSession(data);

        // Load report + modules + editor context (CSS + logos + assets) in parallel
        const [r, ctx] = await Promise.all([
          api.getV2Report(data.report_id),
          api.getV2EditorContext(data.report_id).catch((err) => {
            console.warn("editor context fetch failed:", err);
            return { css: "", logos: [], assets: [] };
          }),
        ]);
        if (cancelled) return;

        setReport(r.item);
        const sorted = [...(r.modules || [])].sort((a, b) => a.order_index - b.order_index);
        setModules(sorted);
        setBrandCss(ctx?.css || "");
        setLogos(ctx?.logos || []);
        setAssets(ctx?.assets || []);
        if (sorted.length > 0) setSelectedId(sorted[0].id);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      clearEditorAuth();
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const selectedModule = useMemo(
    () => modules.find((m) => m.id === selectedId) || null,
    [modules, selectedId]
  );

  // ──────────────── module operations ────────────────

  const onSaveHtml = async (moduleId, newHtml, { silent = false } = {}) => {
    if (!silent) setBusy((b) => ({ ...b, [moduleId]: true }));
    setSaveStatus("saving");
    setError("");
    try {
      const res = await api.updateV2Module(moduleId, { html_content: newHtml });
      setModules((prev) => prev.map((m) => (m.id === moduleId ? res.item : m)));
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus((s) => (s === "saved" ? "" : s)), 1500);
    } catch (err) {
      setError(err.message);
      setSaveStatus("");
    } finally {
      if (!silent) setBusy((b) => ({ ...b, [moduleId]: false }));
    }
  };

  // Debounced save for contentEditable live edits. The HtmlPreview
  // fires onHtmlChange on every commit (blur/Enter); we still debounce
  // so rapid consecutive edits collapse into one PATCH.
  const onLiveHtmlChange = (moduleId, newHtml) => {
    setSaveStatus("saving");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      onSaveHtml(moduleId, newHtml, { silent: true });
    }, 400);
  };

  const onSaveContent = async (moduleId, patch) => {
    setBusy((b) => ({ ...b, [moduleId]: true }));
    setError("");
    try {
      const res = await api.updateV2Module(moduleId, patch);
      setModules((prev) => prev.map((m) => (m.id === moduleId ? res.item : m)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy((b) => ({ ...b, [moduleId]: false }));
    }
  };

  const onDeleteModule = async (mod) => {
    if (!confirm(`Ta bort modul "${mod.module_type}"?`)) return;
    try {
      await api.deleteV2Module(mod.id);
      setModules((prev) => {
        const next = prev.filter((m) => m.id !== mod.id);
        if (selectedId === mod.id) setSelectedId(next[0]?.id ?? null);
        return next;
      });
    } catch (err) {
      setError(err.message);
    }
  };

  const onAddModule = async () => {
    setAdding(true);
    setError("");
    try {
      const defaultContent =
        newType === "layout"
          ? { columns: "full", slots: [{ category: "text", content: {} }] }
          : {};
      const lastId = modules.length ? modules[modules.length - 1].id : null;
      const res = await api.addV2Module({
        report_id: session.report_id,
        module_type: newType,
        content: defaultContent,
        after_module_id: lastId,
      });
      setModules((prev) => [...prev, res.item]);
      setSelectedId(res.item.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  };

  const onRenderDraft = async () => {
    setRenderBusy(true);
    setError("");
    setPdfUrl("");
    try {
      const res = await api.renderV2Pdf({ report_id: session.report_id, mode: "draft" });
      setPdfUrl(res.pdf_url);
    } catch (err) {
      setError(err.message);
    } finally {
      setRenderBusy(false);
    }
  };

  // ──────────────── drag to reorder ────────────────
  const [dragId, setDragId] = useState(null);
  const [dropBeforeId, setDropBeforeId] = useState(null);

  const handleDragStart = (e, id) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  };

  const handleDragOver = (e, id) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropBeforeId(id);
  };

  const handleDrop = async (e, targetId) => {
    e.preventDefault();
    const sourceId = dragId;
    setDragId(null);
    setDropBeforeId(null);
    if (!sourceId || sourceId === targetId) return;

    const sourceIdx = modules.findIndex((m) => m.id === sourceId);
    const targetIdx = modules.findIndex((m) => m.id === targetId);
    if (sourceIdx === -1 || targetIdx === -1) return;

    // Optimistic local reorder
    const next = [...modules];
    const [moved] = next.splice(sourceIdx, 1);
    next.splice(targetIdx, 0, moved);
    // Rewrite indices to stay contiguous for display
    const relabeled = next.map((m, i) => ({ ...m, order_index: i }));
    setModules(relabeled);

    try {
      const res = await api.reorderV2Module(sourceId, targetIdx);
      // Server returns authoritative row — keep other rows as-is
      setModules((prev) => prev.map((m) => (m.id === sourceId ? { ...m, ...res.item } : m)));
    } catch (err) {
      setError(`Kunde inte flytta modul: ${err.message}`);
      // Roll back on failure
      setModules(modules);
    }
  };

  // ──────────────── render ────────────────

  if (loading) {
    return (
      <div className="smyra-editor">
        <div className="loading">
          <div className="spinner" />
          <span>Verifierar redigeringslänk…</span>
        </div>
      </div>
    );
  }

  if (error && !report) {
    return (
      <div className="smyra-editor">
        <div className="editor-wrap">
          <div className="error">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="smyra-editor editor-v2-layout">
      <header className="editor-topbar">
        <div className="editor-brand">
          <div className="editor-brand-mark">✦</div>
          <div className="editor-brand-text">
            <span className="editor-brand-title">{report?.title || "Smyra Editor"}</span>
            <span className="editor-brand-sub">
              {report?.document_type} · {modules.length} moduler
            </span>
          </div>
        </div>
        <div className="editor-topbar-actions">
          {saveStatus === "saving" && <span className="save-pill saving">Sparar…</span>}
          {saveStatus === "saved" && <span className="save-pill saved">✓ Sparat</span>}
          {pdfUrl && (
            <a className="btn-ghost" href={pdfUrl} target="_blank" rel="noopener noreferrer">
              Öppna PDF ↗
            </a>
          )}
          <button
            className="btn"
            type="button"
            disabled={renderBusy}
            onClick={onRenderDraft}
          >
            {renderBusy ? "Renderar…" : "Förhandsgranska PDF"}
          </button>
        </div>
      </header>

      {error ? <div className="error" style={{ margin: "12px 24px" }}>{error}</div> : null}

      <div className="editor-v2-body">
        {/* ─── Left: module navigator ─── */}
        <aside className="editor-sidebar">
          <div className="sidebar-header">
            <span className="sidebar-title">Sidor</span>
            <span className="sidebar-count">{modules.length}</span>
          </div>
          <div className="sidebar-list">
            {modules.map((mod, idx) => (
              <SidebarItem
                key={mod.id}
                module={mod}
                index={idx}
                selected={selectedId === mod.id}
                isDropTarget={dropBeforeId === mod.id}
                isDragging={dragId === mod.id}
                onSelect={() => setSelectedId(mod.id)}
                onDragStart={(e) => handleDragStart(e, mod.id)}
                onDragOver={(e) => handleDragOver(e, mod.id)}
                onDrop={(e) => handleDrop(e, mod.id)}
                onDelete={() => onDeleteModule(mod)}
              />
            ))}
          </div>
          <div className="sidebar-footer">
            <label htmlFor="new-module-type" className="sidebar-addlabel">
              Ny modul
            </label>
            <div className="sidebar-addrow">
              <select
                id="new-module-type"
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
              >
                {MODULE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <button
                className="btn-ghost"
                type="button"
                disabled={adding}
                onClick={onAddModule}
              >
                {adding ? "…" : "+"}
              </button>
            </div>
          </div>
        </aside>

        {/* ─── Middle: live preview ─── */}
        <main className="editor-canvas">
          {selectedModule ? (
            <>
              <div className="canvas-meta">
                <span className="canvas-badge">
                  {(selectedModule.order_index ?? 0) + 1}
                </span>
                <span className="canvas-title">{moduleDisplayName(selectedModule)}</span>
                <span className="canvas-hint">Dubbelklicka på text för att redigera · Klicka på element för att ta bort eller duplicera</span>
              </div>
              <HtmlPreview
                html={selectedModule.html_cache}
                brandCss={brandCss}
                logos={logos}
                assets={assets}
                tenantId={session?.report?.tenant_id || null}
                onHtmlChange={(newHtml) => onLiveHtmlChange(selectedModule.id, newHtml)}
                zoom={0.55}
              />
            </>
          ) : (
            <div className="canvas-empty">
              <p>Ingen modul vald. Välj en från listan till vänster.</p>
            </div>
          )}
        </main>

        {/* ─── Right: inspector ─── */}
        <aside className="editor-inspector">
          {selectedModule ? (
            <ModuleInspector
              module={selectedModule}
              busy={!!busy[selectedModule.id]}
              onSaveContent={(patch) => onSaveContent(selectedModule.id, patch)}
              onDelete={() => onDeleteModule(selectedModule)}
            />
          ) : (
            <p className="hint">Välj en modul för att se fält och åtgärder.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────

function moduleDisplayName(mod) {
  // Prefer explicit title fields from content JSONB.
  const content = mod.content || {};
  if (content.title) return content.title;
  if (content.chapter_title) return content.chapter_title;
  if (content.headline) return content.headline;

  // Then try to extract a heading from html_cache.
  const html = mod.html_cache || "";
  const extracted = extractHeadlineFromHtml(html);
  if (extracted) return extracted;

  return mod.module_type || "Modul";
}

/**
 * Extract a probable headline from arbitrary HTML.
 *
 * Tries in order:
 *   1. First <h1-3>
 *   2. First styled block with font-size ≥ 18pt / ≥ 22px (heading component pattern)
 *   3. First styled block with font-weight ≥ 600
 *   4. First short text-bearing block (< 80 chars)
 */
function extractHeadlineFromHtml(html) {
  if (!html) return "";

  // 1. Real <h1-3>
  const h = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  if (h) {
    const text = stripTags(h[1]).trim();
    if (text.length >= 3 && text.length <= 100) return text;
  }

  // 2. Styled block with large font-size
  const fontSizeRe =
    /<(div|p|span)[^>]*style="[^"]*font-size:\s*(\d+(?:\.\d+)?)(pt|px)[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = fontSizeRe.exec(html)) !== null) {
    const value = parseFloat(m[2]);
    const unit = m[3];
    const isLarge = (unit === "pt" && value >= 18) || (unit === "px" && value >= 22);
    if (!isLarge) continue;
    const text = stripTags(m[4]).trim();
    if (text.length >= 3 && text.length <= 100) return text;
  }

  // 3. Styled block with bold weight
  const fontWeightRe =
    /<(div|p|span)[^>]*style="[^"]*font-weight:\s*(\d+|bold)[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi;
  while ((m = fontWeightRe.exec(html)) !== null) {
    const w = m[2] === "bold" ? 700 : parseInt(m[2], 10);
    if (!Number.isFinite(w) || w < 600) continue;
    const text = stripTags(m[3]).trim();
    if (text.length >= 3 && text.length <= 80) return text;
  }

  // 4. First short <div> / <p> text
  const firstBlock = html.match(/<(div|p)[^>]*>([\s\S]*?)<\/\1>/i);
  if (firstBlock) {
    const text = stripTags(firstBlock[2]).trim();
    if (text.length >= 3 && text.length <= 80) return text;
  }

  return "";
}

function stripTags(s) {
  return String(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function moduleThumbColor(type) {
  const palette = {
    cover: "linear-gradient(160deg, #f5e0ec, #f0bfd6)",
    back_cover: "linear-gradient(160deg, #e5d5f0, #cab2e2)",
    chapter_break: "linear-gradient(160deg, #ffe6cc, #ffc999)",
    layout: "linear-gradient(160deg, #e4f0e4, #c5e0c5)",
    freeform: "linear-gradient(160deg, #e0ebf5, #bcd4ec)",
  };
  return palette[type] || palette.freeform;
}

// ─── SidebarItem ───────────────────────────────────────────────────────
function SidebarItem({
  module: mod,
  index,
  selected,
  isDropTarget,
  isDragging,
  onSelect,
  onDragStart,
  onDragOver,
  onDrop,
  onDelete,
}) {
  return (
    <div
      className={[
        "sidebar-item",
        selected && "is-selected",
        isDropTarget && "is-drop-target",
        isDragging && "is-dragging",
      ].filter(Boolean).join(" ")}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={onSelect}
    >
      <div
        className="sidebar-thumb"
        style={{ background: moduleThumbColor(mod.module_type) }}
      >
        <span className="sidebar-thumb-index">{index + 1}</span>
      </div>
      <div className="sidebar-meta">
        <div className="sidebar-name">{moduleDisplayName(mod)}</div>
        <div className="sidebar-type">{mod.module_type}</div>
      </div>
      <button
        className="sidebar-delete"
        type="button"
        title="Ta bort modul"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        ×
      </button>
    </div>
  );
}
