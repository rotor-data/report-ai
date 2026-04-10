import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";

/**
 * V2 dashboard — lists tenant reports and lets user create a new one.
 * Tenant ID is currently entered manually (chat-first flow normally creates
 * reports via MCP). Persisted in localStorage for convenience.
 */
export default function V2Dashboard() {
  const [tenantId, setTenantId] = useState(() => localStorage.getItem("v2_tenant_id") || "");
  const [brandId, setBrandId] = useState(() => localStorage.getItem("v2_brand_id") || "");
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Create form
  const [newTitle, setNewTitle] = useState("");
  const [newDocType, setNewDocType] = useState("annual_report");
  const [creating, setCreating] = useState(false);

  const load = async () => {
    if (!tenantId) return;
    setLoading(true);
    setError("");
    try {
      const res = await api.listV2Reports(tenantId);
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
  }, [tenantId]);

  const saveContext = () => {
    localStorage.setItem("v2_tenant_id", tenantId);
    localStorage.setItem("v2_brand_id", brandId);
    load();
  };

  const createReport = async (e) => {
    e.preventDefault();
    if (!tenantId || !brandId || !newTitle) return;
    setCreating(true);
    setError("");
    try {
      const res = await api.createV2Report({
        tenant_id: tenantId,
        brand_id: brandId,
        title: newTitle,
        document_type: newDocType,
      });
      setNewTitle("");
      setItems((prev) => [res.item, ...prev]);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="stack-lg">
      <div className="row-between">
        <h2>Rapporter v2</h2>
        <Link className="btn-ghost" to="/v2/assets">
          Asset-bibliotek
        </Link>
      </div>

      <div className="panel stack">
        <strong>Kontext</strong>
        <label>
          Tenant ID
          <input value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="UUID" />
        </label>
        <label>
          Brand ID
          <input value={brandId} onChange={(e) => setBrandId(e.target.value)} placeholder="UUID" />
        </label>
        <button className="btn" type="button" onClick={saveContext}>
          Spara kontext
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="panel stack">
        <strong>Ny rapport</strong>
        <form className="stack" onSubmit={createReport}>
          <label>
            Titel
            <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} required />
          </label>
          <label>
            Dokumenttyp
            <select value={newDocType} onChange={(e) => setNewDocType(e.target.value)}>
              <option value="annual_report">Årsredovisning</option>
              <option value="quarterly">Kvartalsrapport</option>
              <option value="pitch">Pitch</option>
              <option value="proposal">Offert</option>
            </select>
          </label>
          <button className="btn" type="submit" disabled={creating || !tenantId || !brandId}>
            {creating ? "Skapar…" : "Skapa rapport"}
          </button>
        </form>
      </div>

      {loading ? <p>Laddar…</p> : null}

      <div className="card-list">
        {items.map((doc) => (
          <Link key={doc.id} className="card" to={`/v2/reports/${doc.id}`}>
            <strong>{doc.title}</strong>
            <span>{doc.document_type}</span>
            <span>{doc.status}</span>
            <span className="hint">{new Date(doc.updated_at).toLocaleDateString("sv-SE")}</span>
          </Link>
        ))}
        {!loading && tenantId && items.length === 0 ? (
          <p className="hint">Inga rapporter än.</p>
        ) : null}
      </div>
    </section>
  );
}
