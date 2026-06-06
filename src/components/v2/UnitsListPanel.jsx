/**
 * UnitsListPanel — alpha-v3 content-units side panel.
 *
 * Extracted from the inline UnitsPanel in pages/EditorV2.jsx as part of
 * Fas 3 of the panel rebuild (resilient-dazzling-koala).
 *
 * Responsibilities
 * ─────────────────
 *   - Group units by host page (derived from a unit_id → page_num map
 *     supplied by the parent, so this component doesn't need to know
 *     anything about modules / HTML / shadow DOM).
 *   - Collapsible page sections with per-page unit count.
 *   - Visual type indicator per row (delegated to <UnitTypeIcon>).
 *   - Filter bar: free-text search, multi-type pills, optional
 *     "heavy-edited" toggle (placeholder for Fas 5 — disabled until
 *     feedback data is wired in).
 *   - Hover-highlight bridge: emit `onHoverUnit(id|null)` so the parent
 *     can pass `highlightedUnitId` down to HtmlPreview.
 *   - HTML5 drag-to-reorder WITHIN the same page. Cross-page reorder
 *     is out of scope for v1.
 *   - Bulk-edit menu: select-all / find-replace / type-change. The
 *     menu lives in <BulkEditMenu> below.
 *
 * The component is purely controlled — all state changes flow up via
 * callbacks. Selection / edit-mode / persistence live in the parent
 * (EditorV2), so this is a thin, restartable view.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import UnitTypeIcon, { getUnitTypeMeta } from "./UnitTypeIcon.jsx";

const DEFAULT_PAGE_LABEL = "Övriga";

function unitTextPreview(unit) {
  if (unit.text && unit.text.trim()) return unit.text.trim();
  const m = unit.metadata || {};
  if (Array.isArray(m.items) && m.items.length) {
    return m.items.slice(0, 3).map(String).join(" · ");
  }
  if (m.kpi && (m.kpi.value || m.kpi.label)) {
    return [m.kpi.value, m.kpi.label].filter(Boolean).join(" — ");
  }
  if (m.headers && Array.isArray(m.headers)) {
    return `Tabell: ${m.headers.join(" · ")}`;
  }
  return "—";
}

function fuzzyMatch(needle, haystack) {
  if (!needle) return true;
  const n = needle.toLowerCase();
  return haystack.toLowerCase().includes(n);
}

export default function UnitsListPanel({
  units,
  pageMap,                // Map<unitDbId, number> | object { [unitDbId]: pageNum }
  selectedUnitId,
  onSelect,               // (unit) => void
  onEdit,                 // (unit) => void   ← open popover
  onPatchUnit,            // (id, patch) => void
  onHoverUnit,            // (unitDbId|null) => void
  onReorder,              // (movedId, newOrderIndex, neighborUpdates) => void
}) {
  // pageMap may arrive as plain object or Map — normalise.
  const lookupPage = useCallback((id) => {
    if (!pageMap) return null;
    if (pageMap instanceof Map) return pageMap.get(id) ?? null;
    return pageMap[id] ?? null;
  }, [pageMap]);

  // ─── Filter / search state ──────────────────────────────────────
  const [search, setSearch] = useState("");
  const [activeTypeFilters, setActiveTypeFilters] = useState(() => new Set());
  const [heavyEditedOnly, setHeavyEditedOnly] = useState(false);
  const [collapsedPages, setCollapsedPages] = useState(() => new Set());
  // Bulk-edit selection — set of unit DB ids.
  const [bulkSelection, setBulkSelection] = useState(() => new Set());
  const [bulkMode, setBulkMode] = useState(false);

  // All types currently present in the list — drives the type-filter pills.
  const typesPresent = useMemo(() => {
    const s = new Set();
    for (const u of units) s.add(u.type);
    return Array.from(s);
  }, [units]);

  // Apply filters.
  const filteredUnits = useMemo(() => {
    return units.filter((u) => {
      if (activeTypeFilters.size > 0 && !activeTypeFilters.has(u.type)) return false;
      if (heavyEditedOnly) {
        // Placeholder — once feedback data lands, this checks edit_distance
        // sum or revision count. For now: hide everything to keep the
        // filter visibly distinct from a no-op.
        if (!u._heavyEdited) return false;
      }
      if (search) {
        const haystack = [
          u.unit_id || "",
          u.text || "",
          unitTextPreview(u),
        ].join(" ");
        if (!fuzzyMatch(search, haystack)) return false;
      }
      return true;
    });
  }, [units, search, activeTypeFilters, heavyEditedOnly]);

  // Group by host page.
  const groups = useMemo(() => {
    const byPage = new Map();
    for (const u of filteredUnits) {
      const p = lookupPage(u.id);
      const key = p == null ? "__none__" : `p${p}`;
      if (!byPage.has(key)) byPage.set(key, { pageNum: p, items: [] });
      byPage.get(key).items.push(u);
    }
    // Sort entries: numbered pages ascending, "övriga" last.
    return Array.from(byPage.values()).sort((a, b) => {
      if (a.pageNum == null) return 1;
      if (b.pageNum == null) return -1;
      return a.pageNum - b.pageNum;
    });
  }, [filteredUnits, lookupPage]);

  const togglePageCollapse = (pageNum) => {
    setCollapsedPages((prev) => {
      const next = new Set(prev);
      const key = pageNum == null ? "__none__" : `p${pageNum}`;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleTypeFilter = (type) => {
    setActiveTypeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const clearFilters = () => {
    setSearch("");
    setActiveTypeFilters(new Set());
    setHeavyEditedOnly(false);
  };

  // ─── Bulk-edit selection ────────────────────────────────────────
  const toggleBulk = (id) => {
    setBulkSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAllVisible = () => {
    setBulkSelection(new Set(filteredUnits.map((u) => u.id)));
  };
  const selectNone = () => setBulkSelection(new Set());

  // ─── Drag-to-reorder (within same page only) ────────────────────
  // We use HTML5 native drag/drop — drag a row, drop on another row in
  // the same page section. The parent (EditorV2) owns the actual
  // mutation: we hand it the moved unit's id and the target position so
  // it can recompute order_index across the affected window.
  const [dragId, setDragId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);   // { id, position: 'before'|'after' }

  const onRowDragStart = (e, unit) => {
    setDragId(unit.id);
    try {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", unit.id);
    } catch { /* noop */ }
  };

  const onRowDragOver = (e, unit, sameGroup) => {
    if (!dragId || dragId === unit.id || !sameGroup) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDropTarget({ id: unit.id, position: e.clientY < midY ? "before" : "after" });
  };

  const onRowDragLeave = () => {
    // Don't clear on every leave — too jittery. The dragover from the
    // next row will overwrite it anyway. Only clear on dragend.
  };

  const onRowDrop = useCallback((e, target, group) => {
    if (!dragId || !onReorder) { setDropTarget(null); setDragId(null); return; }
    e.preventDefault();
    const moved = units.find((u) => u.id === dragId);
    if (!moved) { setDropTarget(null); setDragId(null); return; }
    // Only allow same-page reorder.
    const movedPage = lookupPage(moved.id);
    const targetPage = lookupPage(target.id);
    if (movedPage !== targetPage) { setDropTarget(null); setDragId(null); return; }

    // Compute the new ordering across the entire `group.items` so the
    // parent can issue PATCHes with stable order_index values.
    const ids = group.items.map((u) => u.id).filter((id) => id !== dragId);
    const targetIdx = ids.indexOf(target.id);
    const insertAt = dropTarget?.position === "after" ? targetIdx + 1 : targetIdx;
    ids.splice(insertAt, 0, dragId);
    // Resolve back to units to read original order_index of the first item;
    // we use it as the base and step by 1 for each subsequent. Caller can
    // collapse this into a bulk PATCH if it wants.
    const baseOrder = Math.min(...group.items.map((u) => u.order_index ?? 0));
    const updates = ids.map((id, idx) => ({ id, order_index: baseOrder + idx }));
    onReorder(dragId, baseOrder + insertAt, updates);
    setDropTarget(null);
    setDragId(null);
  }, [dragId, dropTarget, lookupPage, onReorder, units]);

  // Clear drag state on global dragend so an aborted drag (Escape, drop
  // outside) doesn't leave us in a stuck state.
  useEffect(() => {
    if (!dragId) return undefined;
    const cancel = () => { setDragId(null); setDropTarget(null); };
    window.addEventListener("dragend", cancel);
    return () => window.removeEventListener("dragend", cancel);
  }, [dragId]);

  return (
    <div className="units-panel-root">
      <div className="units-panel-head">
        <span className="units-panel-title">Innehåll</span>
        <span className="units-panel-count">{filteredUnits.length}/{units.length}</span>
      </div>

      {/* Filter bar */}
      <div className="units-filter-bar">
        <input
          className="units-filter-search"
          type="search"
          placeholder="Sök innehåll eller id…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Sök units"
        />
        <details className="units-filter-types">
          <summary>
            Typer
            {activeTypeFilters.size > 0 ? <span className="units-filter-count">{activeTypeFilters.size}</span> : null}
          </summary>
          <div className="units-filter-types-list">
            {typesPresent.sort().map((t) => {
              const meta = getUnitTypeMeta(t);
              const active = activeTypeFilters.has(t);
              return (
                <button
                  key={t}
                  type="button"
                  className={`units-type-pill${active ? " units-type-pill--active" : ""}`}
                  style={{
                    background: active ? meta.bg : "#f4f4f5",
                    color: active ? meta.fg : "#71717a",
                  }}
                  onClick={() => toggleTypeFilter(t)}
                >
                  {meta.label}
                </button>
              );
            })}
          </div>
        </details>
        <button
          type="button"
          className={`units-heavy-toggle${heavyEditedOnly ? " units-heavy-toggle--on" : ""}`}
          onClick={() => setHeavyEditedOnly((v) => !v)}
          title="Visa endast tungredigerade units (kräver feedback-data — kommer i Fas 5)"
          disabled
        >
          🔥 Tungredigerade
        </button>
        {(search || activeTypeFilters.size > 0 || heavyEditedOnly) ? (
          <button type="button" className="units-clear-filters" onClick={clearFilters}>
            Rensa
          </button>
        ) : null}
      </div>

      {/* Bulk-edit menu */}
      <BulkEditMenu
        bulkMode={bulkMode}
        setBulkMode={setBulkMode}
        bulkSelection={bulkSelection}
        selectAllVisible={selectAllVisible}
        selectNone={selectNone}
        units={units}
        onPatchUnit={onPatchUnit}
      />

      {/* Grouped list */}
      <div className="units-panel-list">
        {groups.length === 0 ? (
          <div className="units-empty-state">Inga units matchar.</div>
        ) : groups.map((g) => {
          const key = g.pageNum == null ? "__none__" : `p${g.pageNum}`;
          const collapsed = collapsedPages.has(key);
          const label = g.pageNum == null ? DEFAULT_PAGE_LABEL : `Sida ${g.pageNum + 1}`;
          return (
            <section key={key} className="units-page-group">
              <button
                type="button"
                className="units-page-group-head"
                onClick={() => togglePageCollapse(g.pageNum)}
                aria-expanded={!collapsed}
              >
                <span className="units-page-group-caret" aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
                <span className="units-page-group-label">{label}</span>
                <span className="units-page-group-count">{g.items.length}</span>
              </button>
              {collapsed ? null : (
                <div className="units-page-group-list">
                  {g.items.map((u) => (
                    <UnitRow
                      key={u.id}
                      unit={u}
                      selected={selectedUnitId === u.id}
                      bulkMode={bulkMode}
                      bulkSelected={bulkSelection.has(u.id)}
                      onBulkToggle={() => toggleBulk(u.id)}
                      onClick={() => onSelect?.(u)}
                      onDoubleClick={() => onEdit?.(u)}
                      onMouseEnter={() => onHoverUnit?.(u.id)}
                      onMouseLeave={() => onHoverUnit?.(null)}
                      isDragging={dragId === u.id}
                      dropPosition={dropTarget?.id === u.id ? dropTarget.position : null}
                      onDragStart={(e) => onRowDragStart(e, u)}
                      onDragOver={(e) => onRowDragOver(e, u, true)}
                      onDragLeave={onRowDragLeave}
                      onDrop={(e) => onRowDrop(e, u, g)}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

// ─── Unit row ──────────────────────────────────────────────────────
function UnitRow({
  unit,
  selected,
  bulkMode,
  bulkSelected,
  onBulkToggle,
  onClick,
  onDoubleClick,
  onMouseEnter,
  onMouseLeave,
  isDragging,
  dropPosition,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
}) {
  const preview = unitTextPreview(unit);
  return (
    <div
      className={
        "units-row"
        + (selected ? " units-row--selected" : "")
        + (isDragging ? " units-row--dragging" : "")
        + (dropPosition === "before" ? " units-row--drop-before" : "")
        + (dropPosition === "after" ? " units-row--drop-after" : "")
      }
      draggable={!bulkMode}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      data-unit-row-id={unit.id}
    >
      {bulkMode ? (
        <input
          type="checkbox"
          className="units-row-bulk"
          checked={bulkSelected}
          onChange={onBulkToggle}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <UnitTypeIcon type={unit.type} level={unit.level} compact />
      )}
      <div className="units-row-body">
        <div className="units-row-meta">
          <code className="units-row-id" title={unit.unit_id}>{unit.unit_id}</code>
        </div>
        <div className="units-row-preview" title={preview}>{preview}</div>
      </div>
    </div>
  );
}

// ─── Bulk-edit menu ────────────────────────────────────────────────
function BulkEditMenu({
  bulkMode,
  setBulkMode,
  bulkSelection,
  selectAllVisible,
  selectNone,
  units,
  onPatchUnit,
}) {
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [newType, setNewType] = useState("");

  if (!bulkMode) {
    return (
      <div className="units-bulk-bar">
        <button
          type="button"
          className="units-bulk-toggle"
          onClick={() => setBulkMode(true)}
        >
          ☑ Bulk-redigera
        </button>
      </div>
    );
  }

  const runFindReplace = () => {
    if (!findText) return;
    let pattern;
    try {
      pattern = useRegex ? new RegExp(findText, "g") : null;
    } catch (err) {
      console.warn("[bulk] invalid regex:", err);
      return;
    }
    const ids = Array.from(bulkSelection);
    for (const id of ids) {
      const u = units.find((x) => x.id === id);
      if (!u || typeof u.text !== "string") continue;
      const nextText = pattern
        ? u.text.replace(pattern, replaceText)
        : u.text.split(findText).join(replaceText);
      if (nextText !== u.text) {
        onPatchUnit?.(id, { text: nextText });
      }
    }
  };

  const runTypeChange = () => {
    if (!newType) return;
    for (const id of bulkSelection) {
      onPatchUnit?.(id, { type: newType });
    }
  };

  return (
    <div className="units-bulk-bar units-bulk-bar--open">
      <div className="units-bulk-row">
        <button type="button" className="units-bulk-action" onClick={selectAllVisible}>
          Markera alla
        </button>
        <button type="button" className="units-bulk-action" onClick={selectNone}>
          Avmarkera
        </button>
        <span className="units-bulk-count">{bulkSelection.size} valda</span>
        <button
          type="button"
          className="units-bulk-close"
          onClick={() => { setBulkMode(false); selectNone(); }}
          title="Stäng bulk-läge"
        >
          ×
        </button>
      </div>

      <details className="units-bulk-section">
        <summary>Sök &amp; ersätt</summary>
        <div className="units-bulk-section-body">
          <input
            type="text"
            className="units-bulk-input"
            placeholder="Sök efter…"
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
          />
          <input
            type="text"
            className="units-bulk-input"
            placeholder="Ersätt med…"
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
          />
          <label className="units-bulk-checkbox">
            <input
              type="checkbox"
              checked={useRegex}
              onChange={(e) => setUseRegex(e.target.checked)}
            />
            Regex
          </label>
          <button
            type="button"
            className="units-bulk-action units-bulk-action--primary"
            onClick={runFindReplace}
            disabled={bulkSelection.size === 0 || !findText}
          >
            Ersätt i {bulkSelection.size}
          </button>
        </div>
      </details>

      <details className="units-bulk-section">
        <summary>Byt typ</summary>
        <div className="units-bulk-section-body">
          <input
            type="text"
            className="units-bulk-input"
            placeholder="Ny unit-typ (t.ex. paragraph)"
            value={newType}
            onChange={(e) => setNewType(e.target.value)}
          />
          <button
            type="button"
            className="units-bulk-action units-bulk-action--primary"
            onClick={runTypeChange}
            disabled={bulkSelection.size === 0 || !newType}
          >
            Byt i {bulkSelection.size}
          </button>
        </div>
      </details>

      <details className="units-bulk-section">
        <summary>Språkkorrigering</summary>
        <div className="units-bulk-section-body">
          <p className="units-bulk-hint">
            Kräver API-nyckel — kommer i senare release.
          </p>
        </div>
      </details>
    </div>
  );
}
