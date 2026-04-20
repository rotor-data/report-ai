import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { useUiStore } from "../stores/uiStore";
import HtmlPreview from "../components/v2/HtmlPreview";
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

  // Module-level undo stack. Snapshots a reversible action, NOT the
  // full state. Each entry has { kind, payload } and the inverse is
  // applied via the regular API calls. Capped at 30.
  //   kind='restore'  — undo a delete; payload carries the deleted row.
  //   kind='delete'   — undo an add or duplicate; payload = { id }.
  //   kind='reorder'  — undo a reorder; payload = { id, originalIdx }.
  const undoRef = useRef([]);
  const [undoCount, setUndoCount] = useState(0);
  const pushUndo = (entry) => {
    undoRef.current.push(entry);
    if (undoRef.current.length > 30) undoRef.current.shift();
    setUndoCount(undoRef.current.length);
  };

  // Available variants per component_type (for inline swap).
  // Cached once per brand so the dropdown is instant.
  const [variants, setVariants] = useState({}); // { [component_type]: [{id, variant_name, label, is_default}] }

  // Design-inspection toggles — persisted to localStorage per-session so
  // the author doesn't have to flip them every time they reload the tab.
  const [showGrid, setShowGrid] = useState(() => {
    try { return localStorage.getItem("smyra-editor-grid") === "1"; } catch { return false; }
  });
  const [showOverflow, setShowOverflow] = useState(() => {
    try { return localStorage.getItem("smyra-editor-overflow") !== "0"; } catch { return true; }
  });
  // Page zoom for the preview. Persisted so the author's preferred
  // level survives reloads. Clamped 0.25 – 1.20 to keep the shadow
  // root within sensible transform bounds.
  const [zoom, setZoom] = useState(() => {
    try {
      const raw = parseFloat(localStorage.getItem("smyra-editor-zoom") || "");
      if (Number.isFinite(raw) && raw >= 0.25 && raw <= 1.2) return raw;
    } catch {}
    return 0.55;
  });
  useEffect(() => {
    try { localStorage.setItem("smyra-editor-grid", showGrid ? "1" : "0"); } catch {}
  }, [showGrid]);
  useEffect(() => {
    try { localStorage.setItem("smyra-editor-overflow", showOverflow ? "1" : "0"); } catch {}
  }, [showOverflow]);
  useEffect(() => {
    try { localStorage.setItem("smyra-editor-zoom", String(zoom)); } catch {}
  }, [zoom]);

  // Cross-page component drag state — used to tell the sidebar which
  // drop type to visualise. `null` = no component drag in progress.
  const [componentDrag, setComponentDrag] = useState(null); // { sourceModuleId, tempId, outerHTML }

  // Imperative refs into each HtmlPreview instance so inspector buttons
  // can drive shadow-DOM selection actions from light DOM.
  const previewRefs = useRef({});
  // Copy/paste buffer for elements. Survives navigation within a session
  // and persists to localStorage so the user can paste after reloading.
  const [clipboard, setClipboard] = useState(() => {
    try {
      const raw = localStorage.getItem("smyra-editor-clipboard");
      if (raw) return JSON.parse(raw);
    } catch {}
    return null;
  });
  useEffect(() => {
    try {
      if (clipboard) localStorage.setItem("smyra-editor-clipboard", JSON.stringify(clipboard));
      else localStorage.removeItem("smyra-editor-clipboard");
    } catch {}
  }, [clipboard]);
  // Transient toast for feedback on copy/paste.
  const [toast, setToast] = useState("");
  const toastTimerRef = useRef(null);
  const flashToast = (msg) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(""), 1400);
  };
  // Current selection info broadcast by whichever HtmlPreview has the
  // live selection. { moduleId, tagName, textSample, isEditable, isImage, alt }.
  const [activeSelection, setActiveSelection] = useState(null);
  const handleSelectionChange = (mod, info) => {
    setActiveSelection((prev) => {
      if (info) return { ...info, moduleId: mod.id };
      // Only clear if *this* module was the source of the current selection —
      // otherwise we'd keep nuking the selection on every re-render pass.
      if (prev?.moduleId === mod.id) return null;
      return prev;
    });
  };

  // Move a component subtree between modules. Source and target are
  // PATCHed in parallel. Uses html_cache as the source of truth (the
  // user is moving the *rendered* element they see, not the template);
  // saving back through html_content ensures smyra-render passes the
  // rendered markup through untouched on re-render.
  const onMoveComponentToModule = async (dragInfo, targetModuleId) => {
    if (!dragInfo || !targetModuleId) return;
    const { sourceModuleId, tempId, outerHTML } = dragInfo;
    if (sourceModuleId === targetModuleId) return;

    const source = modules.find((m) => m.id === sourceModuleId);
    const target = modules.find((m) => m.id === targetModuleId);
    if (!source || !target) return;

    // Strip the moved element from the source's html_cache by locating
    // the [data-editor-moving="tempId"] attribute we set on dragstart.
    const marker = `data-editor-moving="${tempId}"`;
    const srcCache = source.html_cache || "";
    const pos = srcCache.indexOf(marker);
    if (pos === -1) {
      setError("Kunde inte hitta komponenten att flytta — försök igen.");
      return;
    }
    // Walk backwards to the opening `<` of the tag carrying the marker.
    let tagStart = pos;
    while (tagStart > 0 && srcCache[tagStart] !== "<") tagStart--;
    // Identify the tag name so we can find the matching close.
    const tagNameMatch = srcCache.slice(tagStart).match(/^<\s*([a-zA-Z0-9-]+)/);
    if (!tagNameMatch) {
      setError("Kunde inte analysera taggen för att flytta.");
      return;
    }
    const tagName = tagNameMatch[1];
    // Find the closing </tagName> by counting nested opens of the same tag.
    const openRe = new RegExp(`<\\s*${tagName}\\b`, "gi");
    const closeRe = new RegExp(`</\\s*${tagName}\\s*>`, "gi");
    openRe.lastIndex = tagStart + 1;
    let depth = 1;
    let cursor = tagStart + 1;
    let end = -1;
    while (depth > 0) {
      openRe.lastIndex = cursor;
      closeRe.lastIndex = cursor;
      const o = openRe.exec(srcCache);
      const c = closeRe.exec(srcCache);
      if (!c) { break; }
      if (o && o.index < c.index) { depth++; cursor = openRe.lastIndex; }
      else { depth--; cursor = closeRe.lastIndex; if (depth === 0) end = cursor; }
    }
    if (end === -1) {
      setError("Kunde inte matcha avslutande tagg vid flytt.");
      return;
    }
    const newSourceHtml = srcCache.slice(0, tagStart) + srcCache.slice(end);
    const newTargetHtml = (target.html_cache || "") + outerHTML;

    setBusy((b) => ({ ...b, [sourceModuleId]: true, [targetModuleId]: true }));
    setError("");
    try {
      const [srcRes, tgtRes] = await Promise.all([
        api.updateV2Module(sourceModuleId, { html_content: newSourceHtml }),
        api.updateV2Module(targetModuleId, { html_content: newTargetHtml }),
      ]);
      setModules((prev) =>
        prev.map((m) => {
          if (m.id === sourceModuleId) return srcRes.item;
          if (m.id === targetModuleId) return tgtRes.item;
          return m;
        })
      );
      // Optional: jump to the target so the author sees the moved block.
      setSelectedId(targetModuleId);
      pushUndo({
        kind: "move-component",
        payload: {
          sourceModuleId,
          targetModuleId,
          priorSourceHtml: source.html_cache || "",
          priorTargetHtml: target.html_cache || "",
        },
      });
    } catch (err) {
      setError(`Kunde inte flytta komponenten: ${err.message}`);
    } finally {
      setBusy((b) => ({ ...b, [sourceModuleId]: false, [targetModuleId]: false }));
      setComponentDrag(null);
    }
  };

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

  // (selectedModule lookup no longer needed — canvas renders every
  // module via ModuleCard. selectedId is still used as the "active"
  // card highlight and scroll anchor.)

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
      // Locate predecessor so undo can reinsert at the same position.
      const idx = modules.findIndex((m) => m.id === mod.id);
      const afterModuleId = idx > 0 ? modules[idx - 1].id : null;
      await api.deleteV2Module(mod.id);
      pushUndo({
        kind: "restore",
        payload: {
          mod: {
            module_type: mod.module_type,
            content: mod.content || {},
            style: mod.style || {},
            html_content: mod.html_content || null,
          },
          after_module_id: afterModuleId,
        },
      });
      setModules((prev) => {
        const next = prev.filter((m) => m.id !== mod.id);
        if (selectedId === mod.id) setSelectedId(next[0]?.id ?? null);
        return next;
      });
    } catch (err) {
      setError(err.message);
    }
  };

  const onDuplicateModule = async (mod) => {
    try {
      const res = await api.duplicateV2Module(mod.id);
      pushUndo({ kind: "delete", payload: { id: res.item.id } });
      setModules((prev) => {
        const next = [...prev];
        const idx = next.findIndex((m) => m.id === mod.id);
        // Server already renumbered order_index server-side; re-sort
        // for safety, but optimistically splice in for instant feedback.
        next.splice(idx + 1, 0, res.item);
        return next
          .map((m, i) => ({ ...m, order_index: i }))
          .sort((a, b) => a.order_index - b.order_index);
      });
      setSelectedId(res.item.id);
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
      pushUndo({ kind: "delete", payload: { id: res.item.id } });
      setModules((prev) => [...prev, res.item]);
      setSelectedId(res.item.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  };

  // Pop the undo stack and apply the reverse operation. Errors bubble
  // up as banner text rather than silently swallowing.
  const onUndoModuleAction = async () => {
    const entry = undoRef.current.pop();
    setUndoCount(undoRef.current.length);
    if (!entry) return;
    setError("");
    try {
      if (entry.kind === "restore") {
        const { mod, after_module_id } = entry.payload;
        const res = await api.addV2Module({
          report_id: session.report_id,
          module_type: mod.module_type,
          content: mod.content,
          style: mod.style,
          html_content: mod.html_content,
          after_module_id,
        });
        // Re-fetch the full module list so order_index stays in sync
        // with the server (restore shifts other modules).
        const r = await api.getV2Report(session.report_id);
        const sorted = [...(r.modules || [])].sort((a, b) => a.order_index - b.order_index);
        setModules(sorted);
        setSelectedId(res.item.id);
      } else if (entry.kind === "delete") {
        const { id } = entry.payload;
        await api.deleteV2Module(id);
        setModules((prev) => {
          const next = prev.filter((m) => m.id !== id);
          if (selectedId === id) setSelectedId(next[0]?.id ?? null);
          return next;
        });
      } else if (entry.kind === "reorder") {
        const { id, originalIdx } = entry.payload;
        await api.reorderV2Module(id, originalIdx);
        const r = await api.getV2Report(session.report_id);
        const sorted = [...(r.modules || [])].sort((a, b) => a.order_index - b.order_index);
        setModules(sorted);
      } else if (entry.kind === "move-component") {
        const { sourceModuleId, targetModuleId, priorSourceHtml, priorTargetHtml } = entry.payload;
        const [srcRes, tgtRes] = await Promise.all([
          api.updateV2Module(sourceModuleId, { html_content: priorSourceHtml }),
          api.updateV2Module(targetModuleId, { html_content: priorTargetHtml }),
        ]);
        setModules((prev) =>
          prev.map((m) => {
            if (m.id === sourceModuleId) return srcRes.item;
            if (m.id === targetModuleId) return tgtRes.item;
            return m;
          })
        );
      }
    } catch (err) {
      setError(`Kunde inte ångra: ${err.message}`);
    }
  };

  // Variant swap — replace a module's html_content with a different
  // library variant of the same component_type. Pulls the component's
  // template and renders with whatever placeholder values we can extract
  // from the current content JSONB.
  const onSwapVariant = async (mod, componentId) => {
    if (!componentId) return;
    setBusy((b) => ({ ...b, [mod.id]: true }));
    setError("");
    try {
      const comp = await api.getV2Component(componentId);
      // Pass as html_content — server will re-render on PATCH.
      const res = await api.updateV2Module(mod.id, {
        html_content: comp.item?.html_template || "",
      });
      setModules((prev) => prev.map((m) => (m.id === mod.id ? res.item : m)));
    } catch (err) {
      setError(`Kunde inte byta variant: ${err.message}`);
    } finally {
      setBusy((b) => ({ ...b, [mod.id]: false }));
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
    // Component drops (cross-module move) use their own mime type;
    // reorder-drops use text/plain. Check dataTransfer first and
    // branch before the module-reorder path.
    const types = Array.from(e.dataTransfer?.types || []);
    if (types.includes("application/x-smyra-component")) {
      e.preventDefault();
      setDropBeforeId(null);
      try {
        const raw = e.dataTransfer.getData("application/x-smyra-component");
        if (!raw) return;
        const info = JSON.parse(raw);
        await onMoveComponentToModule(info, targetId);
      } catch (err) {
        setError(`Kunde inte flytta komponenten: ${err.message}`);
      }
      return;
    }

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
      pushUndo({
        kind: "reorder",
        payload: { id: sourceId, originalIdx: sourceIdx },
      });
    } catch (err) {
      setError(`Kunde inte flytta modul: ${err.message}`);
      // Roll back on failure
      setModules(modules);
    }
  };

  // Load component library for variant picker, once per brand. We
  // bucket by component_type → array of variants so the dropdown
  // doesn't need to fetch per-module.
  useEffect(() => {
    const brandId = session?.report?.brand_id;
    if (!brandId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.listV2Components(brandId);
        if (cancelled) return;
        const byType = {};
        for (const comp of res.items || []) {
          const t = comp.component_type || "unknown";
          if (!byType[t]) byType[t] = [];
          byType[t].push(comp);
        }
        setVariants(byType);
      } catch (err) {
        console.warn("variant fetch failed:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [session?.report?.brand_id]);

  // Module-level Cmd/Ctrl+Shift+Z → undo module action. Split-key
  // avoids colliding with HtmlPreview's text-edit undo (Cmd+Z), which
  // runs inside the shadow root on its own stack.
  useEffect(() => {
    const onKey = (e) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        onUndoModuleAction();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.report_id, modules, selectedId]);

  // Element clipboard handlers — act on the currently-selected element
  // in whichever preview owns activeSelection.moduleId.
  const onCopyElement = () => {
    const id = activeSelection?.moduleId;
    const payload = previewRefs.current[id]?.getClipboardPayload();
    if (!payload) return;
    setClipboard(payload);
    flashToast(`Kopierad: <${payload.tagName}>`);
  };
  const onPasteElement = async (targetModuleId) => {
    if (!clipboard) return;
    // Default target = the active page (the one the user most recently
    // selected or scrolled to). If an element is selected in another
    // preview, that preview wins — we paste after it.
    const target = targetModuleId
      || activeSelection?.moduleId
      || selectedId
      || (modules.length > 0 ? modules[0].id : null);
    if (!target) return;
    // Try imperative paste-after-selection when the target preview is
    // mounted and has a current selection. Falls back to appending to
    // html_content when the preview ref isn't available (edge case).
    const api = previewRefs.current[target];
    if (api?.pasteHtml) {
      api.pasteHtml(clipboard.outerHTML);
      flashToast(`Klistrat in på sida ${((modules.find((m) => m.id === target)?.order_index ?? 0) + 1)}`);
      pushUndo({ kind: "paste-element", payload: { moduleId: target } });
      return;
    }
    // Fallback: append to html_content and PATCH.
    const mod = modules.find((m) => m.id === target);
    if (!mod) return;
    const nextHtml = (mod.html_cache || "") + clipboard.outerHTML;
    try {
      const res = await api.updateV2Module(target, { html_content: nextHtml });
      setModules((prev) => prev.map((m) => (m.id === target ? res.item : m)));
      flashToast("Klistrat in");
    } catch (err) {
      setError(`Klistra in misslyckades: ${err.message}`);
    }
  };
  // Cmd/Ctrl+C + Cmd/Ctrl+V global bindings. We don't intercept when
  // the user has a native text selection or when the focus is in an
  // input/contenteditable — let the browser handle real text copy/paste.
  useEffect(() => {
    const onKey = (e) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (!cmd || e.shiftKey || e.altKey) return;
      const tgt = e.target;
      const isEditingText =
        tgt?.tagName === "INPUT" ||
        tgt?.tagName === "TEXTAREA" ||
        tgt?.closest?.("[contenteditable='true']");
      const hasTextSel = (document.getSelection()?.toString() || "").length > 0;
      if (isEditingText || hasTextSel) return;

      const k = e.key.toLowerCase();
      if (k === "c" && activeSelection) {
        e.preventDefault();
        onCopyElement();
      } else if (k === "v" && clipboard) {
        e.preventDefault();
        onPasteElement();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSelection, clipboard, selectedId, modules]);

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
          <div className="zoom-group" title="Zooma förhandsgranskning">
            <button
              className="btn-ghost zoom-btn"
              type="button"
              onClick={() => setZoom((z) => Math.max(0.25, Math.round((z - 0.05) * 100) / 100))}
              aria-label="Zooma ut"
            >
              −
            </button>
            <input
              className="zoom-slider"
              type="range"
              min="0.25"
              max="1.2"
              step="0.05"
              value={zoom}
              onChange={(e) => setZoom(parseFloat(e.target.value))}
              aria-label="Zoom-reglage"
            />
            <button
              className="btn-ghost zoom-btn"
              type="button"
              onClick={() => setZoom((z) => Math.min(1.2, Math.round((z + 0.05) * 100) / 100))}
              aria-label="Zooma in"
            >
              +
            </button>
            <button
              className="btn-ghost zoom-value"
              type="button"
              onClick={() => setZoom(0.55)}
              title="Återställ zoom till 55%"
            >
              {Math.round(zoom * 100)}%
            </button>
          </div>
          <button
            className="btn-ghost"
            type="button"
            aria-pressed={showGrid}
            onClick={() => setShowGrid((g) => !g)}
            title="Visa 12-kolumners rutnät"
            style={showGrid ? { background: "#faeef3", borderColor: "var(--rose-500)" } : undefined}
          >
            ⊞ Rutnät
          </button>
          <button
            className="btn-ghost"
            type="button"
            aria-pressed={showOverflow}
            onClick={() => setShowOverflow((v) => !v)}
            title="Markera innehåll som spiller över sidan"
            style={showOverflow ? { background: "#faeef3", borderColor: "var(--rose-500)" } : undefined}
          >
            ▼ Överspill
          </button>
          <button
            className="btn-ghost"
            type="button"
            disabled={undoCount === 0}
            onClick={onUndoModuleAction}
            title="Ångra senaste modul-ändring (⌘⇧Z)"
          >
            ↶ Ångra {undoCount > 0 ? `(${undoCount})` : ""}
          </button>
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
      {toast ? <div className="ins-toast">{toast}</div> : null}

      <div className="editor-v2-body editor-v2-body--inspector">
        {/* ─── Left: page navigator (thumbnails, click = scroll) ─── */}
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
                isComponentDropTarget={false /* drop-targets now live on each page card */}
                variants={variants[mod.module_type] || []}
                onSelect={() => {
                  setSelectedId(mod.id);
                  // Scroll the matching card into view.
                  const el = document.getElementById(`module-card-${mod.id}`);
                  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                onDragStart={(e) => handleDragStart(e, mod.id)}
                onDragOver={(e) => handleDragOver(e, mod.id)}
                onDrop={(e) => handleDrop(e, mod.id)}
                onDelete={() => onDeleteModule(mod)}
                onDuplicate={() => onDuplicateModule(mod)}
                onSwapVariant={(id) => onSwapVariant(mod, id)}
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

        {/* ─── Middle: stacked page cards ─── */}
        <main className="editor-canvas editor-canvas--stack">
          {modules.length === 0 ? (
            <div className="canvas-empty">
              <p>Inga moduler ännu. Skapa en från sidolistan till vänster.</p>
            </div>
          ) : (
            modules.map((mod) => (
              <ModuleCard
                key={mod.id}
                module={mod}
                active={selectedId === mod.id}
                brandCss={brandCss}
                logos={logos}
                assets={assets}
                tenantId={session?.report?.tenant_id || null}
                zoom={zoom}
                showGrid={showGrid}
                showOverflow={showOverflow}
                variants={variants[mod.module_type] || []}
                componentDrag={componentDrag}
                busy={!!busy[mod.id]}
                previewRefCb={(api) => {
                  if (api) previewRefs.current[mod.id] = api;
                  else delete previewRefs.current[mod.id];
                }}
                onActivate={() => setSelectedId(mod.id)}
                onLiveHtmlChange={(html) => onLiveHtmlChange(mod.id, html)}
                onComponentDragStart={(info) => setComponentDrag(info)}
                onComponentDragEnd={() => setComponentDrag(null)}
                onMoveComponentHere={(info) => onMoveComponentToModule(info, mod.id)}
                onDuplicate={() => onDuplicateModule(mod)}
                onDelete={() => onDeleteModule(mod)}
                onSwapVariant={(vId) => onSwapVariant(mod, vId)}
                onSaveContent={(patch) => onSaveContent(mod.id, patch)}
                onSelectionChange={(info) => handleSelectionChange(mod, info)}
              />
            ))
          )}
        </main>

        {/* ─── Right: Illustrator-style inspector ─── */}
        <aside className="editor-inspector-v3">
          <InspectorPanels
            modules={modules}
            activeModuleId={selectedId}
            activeSelection={activeSelection}
            variants={variants}
            hasClipboard={!!clipboard}
            onGoToModule={(id) => {
              setSelectedId(id);
              const el = document.getElementById(`module-card-${id}`);
              if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            onStartEdit={() => previewRefs.current[activeSelection?.moduleId]?.startEdit()}
            onDuplicateElement={() => previewRefs.current[activeSelection?.moduleId]?.duplicateSelected()}
            onDeleteElement={() => previewRefs.current[activeSelection?.moduleId]?.deleteSelected()}
            onReplaceImage={() => previewRefs.current[activeSelection?.moduleId]?.openImagePicker()}
            onEditAlt={() => previewRefs.current[activeSelection?.moduleId]?.editAlt()}
            onCopyElement={onCopyElement}
            onPasteElement={() => onPasteElement()}
            onSelectParent={(steps) => previewRefs.current[activeSelection?.moduleId]?.selectParent(steps)}
            onSelectChild={(i) => previewRefs.current[activeSelection?.moduleId]?.selectChildByIndex(i)}
            onSetStyle={(prop, val) => previewRefs.current[activeSelection?.moduleId]?.setStyle(prop, val)}
            onDuplicateModule={(mod) => onDuplicateModule(mod)}
            onDeleteModule={(mod) => onDeleteModule(mod)}
            onSwapVariant={(mod, id) => onSwapVariant(mod, id)}
          />
        </aside>
      </div>
    </div>
  );
}

// ─── ModuleCard ────────────────────────────────────────────────────────
/**
 * A single page in the stacked canvas. Owns:
 *  - a sticky header with index, type badge, inline title, variant swap,
 *    duplicate and delete actions
 *  - the live preview (HtmlPreview)
 *  - the drop target for cross-page component moves — the card's body
 *    highlights rose when a component drag from another module is in
 *    flight.
 */
function ModuleCard({
  module: mod,
  active,
  brandCss,
  logos,
  assets,
  tenantId,
  zoom,
  showGrid,
  showOverflow,
  variants,
  componentDrag,
  busy,
  previewRefCb,
  onActivate,
  onLiveHtmlChange,
  onComponentDragStart,
  onComponentDragEnd,
  onMoveComponentHere,
  onDuplicate,
  onDelete,
  onSwapVariant,
  onSaveContent,
  onSelectionChange,
}) {
  const innerRef = useRef(null);
  // Forward the HtmlPreview imperative handle up to EditorV2 via the
  // callback ref, using a single stable ref node.
  const setRef = useCallback((api) => {
    innerRef.current = api;
    if (previewRefCb) previewRefCb(api);
  }, [previewRefCb]);
  const [hoverDrop, setHoverDrop] = useState(false);
  const isComponentDropCandidate =
    componentDrag && componentDrag.sourceModuleId !== mod.id;

  const onDragOver = (e) => {
    const types = Array.from(e.dataTransfer?.types || []);
    if (!types.includes("application/x-smyra-component")) return;
    if (!isComponentDropCandidate) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setHoverDrop(true);
  };
  const onDragLeave = () => setHoverDrop(false);
  const onDrop = (e) => {
    setHoverDrop(false);
    const types = Array.from(e.dataTransfer?.types || []);
    if (!types.includes("application/x-smyra-component")) return;
    e.preventDefault();
    try {
      const raw = e.dataTransfer.getData("application/x-smyra-component");
      if (!raw) return;
      const info = JSON.parse(raw);
      onMoveComponentHere(info);
    } catch { /* noop */ }
  };

  return (
    <section
      id={`module-card-${mod.id}`}
      className={[
        "module-card",
        active && "is-active",
        hoverDrop && "is-drop-target",
      ].filter(Boolean).join(" ")}
      onClick={onActivate}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="module-card-head">
        <span className="module-card-index">
          {(mod.order_index ?? 0) + 1}
        </span>
        <span className={`module-card-type type-${mod.module_type}`}>
          {mod.module_type}
        </span>
        <span className="module-card-title">{moduleDisplayName(mod)}</span>
        <div className="module-card-actions">
          {variants.length > 1 ? (
            <select
              className="module-card-variant"
              defaultValue=""
              title="Byt variant"
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                const id = e.target.value;
                if (id) onSwapVariant(id);
                e.target.selectedIndex = 0;
              }}
            >
              <option value="" disabled>Byt variant…</option>
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.variant_name || v.label || v.id.slice(0, 6)}
                  {v.is_default ? " ★" : ""}
                </option>
              ))}
            </select>
          ) : null}
          <button
            className="module-card-btn"
            type="button"
            title="Duplicera modul"
            onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
            disabled={busy}
          >
            ⎘
          </button>
          <button
            className="module-card-btn module-card-btn--danger"
            type="button"
            title="Ta bort modul"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            disabled={busy}
          >
            ×
          </button>
        </div>
      </header>

      {isComponentDropCandidate && (
        <div className="module-card-drop-hint">
          Släpp här för att flytta komponenten till sida {(mod.order_index ?? 0) + 1}
        </div>
      )}

      <div className="module-card-preview">
        <HtmlPreview
          ref={setRef}
          html={mod.html_cache}
          brandCss={brandCss}
          logos={logos}
          assets={assets}
          tenantId={tenantId}
          moduleId={mod.id}
          onHtmlChange={onLiveHtmlChange}
          onComponentDragStart={onComponentDragStart}
          onComponentDragEnd={onComponentDragEnd}
          onSelectionChange={onSelectionChange}
          zoom={zoom}
          showGrid={showGrid}
          showOverflow={showOverflow}
        />
      </div>
    </section>
  );
}

// ─── InspectorPanels (Illustrator-style right sidebar) ─────────────────
/**
 * Stacked panels:
 *   • Element  — what's selected + actions (big buttons). Shows a
 *     draggable handle that moves the element to another page.
 *   • Sida     — metadata for the active page + module-level actions.
 *   • Flytta till — quick-picker that lists every page; clicking moves
 *     the selected element there. Reliable alternative to drag-drop.
 *
 * All actions operate via imperative refs into the HtmlPreview, which
 * lets us bypass the brittle shadow-DOM dragstart that the floating
 * element bar depended on.
 */
function InspectorPanels({
  modules,
  activeModuleId,
  activeSelection,
  variants,
  hasClipboard,
  onGoToModule,
  onStartEdit,
  onDuplicateElement,
  onDeleteElement,
  onReplaceImage,
  onEditAlt,
  onCopyElement,
  onPasteElement,
  onSelectParent,
  onSelectChild,
  onSetStyle,
  onDuplicateModule,
  onDeleteModule,
  onSwapVariant,
}) {
  const [structureOpen, setStructureOpen] = useState(true);
  const [actionsOpen, setActionsOpen] = useState(true);
  const [styleOpen, setStyleOpen] = useState(true);
  const [pageOpen, setPageOpen] = useState(true);

  const activeMod = modules.find((m) => m.id === activeModuleId) || null;
  const sel = activeSelection;

  return (
    <div className="ins-root">
      {/* ── Structure: parent crumbs + children list ───────────── */}
      <InsSection
        title="Valt"
        open={structureOpen}
        onToggle={() => setStructureOpen(!structureOpen)}
        subtitle={sel ? sel.label : "Inget valt"}
      >
        {!sel ? (
          <p className="ins-empty">Klicka på ett element i förhandsgranskningen för att börja redigera.</p>
        ) : (
          <>
            {/* "Gå upp" — single button; chain tooltip shows the path. */}
            {sel.parents?.length ? (
              <div className="ins-updrow">
                <button
                  type="button"
                  className="ins-upbtn"
                  onClick={() => onSelectParent(1)}
                  title={
                    "Gå upp till: " +
                    [...sel.parents].reverse().map((p) => p.label).join(" › ")
                  }
                >
                  <span className="ins-upicon">↑</span>
                  <span>{sel.parents[0].label}</span>
                </button>
                {sel.parents.length > 1 && (
                  <button
                    type="button"
                    className="ins-upbtn-small"
                    onClick={() => onSelectParent(sel.parents.length)}
                    title="Gå till översta nivån"
                  >
                    ↖ översta
                  </button>
                )}
              </div>
            ) : null}

            {/* Big label + text/image preview */}
            <div className="ins-heading-row">
              <span className="ins-heading-icon">{sel.icon || "▫"}</span>
              <span className="ins-heading-label">{sel.label}</span>
            </div>

            {sel.textSample ? (
              <div className="ins-sample">{sel.textSample}</div>
            ) : null}

            {/* Children — drill into KPI value, label, trend etc. */}
            {sel.children?.length ? (
              <>
                <div className="ins-children-label">Delar ({sel.children.length})</div>
                <div className="ins-children">
                  {sel.children.map((c, i) => (
                    <button
                      key={i}
                      type="button"
                      className="ins-child"
                      onClick={() => onSelectChild(i)}
                      title={`Välj: ${c.label}`}
                    >
                      <span className="ins-child-icon">{c.icon || "▫"}</span>
                      <span className="ins-child-label">{c.label}</span>
                      {c.textPreview && c.label !== c.textPreview ? (
                        <span className="ins-child-preview">{c.textPreview}</span>
                      ) : null}
                      {c.childCount > 0 ? (
                        <span className="ins-child-count">{c.childCount} delar</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </>
        )}
      </InsSection>

      {/* ── Actions — edit, copy, paste, duplicate, delete ─────── */}
      {sel && (
        <InsSection
          title="Åtgärder"
          open={actionsOpen}
          onToggle={() => setActionsOpen(!actionsOpen)}
        >
          <div className="ins-btn-row">
            {sel.isEditable && (
              <button className="ins-btn ins-btn--primary" type="button" onClick={onStartEdit}>
                <span className="ins-btn-icon">✎</span>
                <span>Redigera text</span>
              </button>
            )}
            {sel.isImage && (
              <button className="ins-btn ins-btn--primary" type="button" onClick={onReplaceImage}>
                <span className="ins-btn-icon">🖼</span>
                <span>Byt bild</span>
              </button>
            )}
          </div>
          <div className="ins-btn-row">
            <button className="ins-btn" type="button" onClick={onCopyElement}>
              <span className="ins-btn-icon">📋</span>
              <span>Kopiera</span>
              <span className="ins-btn-kbd">⌘C</span>
            </button>
            <button
              className="ins-btn"
              type="button"
              disabled={!hasClipboard}
              onClick={onPasteElement}
              title={hasClipboard ? "Klistra in på vald sida" : "Inget kopierat"}
            >
              <span className="ins-btn-icon">📥</span>
              <span>Klistra in</span>
              <span className="ins-btn-kbd">⌘V</span>
            </button>
          </div>
          <div className="ins-btn-row">
            <button className="ins-btn" type="button" onClick={onDuplicateElement}>
              <span className="ins-btn-icon">⎘</span>
              <span>Duplicera</span>
            </button>
            {sel.isImage && (
              <button className="ins-btn" type="button" onClick={onEditAlt}>
                <span className="ins-btn-icon">ALT</span>
                <span>Alt-text</span>
              </button>
            )}
            <button className="ins-btn ins-btn--danger" type="button" onClick={onDeleteElement}>
              <span className="ins-btn-icon">🗑</span>
              <span>Ta bort</span>
            </button>
          </div>
        </InsSection>
      )}

      {/* ── Style ──────────────────────────────────────────────── */}
      {sel && (
        <InsSection
          title="Stil"
          open={styleOpen}
          onToggle={() => setStyleOpen(!styleOpen)}
        >
          <div className="ins-style-grid">
            <label className="ins-style-label">Textfärg</label>
            <ColorField
              value={sel.style?.color}
              onChange={(v) => onSetStyle("color", v)}
              onReset={() => onSetStyle("color", "")}
            />

            <label className="ins-style-label">Bakgrund</label>
            <ColorField
              value={sel.style?.backgroundColor}
              onChange={(v) => onSetStyle("backgroundColor", v)}
              onReset={() => onSetStyle("backgroundColor", "")}
            />

            <label className="ins-style-label">Textstorlek</label>
            <FontSizeField
              value={sel.style?.fontSize}
              onChange={(v) => onSetStyle("fontSize", v)}
              onReset={() => onSetStyle("fontSize", "")}
            />

            <label className="ins-style-label">Tjocklek</label>
            <select
              className="ins-select"
              value={sel.style?.fontWeight || ""}
              onChange={(e) => onSetStyle("fontWeight", e.target.value || "")}
            >
              <option value="">—</option>
              <option value="300">Light (300)</option>
              <option value="400">Regular (400)</option>
              <option value="500">Medium (500)</option>
              <option value="600">Semibold (600)</option>
              <option value="700">Bold (700)</option>
              <option value="800">Extra Bold (800)</option>
            </select>

            <label className="ins-style-label">Justering</label>
            <select
              className="ins-select"
              value={sel.style?.textAlign || ""}
              onChange={(e) => onSetStyle("textAlign", e.target.value || "")}
            >
              <option value="">—</option>
              <option value="left">Vänster</option>
              <option value="center">Centrerad</option>
              <option value="right">Höger</option>
              <option value="justify">Marginaljust.</option>
            </select>

            <label className="ins-style-label">Padding</label>
            <input
              type="text"
              className="ins-number-value"
              style={{ width: "100%" }}
              placeholder="t.ex. 12px 16px"
              value={sel.style?.padding || ""}
              onChange={(e) => onSetStyle("padding", e.target.value)}
            />
          </div>
        </InsSection>
      )}

      {/* ── Page panel ─────────────────────────────────────────── */}
      <InsSection
        title="Sida"
        open={pageOpen}
        onToggle={() => setPageOpen(!pageOpen)}
        subtitle={activeMod ? `${(activeMod.order_index ?? 0) + 1} · ${activeMod.module_type}` : "—"}
      >
        {!activeMod ? (
          <p className="ins-empty">Välj en sida i mittkolumnen.</p>
        ) : (
          <>
            <div className="ins-page-title">{moduleDisplayName(activeMod)}</div>
            {variants[activeMod.module_type] && variants[activeMod.module_type].length > 1 && (
              <div className="ins-row">
                <label className="ins-label">Variant</label>
                <select
                  className="ins-select"
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) onSwapVariant(activeMod, e.target.value);
                    e.target.selectedIndex = 0;
                  }}
                >
                  <option value="" disabled>Byt variant…</option>
                  {variants[activeMod.module_type].map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.variant_name || v.label || v.id.slice(0, 6)}
                      {v.is_default ? " ★" : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="ins-btn-row">
              <button className="ins-btn" type="button" onClick={() => onDuplicateModule(activeMod)}>
                <span className="ins-btn-icon">⎘</span>
                <span>Duplicera sida</span>
              </button>
              <button className="ins-btn ins-btn--danger" type="button" onClick={() => onDeleteModule(activeMod)}>
                <span className="ins-btn-icon">🗑</span>
                <span>Ta bort sida</span>
              </button>
            </div>
          </>
        )}
      </InsSection>
    </div>
  );
}

// ─── Style field helpers ────────────────────────────────────────
function ColorField({ value, onChange, onReset }) {
  // Normalise to a hex color for the <input type=color> display.
  // If value is a CSS name or rgb(), fall back to the browser default.
  const hex = toHex(value);
  return (
    <div className="ins-color-row">
      <input
        type="color"
        className="ins-color-input"
        value={hex || "#000000"}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Färgväljare"
      />
      <input
        type="text"
        className="ins-number-value"
        style={{ flex: 1, minWidth: 0 }}
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder="—"
      />
      {value ? <button type="button" className="ins-color-reset" onClick={onReset}>Rensa</button> : null}
    </div>
  );
}

function FontSizeField({ value, onChange, onReset }) {
  const current = parseFloat(value) || 0;
  const unit = (String(value || "").match(/(px|pt|em|rem)$/) || [null, "px"])[1];
  return (
    <div className="ins-number-row">
      <button type="button" className="ins-number-btn" onClick={() => onChange(`${Math.max(6, current - 1)}${unit}`)}>−</button>
      <input
        type="text"
        className="ins-number-value"
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder="—"
      />
      <button type="button" className="ins-number-btn" onClick={() => onChange(`${Math.max(6, current + 1)}${unit}`)}>+</button>
      {value ? <button type="button" className="ins-color-reset" onClick={onReset}>Rensa</button> : null}
    </div>
  );
}

function toHex(color) {
  if (!color) return "";
  if (color.startsWith("#")) {
    if (color.length === 4) return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
    return color.length >= 7 ? color.slice(0, 7) : "";
  }
  const m = color.match(/^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (!m) return "";
  const hex2 = (n) => Number(n).toString(16).padStart(2, "0");
  return `#${hex2(m[1])}${hex2(m[2])}${hex2(m[3])}`;
}

function InsSection({ title, subtitle, open, onToggle, children }) {
  return (
    <section className={`ins-section${open ? " is-open" : ""}`}>
      <button type="button" className="ins-section-head" onClick={onToggle}>
        <span className={`ins-chev${open ? " is-open" : ""}`}>▸</span>
        <span className="ins-section-title">{title}</span>
        {subtitle ? <span className="ins-section-sub">{subtitle}</span> : null}
      </button>
      {open && <div className="ins-section-body">{children}</div>}
    </section>
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
  isComponentDropTarget,
  variants,
  onSelect,
  onDragStart,
  onDragOver,
  onDrop,
  onDelete,
  onDuplicate,
  onSwapVariant,
}) {
  const hasVariants = Array.isArray(variants) && variants.length > 1;
  return (
    <div
      className={[
        "sidebar-item",
        selected && "is-selected",
        isDropTarget && "is-drop-target",
        isDragging && "is-dragging",
        isComponentDropTarget && "is-component-drop-target",
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
        {hasVariants && selected ? (
          <select
            className="sidebar-variant-select"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const id = e.target.value;
              if (id) onSwapVariant(id);
              e.target.selectedIndex = 0; // reset to placeholder
            }}
            defaultValue=""
            title="Byt variant"
          >
            <option value="" disabled>
              Byt variant…
            </option>
            {variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.variant_name || v.label || v.id.slice(0, 6)}
                {v.is_default ? " ★" : ""}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="sidebar-actions">
        <button
          className="sidebar-dup"
          type="button"
          title="Duplicera modul"
          onClick={(e) => {
            e.stopPropagation();
            onDuplicate();
          }}
        >
          ⎘
        </button>
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
    </div>
  );
}
