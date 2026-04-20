import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { useUiStore } from "../stores/uiStore";
import HtmlPreview from "../components/v2/HtmlPreview";
import ImagePickerDialog from "../components/v2/ImagePickerDialog";
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
  // Active tokens = brand tokens merged with report-level overrides.
  // Used by the "Rapport-stil" panel so controls reflect what's in
  // effect (primary / accent / text / bg + heading/body font).
  const [tokens, setTokens] = useState({});
  const [brandTokens, setBrandTokens] = useState({}); // pristine brand defaults for "Återställ"
  const [overrides, setOverrides] = useState({}); // per-report overrides

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
        setTokens(ctx?.tokens || {});
        setBrandTokens(ctx?.brand_tokens || {});
        setOverrides(ctx?.overrides || r.item?.style_overrides || {});
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
  // library variant of the same component_type. The template comes in
  // with {{PLACEHOLDER}} tokens; we extract matching text from the
  // currently-rendered html_cache (by heuristic — heading tags, hero
  // classes etc.) and splice it into the template so the user doesn't
  // lose their copy when switching e.g. "Editorial" → "Minimal" cover.
  const onSwapVariant = async (mod, componentId) => {
    if (!componentId) return;
    setBusy((b) => ({ ...b, [mod.id]: true }));
    setError("");
    try {
      const comp = await api.getV2Component(componentId);
      const template = comp.item?.html_template || "";
      const carry = extractTextsForVariantCarry(mod.html_cache || "");
      const filled = fillTemplatePlaceholders(template, carry);
      const res = await api.updateV2Module(mod.id, { html_content: filled });
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

  // Per-page background patch. Writes to v2_report_modules.background
  // with debouncing, updates local module state so HtmlPreview picks
  // up the change instantly (layer re-renders without touching
  // html_cache).
  const bgSaveTimerRef = useRef({});
  const patchModuleBackground = (moduleId, partial) => {
    setModules((prev) =>
      prev.map((m) => {
        if (m.id !== moduleId) return m;
        // Merge partial into existing background, stripping empty keys
        // so "clear" semantics work (pass {asset_id: null} to remove).
        const next = { ...(m.background || {}) };
        for (const [k, v] of Object.entries(partial)) {
          if (v === null || v === undefined) delete next[k];
          else next[k] = v;
        }
        // Queue debounced save
        if (bgSaveTimerRef.current[moduleId]) clearTimeout(bgSaveTimerRef.current[moduleId]);
        bgSaveTimerRef.current[moduleId] = setTimeout(async () => {
          try {
            await api.updateV2Module(moduleId, { background: next });
            setSaveStatus("saved");
            setTimeout(() => setSaveStatus((s) => (s === "saved" ? "" : s)), 1200);
          } catch (err) {
            setError(`Kunde inte spara bakgrund: ${err.message}`);
          }
        }, 450);
        setSaveStatus("saving");
        return { ...m, background: next };
      })
    );
  };
  const clearModuleBackground = (moduleId) => {
    setModules((prev) =>
      prev.map((m) => {
        if (m.id !== moduleId) return m;
        if (bgSaveTimerRef.current[moduleId]) clearTimeout(bgSaveTimerRef.current[moduleId]);
        bgSaveTimerRef.current[moduleId] = setTimeout(async () => {
          try {
            await api.updateV2Module(moduleId, { background: {} });
            setSaveStatus("saved");
            setTimeout(() => setSaveStatus((s) => (s === "saved" ? "" : s)), 1200);
          } catch (err) {
            setError(`Kunde inte rensa bakgrund: ${err.message}`);
          }
        }, 200);
        setSaveStatus("saving");
        return { ...m, background: {} };
      })
    );
  };

  // Report-level style overrides (Rapport-stil panel). Writes to
  // v2_reports.style_overrides and live-patches the existing brand
  // CSS so the shadow-DOM preview reflects the change immediately
  // without re-building every page. Debounced so color-picker drags
  // don't spam the API.
  const saveStyleTimerRef = useRef(null);
  const patchStyleOverride = (key, value) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (value === null || value === "") delete next[key];
      else next[key] = value;
      // Merged tokens follow suit so the panel and :host vars agree.
      setTokens((t) => {
        const merged = { ...brandTokens, ...next };
        // Live-rewrite brandCss's :host (was :root) line for this key
        // so existing preview shadow roots update instantly.
        setBrandCss((css) => rewriteTokenInCss(css, key, merged[key]));
        return merged;
      });
      // Debounced save
      if (saveStyleTimerRef.current) clearTimeout(saveStyleTimerRef.current);
      saveStyleTimerRef.current = setTimeout(async () => {
        try {
          await api.patchV2Report(session.report_id, { style_overrides: next });
          setSaveStatus("saved");
          setTimeout(() => setSaveStatus((s) => (s === "saved" ? "" : s)), 1200);
        } catch (err) {
          setError(`Kunde inte spara stil: ${err.message}`);
        }
      }, 450);
      return next;
    });
    setSaveStatus("saving");
  };

  // Element clipboard handlers — act on the currently-selected element
  // in whichever preview owns activeSelection.moduleId.
  const onCopyElement = () => {
    const id = activeSelection?.moduleId;
    const payload = previewRefs.current[id]?.getClipboardPayload();
    if (!payload) return;
    setClipboard(payload);
    flashToast(`Kopierad: ${payload.label || payload.tagName}`);
  };
  // Cut = copy + delete in one gesture.
  const onCutElement = () => {
    const id = activeSelection?.moduleId;
    const api = previewRefs.current[id];
    const payload = api?.getClipboardPayload();
    if (!payload) return;
    setClipboard(payload);
    api?.deleteSelected();
    flashToast(`Klippt ut: ${payload.label || payload.tagName}`);
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
      } else if (k === "x" && activeSelection) {
        e.preventDefault();
        onCutElement();
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
                clipboard={clipboard}
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
                onPasteHere={() => onPasteElement(mod.id)}
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
            tokens={tokens}
            brandTokens={brandTokens}
            overrides={overrides}
            onStyleOverride={patchStyleOverride}
            onResetOverride={(key) => patchStyleOverride(key, "")}
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
            onCutElement={onCutElement}
            onPasteElement={() => onPasteElement()}
            clipboardInfo={clipboard}
            onClearClipboard={() => setClipboard(null)}
            onSelectParent={(steps) => previewRefs.current[activeSelection?.moduleId]?.selectParent(steps)}
            onSelectChild={(i) => previewRefs.current[activeSelection?.moduleId]?.selectChildByIndex(i)}
            onSetStyle={(prop, val) => previewRefs.current[activeSelection?.moduleId]?.setStyle(prop, val)}
            onDuplicateModule={(mod) => onDuplicateModule(mod)}
            onDeleteModule={(mod) => onDeleteModule(mod)}
            onSwapVariant={(mod, id) => onSwapVariant(mod, id)}
            tenantAssets={assets}
            tenantId={session?.report?.tenant_id || null}
            onPatchBackground={(moduleId, partial) => patchModuleBackground(moduleId, partial)}
            onClearBackground={(moduleId) => clearModuleBackground(moduleId)}
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
  clipboard,
  busy,
  previewRefCb,
  onActivate,
  onLiveHtmlChange,
  onComponentDragStart,
  onComponentDragEnd,
  onMoveComponentHere,
  onPasteHere,
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
          {clipboard ? (
            <button
              className="module-card-paste"
              type="button"
              title={`Klistra in "${clipboard.label || clipboard.tagName}" på denna sida`}
              onClick={(e) => { e.stopPropagation(); onPasteHere(); }}
              disabled={busy}
            >
              📥 Klistra in
            </button>
          ) : null}
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
          background={mod.background || null}
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
// ─── Variant-swap text carry ────────────────────────────────────────
/**
 * Pull the copy out of a rendered module so we can splice it into a
 * sibling variant template. Maps common placeholders (TITLE, SUBTITLE,
 * BODY, KICKER, AUTHOR, DATE, QUOTE, CITATION) from semantic HTML cues.
 * Falls back to ordinal heading positions when no class hints exist.
 */
function extractTextsForVariantCarry(html) {
  if (!html || typeof html !== "string") return {};
  const out = {};
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return {};
  }

  const firstText = (sel) => {
    for (const s of sel.split(",")) {
      const el = doc.querySelector(s.trim());
      if (!el) continue;
      const t = (el.textContent || "").trim();
      if (t) return t;
    }
    return "";
  };

  // Primary title: explicit class first, then biggest heading
  out.TITLE =
    firstText("[data-placeholder=TITLE], .cov-title, .cov-hero__title, .hero-title, .title, h1") ||
    firstText("h1, h2");
  out.SUBTITLE =
    firstText("[data-placeholder=SUBTITLE], .cov-subtitle, .subtitle, .hero-subtitle, .deck, .tagline") ||
    firstText("h2, h3");
  out.KICKER =
    firstText("[data-placeholder=KICKER], .kicker, .eyebrow, .cov-kicker, .overline");
  out.BODY =
    firstText("[data-placeholder=BODY], .cov-body, .body, .intro, .lead, p");
  out.AUTHOR =
    firstText("[data-placeholder=AUTHOR], .author, .byline, .cov-author");
  out.DATE =
    firstText("[data-placeholder=DATE], .date, .cov-date, time");
  out.QUOTE =
    firstText("[data-placeholder=QUOTE], .pullquote, blockquote");
  out.CITATION =
    firstText("[data-placeholder=CITATION], .citation, cite, .pullquote-cite");

  // Chapter break specific
  out.CHAPTER_NUMBER = firstText("[data-placeholder=CHAPTER_NUMBER], .chapter-number, .chap-num");
  out.CHAPTER_TITLE = firstText("[data-placeholder=CHAPTER_TITLE], .chapter-title");

  // Drop empty entries so fillTemplatePlaceholders leaves the template
  // default for anything we couldn't map.
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
}

/**
 * Substitute {{KEY}} tokens in a template with values. Unknown tokens
 * are left in place — smyra-render uses its own placeholder pipeline
 * at PDF time which will fill / strip anything we didn't handle here.
 */
function fillTemplatePlaceholders(template, values) {
  if (!template) return template;
  return template.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
    return match;
  });
}

// ─── Token → CSS variable mapping ───────────────────────────────────
// Keys must match v2-brand-css.js buildTokenCss so overrides surface
// in the emitted stylesheet. Font keys quote the value (single quotes)
// so rewriteTokenInCss produces `--font-heading: 'Playfair Display', …`.
const TOKEN_CSS_VAR = {
  primary_color: "--primary",
  accent_color: "--accent",
  text_color: "--text",
  bg_color: "--bg",
  surface_color: "--surface",
  border_color: "--border",
  link_color: "--link",
  font_display: "--font-display",
  font_heading: "--font-heading",
  font_body: "--font-body",
  base_font_size: "--base-font-size",
};
// Which keys store fonts (affects how values are serialised — fonts
// are wrapped in quotes server-side).
const FONT_KEYS = new Set(["font_display", "font_heading", "font_body"]);

/**
 * Rewrite a single `--foo: <value>;` line inside the brand CSS string
 * so the shadow root picks up changes without needing to re-build every
 * module. Falls through when the variable isn't present (first use).
 */
function rewriteTokenInCss(css, tokenKey, newValue) {
  if (!css) return css;
  const varName = TOKEN_CSS_VAR[tokenKey];
  if (!varName) return css;
  // Format value per token type:
  //  - base_font_size: bare number → "11pt"
  //  - empty → "unset" so cascade reverts to brand defaults
  //  - everything else (colors, fonts): pasted raw
  let cssValue;
  if (!newValue && newValue !== 0) {
    cssValue = "unset";
  } else if (tokenKey === "base_font_size" && /^\d+(\.\d+)?$/.test(String(newValue).trim())) {
    cssValue = `${newValue}pt`;
  } else {
    cssValue = newValue;
  }
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${escaped}\\s*:\\s*)[^;\\n]*`, "g");
  // Always append a late :host rule so overrides win the cascade even
  // when the server-baked document_css already has a :root version.
  const override = `\n:host{${varName}:${cssValue};}`;
  if (!re.test(css)) return css + override;
  // Replace inline + still append override block so :host beats :root
  // (shadow DOM quirk: :root doesn't match inside a shadow tree, but
  // may be present via a rewrite on the server — belt & braces).
  re.lastIndex = 0;
  return css.replace(re, `$1${cssValue}`) + override;
}

// Curated system-font stacks for the font dropdowns. Each entry is
// { label, value } — value lands in the --font-heading / --font-body
// CSS variable.
const SYSTEM_FONT_OPTIONS = [
  { label: "System (fallback)", value: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif` },
  { label: "Avenir Next", value: `"Avenir Next", "Avenir", "Segoe UI", sans-serif` },
  { label: "Helvetica Neue", value: `"Helvetica Neue", Helvetica, Arial, sans-serif` },
  { label: "Inter", value: `"Inter", "Segoe UI", sans-serif` },
  { label: "SF Pro", value: `-apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif` },
  { label: "Georgia", value: `Georgia, "Times New Roman", serif` },
  { label: "Garamond", value: `"EB Garamond", Garamond, "Times New Roman", serif` },
  { label: "Playfair Display", value: `"Playfair Display", Georgia, serif` },
  { label: "Lora", value: `"Lora", Georgia, serif` },
  { label: "IBM Plex Sans", value: `"IBM Plex Sans", "Segoe UI", sans-serif` },
  { label: "IBM Plex Serif", value: `"IBM Plex Serif", Georgia, serif` },
  { label: "Merriweather", value: `"Merriweather", Georgia, serif` },
  { label: "Roboto", value: `"Roboto", "Segoe UI", sans-serif` },
  { label: "Source Sans Pro", value: `"Source Sans Pro", "Segoe UI", sans-serif` },
  { label: "Source Serif Pro", value: `"Source Serif Pro", Georgia, serif` },
  { label: "Menlo (mono)", value: `"Menlo", "Consolas", monospace` },
];

function InspectorPanels({
  modules,
  activeModuleId,
  activeSelection,
  variants,
  hasClipboard,
  clipboardInfo,
  tokens,
  brandTokens,
  overrides,
  onStyleOverride,
  onResetOverride,
  onGoToModule,
  onStartEdit,
  onDuplicateElement,
  onDeleteElement,
  onReplaceImage,
  onEditAlt,
  onCopyElement,
  onCutElement,
  onPasteElement,
  onClearClipboard,
  onSelectParent,
  onSelectChild,
  onSetStyle,
  onDuplicateModule,
  onDeleteModule,
  onSwapVariant,
  tenantAssets,
  tenantId,
  onPatchBackground,
  onClearBackground,
}) {
  const [reportStyleOpen, setReportStyleOpen] = useState(true);
  const [structureOpen, setStructureOpen] = useState(true);
  const [actionsOpen, setActionsOpen] = useState(true);
  const [styleOpen, setStyleOpen] = useState(true);
  const [pageOpen, setPageOpen] = useState(true);
  const [bgOpen, setBgOpen] = useState(false);
  const [bgImagePickerOpen, setBgImagePickerOpen] = useState(false);

  const activeMod = modules.find((m) => m.id === activeModuleId) || null;
  const sel = activeSelection;

  return (
    <div className="ins-root">
      {/* ── Clipboard indicator (always when something's copied) ─ */}
      {clipboardInfo ? (
        <div className="ins-clipboard">
          <span className="ins-clipboard-icon">{clipboardInfo.icon || "📋"}</span>
          <span className="ins-clipboard-text">
            <span className="ins-clipboard-label">{clipboardInfo.label || clipboardInfo.tagName}</span>
            {clipboardInfo.textSample ? (
              <span className="ins-clipboard-sample">{clipboardInfo.textSample}</span>
            ) : null}
          </span>
          <button
            type="button"
            className="ins-clipboard-clear"
            onClick={onClearClipboard}
            title="Rensa urklipp"
          >
            ×
          </button>
        </div>
      ) : null}

      {/* ── Rapport-stil: colors + fonts for the whole report ──── */}
      <InsSection
        title="Rapport-stil"
        open={reportStyleOpen}
        onToggle={() => setReportStyleOpen(!reportStyleOpen)}
        subtitle={Object.keys(overrides || {}).length ? `${Object.keys(overrides).length} ändringar` : "Brand-standard"}
      >
        <div className="ins-style-grid">
          <label className="ins-style-label">Primär</label>
          <ColorField
            value={tokens?.primary_color || ""}
            brandDefault={brandTokens?.primary_color || ""}
            isOverride={!!overrides?.primary_color}
            onChange={(v) => onStyleOverride("primary_color", v)}
            onReset={() => onResetOverride("primary_color")}
          />

          <label className="ins-style-label">Accent</label>
          <ColorField
            value={tokens?.accent_color || ""}
            brandDefault={brandTokens?.accent_color || ""}
            isOverride={!!overrides?.accent_color}
            onChange={(v) => onStyleOverride("accent_color", v)}
            onReset={() => onResetOverride("accent_color")}
          />

          <label className="ins-style-label">Textfärg</label>
          <ColorField
            value={tokens?.text_color || ""}
            brandDefault={brandTokens?.text_color || ""}
            isOverride={!!overrides?.text_color}
            onChange={(v) => onStyleOverride("text_color", v)}
            onReset={() => onResetOverride("text_color")}
          />

          <label className="ins-style-label">Bakgrund</label>
          <ColorField
            value={tokens?.bg_color || ""}
            brandDefault={brandTokens?.bg_color || ""}
            isOverride={!!overrides?.bg_color}
            onChange={(v) => onStyleOverride("bg_color", v)}
            onReset={() => onResetOverride("bg_color")}
          />

          <label className="ins-style-label">Länkfärg</label>
          <ColorField
            value={tokens?.link_color || ""}
            brandDefault={brandTokens?.link_color || tokens?.primary_color || ""}
            isOverride={!!overrides?.link_color}
            onChange={(v) => onStyleOverride("link_color", v)}
            onReset={() => onResetOverride("link_color")}
          />

          <label className="ins-style-label">Display</label>
          <FontField
            value={tokens?.font_display || ""}
            isOverride={!!overrides?.font_display}
            onChange={(v) => onStyleOverride("font_display", v)}
            onReset={() => onResetOverride("font_display")}
          />

          <label className="ins-style-label">Rubriker</label>
          <FontField
            value={tokens?.font_heading || ""}
            isOverride={!!overrides?.font_heading}
            onChange={(v) => onStyleOverride("font_heading", v)}
            onReset={() => onResetOverride("font_heading")}
          />

          <label className="ins-style-label">Brödtext</label>
          <FontField
            value={tokens?.font_body || ""}
            isOverride={!!overrides?.font_body}
            onChange={(v) => onStyleOverride("font_body", v)}
            onReset={() => onResetOverride("font_body")}
          />

          <label className="ins-style-label">Basstorlek</label>
          <BaseFontSizeField
            value={tokens?.base_font_size || ""}
            isOverride={!!overrides?.base_font_size}
            onChange={(v) => onStyleOverride("base_font_size", v)}
            onReset={() => onResetOverride("base_font_size")}
          />
        </div>
        {Object.keys(overrides || {}).length > 0 && (
          <button
            type="button"
            className="ins-btn ins-btn--danger"
            style={{ marginTop: 12, width: "100%" }}
            onClick={() => {
              for (const k of Object.keys(overrides)) onResetOverride(k);
            }}
          >
            Återställ alla
          </button>
        )}
      </InsSection>

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
            <button className="ins-btn" type="button" onClick={onCutElement}>
              <span className="ins-btn-icon">✂</span>
              <span>Klipp ut</span>
              <span className="ins-btn-kbd">⌘X</span>
            </button>
            <button
              className="ins-btn"
              type="button"
              disabled={!hasClipboard}
              onClick={onPasteElement}
              title={hasClipboard ? "Klistra in här" : "Inget i urklipp"}
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

            <label className="ins-style-label">Marginaler</label>
            <input
              type="text"
              className="ins-number-value"
              style={{ width: "100%" }}
              placeholder="t.ex. 16px 0 24px"
              value={sel.style?.margin || ""}
              onChange={(e) => onSetStyle("margin", e.target.value)}
            />

            <label className="ins-style-label">Padding</label>
            <input
              type="text"
              className="ins-number-value"
              style={{ width: "100%" }}
              placeholder="t.ex. 12px 16px"
              value={sel.style?.padding || ""}
              onChange={(e) => onSetStyle("padding", e.target.value)}
            />

            <label className="ins-style-label">Bredd</label>
            <input
              type="text"
              className="ins-number-value"
              style={{ width: "100%" }}
              placeholder="auto / 50% / 240px"
              value={sel.style?.width || ""}
              onChange={(e) => onSetStyle("width", e.target.value)}
            />

            <label className="ins-style-label">Höjd</label>
            <input
              type="text"
              className="ins-number-value"
              style={{ width: "100%" }}
              placeholder="auto / 120px"
              value={sel.style?.height || ""}
              onChange={(e) => onSetStyle("height", e.target.value)}
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

      {/* ── Sidbakgrund — full-bleed photo + overlay + vignette + filter ── */}
      {activeMod ? (
        <InsSection
          title="Sidbakgrund"
          open={bgOpen}
          onToggle={() => setBgOpen(!bgOpen)}
          subtitle={
            activeMod.background?.asset_id || activeMod.background?.image_url
              ? "Bild vald"
              : "Ingen"
          }
        >
          <BackgroundControls
            background={activeMod.background || {}}
            tenantAssets={tenantAssets}
            tenantId={tenantId}
            onPatch={(partial) => onPatchBackground(activeMod.id, partial)}
            onClear={() => onClearBackground(activeMod.id)}
            pickerOpen={bgImagePickerOpen}
            setPickerOpen={setBgImagePickerOpen}
          />
        </InsSection>
      ) : null}
    </div>
  );
}

// ─── BackgroundControls (module background panel) ──────────────────────
function BackgroundControls({ background, tenantAssets, tenantId, onPatch, onClear, pickerOpen, setPickerOpen }) {
  const hasImage = !!(background?.asset_id || background?.image_url);
  const filter = background?.filter || {};
  const overlay = background?.overlay || {};

  return (
    <>
      {/* Image picker */}
      <div className="ins-btn-row">
        <button
          className="ins-btn ins-btn--primary"
          type="button"
          onClick={() => setPickerOpen(true)}
        >
          <span className="ins-btn-icon">🖼</span>
          <span>{hasImage ? "Byt bild" : "Välj bild"}</span>
        </button>
        {hasImage && (
          <button className="ins-btn ins-btn--danger" type="button" onClick={onClear}>
            <span className="ins-btn-icon">×</span>
            <span>Rensa</span>
          </button>
        )}
      </div>

      {pickerOpen && (
        <ImagePickerDialog
          open={pickerOpen}
          tenantId={tenantId}
          initialTab={tenantAssets?.length ? "library" : "upload"}
          onClose={() => setPickerOpen(false)}
          onPick={({ assetId, url }) => {
            // Save BOTH asset_id (canonical reference for re-render)
            // and image_url (direct src so the editor preview doesn't
            // have to look up a freshly-uploaded asset in the cached
            // assets list). HtmlPreview tries asset_id first, falls
            // back to image_url.
            onPatch({
              asset_id: assetId || null,
              image_url: url || null,
              size: background?.size || "cover",
              position: background?.position || "center",
            });
            setPickerOpen(false);
          }}
        />
      )}

      {/* Overlay gradient */}
      <div className="ins-style-grid" style={{ marginTop: 12 }}>
        <label className="ins-style-label">Overlay</label>
        <select
          className="ins-select"
          value={overlay.type || "none"}
          onChange={(e) => {
            const type = e.target.value;
            if (type === "none") onPatch({ overlay: null });
            else onPatch({ overlay: { ...overlay, type } });
          }}
        >
          <option value="none">Ingen</option>
          <option value="linear">Linjär gradient</option>
          <option value="radial">Radial gradient</option>
        </select>

        {overlay.type && overlay.type !== "none" && (
          <>
            <label className="ins-style-label">Från</label>
            <ColorField
              value={overlay.from || "rgba(0,0,0,0.5)"}
              brandDefault=""
              isOverride={false}
              onChange={(v) => onPatch({ overlay: { ...overlay, from: v } })}
              onReset={() => onPatch({ overlay: { ...overlay, from: "rgba(0,0,0,0.5)" } })}
            />
            <label className="ins-style-label">Till</label>
            <ColorField
              value={overlay.to || "rgba(0,0,0,0)"}
              brandDefault=""
              isOverride={false}
              onChange={(v) => onPatch({ overlay: { ...overlay, to: v } })}
              onReset={() => onPatch({ overlay: { ...overlay, to: "rgba(0,0,0,0)" } })}
            />
            {overlay.type === "linear" && (
              <>
                <label className="ins-style-label">Vinkel</label>
                <SliderField
                  value={overlay.angle ?? 180}
                  min={0} max={360} step={5} suffix="°"
                  onChange={(v) => onPatch({ overlay: { ...overlay, angle: v } })}
                />
              </>
            )}
          </>
        )}

        <label className="ins-style-label">Vinjett</label>
        <SliderField
          value={background?.vignette ?? 0}
          min={0} max={1} step={0.05} suffix=""
          onChange={(v) => onPatch({ vignette: v || null })}
        />
      </div>

      {/* Filter stack */}
      <div className="ins-children-label" style={{ marginTop: 14 }}>Filter</div>
      <div className="ins-style-grid">
        <label className="ins-style-label">Svart/vitt</label>
        <SliderField
          value={filter.grayscale ?? 0}
          min={0} max={1} step={0.05}
          onChange={(v) => onPatch({ filter: { ...filter, grayscale: v || null } })}
        />
        <label className="ins-style-label">Sepia</label>
        <SliderField
          value={filter.sepia ?? 0}
          min={0} max={1} step={0.05}
          onChange={(v) => onPatch({ filter: { ...filter, sepia: v || null } })}
        />
        <label className="ins-style-label">Mättnad</label>
        <SliderField
          value={filter.saturate ?? 1}
          min={0} max={3} step={0.1}
          onChange={(v) => onPatch({ filter: { ...filter, saturate: v === 1 ? null : v } })}
        />
        <label className="ins-style-label">Kontrast</label>
        <SliderField
          value={filter.contrast ?? 1}
          min={0.5} max={2} step={0.05}
          onChange={(v) => onPatch({ filter: { ...filter, contrast: v === 1 ? null : v } })}
        />
        <label className="ins-style-label">Ljusstyrka</label>
        <SliderField
          value={filter.brightness ?? 1}
          min={0.3} max={1.7} step={0.05}
          onChange={(v) => onPatch({ filter: { ...filter, brightness: v === 1 ? null : v } })}
        />
        <label className="ins-style-label">Blur</label>
        <SliderField
          value={filter.blur_px ?? 0}
          min={0} max={20} step={0.5} suffix="px"
          onChange={(v) => onPatch({ filter: { ...filter, blur_px: v || null } })}
        />
      </div>

      {/* Filter presets */}
      <div className="ins-btn-row" style={{ marginTop: 10 }}>
        <button
          className="ins-btn" type="button"
          onClick={() => onPatch({ filter: { grayscale: 1 } })}
        >B/W</button>
        <button
          className="ins-btn" type="button"
          onClick={() => onPatch({ filter: { sepia: 0.8, saturate: 0.7 } })}
        >Sepia</button>
        <button
          className="ins-btn" type="button"
          onClick={() => onPatch({ filter: { saturate: 1.35, contrast: 1.1 } })}
        >Vibrant</button>
        <button
          className="ins-btn" type="button"
          onClick={() => onPatch({ filter: null })}
        >Rensa</button>
      </div>
    </>
  );
}

function SliderField({ value, min, max, step, suffix = "", onChange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor: "var(--rose-600)" }}
      />
      <span style={{
        minWidth: 48, textAlign: "right",
        fontSize: 11, fontFamily: "ui-monospace, Menlo, monospace",
        color: "var(--ink)",
      }}>
        {typeof value === "number" ? (value % 1 === 0 ? value : value.toFixed(2)) : value}{suffix}
      </span>
    </div>
  );
}

// ─── Style field helpers ────────────────────────────────────────
function ColorField({ value, brandDefault, isOverride, onChange, onReset }) {
  // Normalise to a hex color for the <input type=color> display.
  // If value is a CSS name or rgb(), fall back to the browser default.
  const hex = toHex(value);
  return (
    <div className={`ins-color-row${isOverride ? " is-override" : ""}`}>
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
        placeholder={brandDefault || "—"}
      />
      {isOverride ? (
        <button type="button" className="ins-color-reset" onClick={onReset} title="Återställ till brand">
          ↺
        </button>
      ) : null}
    </div>
  );
}

function BaseFontSizeField({ value, isOverride, onChange, onReset }) {
  // Accept "11pt", "14px", or bare "11". When reading, strip unit for
  // the numeric stepper so ±1 works. On save, preserve the original
  // unit if present; default to pt.
  const raw = String(value || "");
  const match = raw.match(/^(\d+(?:\.\d+)?)(px|pt|em|rem)?$/);
  const num = match ? parseFloat(match[1]) : 11;
  const unit = (match && match[2]) || "pt";
  const step = (delta) => onChange(`${Math.max(6, Math.min(36, num + delta))}${unit}`);
  return (
    <div className={`ins-color-row${isOverride ? " is-override" : ""}`}>
      <button type="button" className="ins-number-btn" onClick={() => step(-1)} title="−">−</button>
      <input
        type="text"
        className="ins-number-value"
        style={{ flex: 1, minWidth: 0, textAlign: "center" }}
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder="11pt"
      />
      <button type="button" className="ins-number-btn" onClick={() => step(1)} title="+">+</button>
      {isOverride ? (
        <button type="button" className="ins-color-reset" onClick={onReset} title="Återställ">↺</button>
      ) : null}
    </div>
  );
}

function FontField({ value, isOverride, onChange, onReset }) {
  // Match the current value against known labels; fall through to
  // "Egen" if the CSS stack doesn't match any preset (edge case for
  // legacy brand tokens).
  const match = SYSTEM_FONT_OPTIONS.find((f) => f.value === value);
  return (
    <div className={`ins-color-row${isOverride ? " is-override" : ""}`}>
      <select
        className="ins-select"
        style={{ flex: 1, minWidth: 0 }}
        value={match?.value || ""}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="" disabled>— välj typsnitt —</option>
        {SYSTEM_FONT_OPTIONS.map((f) => (
          <option key={f.label} value={f.value}>
            {f.label}
          </option>
        ))}
        {value && !match ? (
          <option value={value}>Egen (ej i listan)</option>
        ) : null}
      </select>
      {isOverride ? (
        <button type="button" className="ins-color-reset" onClick={onReset} title="Återställ till brand">
          ↺
        </button>
      ) : null}
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

// Robust CSS color → hex conversion. Previous version only handled
// hex + rgb() literals — missed named colors, hsl(), and var()
// references. Using a throwaway <canvas> 2D context forces the browser
// to normalise any valid CSS color into a computed rgba string, which
// we then turn into #RRGGBB. Falls back to "" (picker shows black).
function toHex(color) {
  if (!color || typeof color !== "string") return "";
  const trimmed = color.trim();
  if (!trimmed) return "";
  // Fast path: already a 6/8-digit hex
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(trimmed)) return trimmed.slice(0, 7);
  // Fast path: 3-digit hex
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const [, r, g, b] = trimmed.match(/^#(.)(.)(.)$/);
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  // var() / currentColor / etc. — can't resolve without computed-style;
  // return empty so the picker shows default without throwing.
  if (/^(var|currentColor|inherit|unset|initial|none|transparent)/i.test(trimmed)) return "";
  // Use canvas to let the browser normalise named colors, hsl(), etc.
  try {
    if (typeof document === "undefined") return "";
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillStyle = trimmed;
    const v = ctx.fillStyle; // "#rrggbb" or "rgba(r, g, b, a)"
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
    const m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return "";
    const hex2 = (n) => Number(n).toString(16).padStart(2, "0");
    return `#${hex2(m[1])}${hex2(m[2])}${hex2(m[3])}`;
  } catch {
    return "";
  }
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
