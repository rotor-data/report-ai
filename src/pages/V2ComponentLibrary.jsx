import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";

/**
 * V2 Component Library — browse, inspect and manage saved brand_components.
 *
 * Users can:
 *   - Filter by component_type, status and page_format
 *   - Preview rendered HTML in a sandboxed iframe
 *   - Mark entries as draft / ready / deprecated
 *   - Rename variant_name / label inline
 *   - Delete broken or no-longer-wanted components
 */
export default function V2ComponentLibrary() {
  const [brandId, setBrandId] = useState(
    () => localStorage.getItem("v2_brand_id") || ""
  );
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [formatFilter, setFormatFilter] = useState("");
  const [selectedId, setSelectedId] = useState(null);

  const load = async () => {
    if (!brandId) return;
    setLoading(true);
    setError("");
    try {
      const res = await api.listV2Components(brandId);
      setItems(res.items || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);

  const onDelete = async (id, label) => {
    if (!confirm(`Ta bort komponenten "${label || id}"? Detta går inte att ångra.`)) return;
    try {
      await api.deleteV2Component(id);
      setItems((prev) => prev.filter((x) => x.id !== id));
      if (selectedId === id) setSelectedId(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const onStatusChange = async (id, status) => {
    try {
      const res = await api.patchV2Component(id, { status });
      setItems((prev) => prev.map((x) => (x.id === id ? { ...x, ...res.item } : x)));
    } catch (err) {
      setError(err.message);
    }
  };

  const filtered = useMemo(() => {
    return items.filter((x) => {
      if (typeFilter && x.component_type !== typeFilter) return false;
      if (statusFilter && (x.status || "ready") !== statusFilter) return false;
      if (formatFilter && (x.page_format || "a4_portrait") !== formatFilter) return false;
      return true;
    });
  }, [items, typeFilter, statusFilter, formatFilter]);

  const types = useMemo(() => {
    const s = new Set(items.map((x) => x.component_type).filter(Boolean));
    return Array.from(s).sort();
  }, [items]);

  const selected = useMemo(
    () => items.find((x) => x.id === selectedId) || null,
    [items, selectedId]
  );

  const saveBrand = () => {
    localStorage.setItem("v2_brand_id", brandId);
    load();
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "380px 1fr", gap: "0", height: "calc(100vh - 56px)" }}>
      {/* Sidebar */}
      <aside style={{ borderRight: "1px solid #e5e7eb", padding: "16px", overflow: "auto" }}>
        <h2 style={{ margin: 0, marginBottom: 12, fontSize: 18 }}>Komponentbibliotek</h2>

        <label style={{ display: "block", fontSize: 12, color: "#6b7280" }}>Brand ID</label>
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          <input
            value={brandId}
            onChange={(e) => setBrandId(e.target.value)}
            placeholder="brand UUID"
            style={{ flex: 1, padding: "6px 8px", border: "1px solid #d1d5db", borderRadius: 4 }}
          />
          <button onClick={saveBrand} style={btn}>Ladda</button>
        </div>

        {error && (
          <div style={{ padding: 8, background: "#fef2f2", color: "#b91c1c", borderRadius: 4, marginBottom: 10, fontSize: 13 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={sel}>
            <option value="">Alla typer</option>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={sel}>
            <option value="">Alla status</option>
            <option value="ready">Ready</option>
            <option value="draft">Draft</option>
            <option value="deprecated">Deprecated</option>
          </select>
          <select value={formatFilter} onChange={(e) => setFormatFilter(e.target.value)} style={sel}>
            <option value="">Alla format</option>
            <option value="a4_portrait">A4 portrait</option>
            <option value="a4_landscape">A4 landscape</option>
            <option value="us_letter">Letter</option>
            <option value="presentation">Presentation 16:9</option>
            <option value="square">Square</option>
            <option value="digital">Digital</option>
          </select>
        </div>

        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
          {loading ? "Laddar…" : `${filtered.length} av ${items.length}`}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {filtered.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              style={{
                textAlign: "left",
                padding: "8px 10px",
                border: "1px solid " + (selectedId === c.id ? "#3b82f6" : "#e5e7eb"),
                borderRadius: 4,
                background: selectedId === c.id ? "#eff6ff" : "white",
                cursor: "pointer",
              }}
            >
              <div style={{ fontWeight: 500, fontSize: 13 }}>
                {c.label || c.component_type}
              </div>
              <div style={{ fontSize: 11, color: "#6b7280", display: "flex", gap: 8, marginTop: 2 }}>
                <span>{c.component_type}</span>
                {c.variant_name && <span>• {c.variant_name}</span>}
                {c.page_format && <span>• {c.page_format}</span>}
                <StatusChip status={c.status || "ready"} />
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* Detail */}
      <main style={{ overflow: "auto" }}>
        {selected ? (
          <ComponentDetail
            key={selected.id}
            item={selected}
            onDelete={() => onDelete(selected.id, selected.label)}
            onStatusChange={(s) => onStatusChange(selected.id, s)}
          />
        ) : (
          <div style={{ padding: 40, color: "#6b7280" }}>
            Välj en komponent från listan för att förhandsvisa och hantera.
          </div>
        )}
      </main>
    </div>
  );
}

function ComponentDetail({ item, onDelete, onStatusChange }) {
  const previewSrc = useMemo(() => {
    // Render html_template with placeholders hinted as "Exempel"
    const html = (item.html_template || "")
      .replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_, k) => `[${k}]`);
    const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:system-ui,sans-serif;margin:0;padding:20px;color:#111}
*{box-sizing:border-box}
:root{--primary:#222;--accent:#666;--text:#111;--bg:#fff;--font-heading:sans-serif;--font-body:sans-serif;--column-gap:8mm;--section-gap:6mm}
</style></head><body>${html}</body></html>`;
    return `data:text/html;charset=utf-8,${encodeURIComponent(doc)}`;
  }, [item]);

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20 }}>{item.label || item.component_type}</h2>
          <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
            {item.component_type}
            {item.variant_name && ` • ${item.variant_name}`}
            {item.page_format && ` • ${item.page_format}`}
            {" • v"}{item.version}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            value={item.status || "ready"}
            onChange={(e) => onStatusChange(e.target.value)}
            style={{ padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 4 }}
          >
            <option value="ready">Ready</option>
            <option value="draft">Draft</option>
            <option value="deprecated">Deprecated</option>
          </select>
          <button
            onClick={onDelete}
            style={{
              padding: "6px 12px",
              border: "1px solid #fca5a5",
              color: "#b91c1c",
              background: "#fef2f2",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Ta bort
          </button>
        </div>
      </div>

      {item.design_notes && (
        <div style={{ background: "#fef3c7", border: "1px solid #fde68a", padding: 10, borderRadius: 4, marginBottom: 12, fontSize: 13 }}>
          <strong>Design notes:</strong> {item.design_notes}
        </div>
      )}

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 4, overflow: "hidden" }}>
        <iframe
          title={`preview-${item.id}`}
          src={previewSrc}
          style={{ width: "100%", height: 420, border: 0, background: "white" }}
        />
      </div>

      <details style={{ marginTop: 16 }}>
        <summary style={{ cursor: "pointer", fontSize: 13, color: "#6b7280" }}>HTML-mall</summary>
        <pre style={{
          background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 4,
          padding: 12, fontSize: 12, marginTop: 8, maxHeight: 320, overflow: "auto",
        }}>
          {item.html_template}
        </pre>
      </details>
    </div>
  );
}

function StatusChip({ status }) {
  const color = status === "ready" ? "#16a34a" : status === "draft" ? "#ca8a04" : "#6b7280";
  return (
    <span style={{ color, fontWeight: 500 }}>• {status}</span>
  );
}

const btn = {
  padding: "6px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 4,
  background: "white",
  cursor: "pointer",
};

const sel = {
  padding: "4px 6px",
  border: "1px solid #d1d5db",
  borderRadius: 4,
  fontSize: 13,
};
