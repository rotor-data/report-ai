import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { useUiStore } from "../stores/uiStore";
import ModuleEditor from "../components/v2/ModuleEditor";
import "./EditorV2.css";

const MODULE_TYPES = ["cover", "chapter_break", "back_cover", "layout"];

/**
 * Scoped editor opened via HMAC capability token (`/editor/v2?token=...`).
 *
 * Flow:
 *  1. Parse `?token=` from URL.
 *  2. GET /api/editor-session?token=... → verify + scope (reportId, tenantId, brandId).
 *  3. Store token + scope in uiStore so api/client attaches X-Editor-Token header.
 *  4. Load report + modules and render a Hub-styled editor surface.
 *
 * The chrome is intentionally self-contained — this route is rendered
 * OUTSIDE the normal `<App />` layout so none of the SPA nav leaks in.
 */
export default function EditorV2() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";

  const setEditorAuth = useUiStore((s) => s.setEditorAuth);
  const clearEditorAuth = useUiStore((s) => s.clearEditorAuth);

  const [session, setSession] = useState(null);
  const [report, setReport] = useState(null);
  const [modules, setModules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [busy, setBusy] = useState({});
  const [newType, setNewType] = useState("layout");
  const [adding, setAdding] = useState(false);
  const [renderBusy, setRenderBusy] = useState(false);
  const [pdfUrl, setPdfUrl] = useState("");

  // Verify token + load report
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

        const r = await api.getV2Report(data.report_id);
        if (cancelled) return;
        setReport(r.item);
        setModules(r.modules || []);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      clearEditorAuth();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const onModuleChange = (updated) => {
    setModules((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
  };

  const onSaveModule = async (mod) => {
    setBusy((b) => ({ ...b, [mod.id]: true }));
    setError("");
    try {
      const res = await api.updateV2Module(mod.id, { content: mod.content, style: mod.style });
      setModules((prev) => prev.map((m) => (m.id === mod.id ? res.item : m)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy((b) => ({ ...b, [mod.id]: false }));
    }
  };

  const onDeleteModule = async (mod) => {
    if (!confirm(`Ta bort modul "${mod.module_type}"?`)) return;
    try {
      await api.deleteV2Module(mod.id);
      setModules((prev) => prev.filter((m) => m.id !== mod.id));
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
    <div className="smyra-editor">
      <header className="editor-topbar">
        <div className="editor-brand">
          <div className="editor-brand-mark">✦</div>
          <div className="editor-brand-text">
            <span className="editor-brand-title">Smyra Editor</span>
            <span className="editor-brand-sub">Report Engine v2</span>
          </div>
        </div>
        <div className="editor-topbar-actions">
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

      <main className="editor-wrap">
        <div className="editor-header">
          <div className="editor-eyebrow">
            {report.document_type} · {report.status}
          </div>
          <h1 className="editor-title">{report.title}</h1>
          <p className="editor-sub">
            Redigera moduler direkt och förhandsgranska som PDF. Ändringar sparas
            per modul när du klickar Spara.
          </p>
        </div>

        {error ? <div className="error">{error}</div> : null}

        {pdfUrl ? (
          <div className="pdf-link-row">
            <span>📄 Draft-PDF klar:</span>
            <a href={pdfUrl} target="_blank" rel="noopener noreferrer">
              Öppna i ny flik ↗
            </a>
          </div>
        ) : null}

        <section className="card">
          <div className="card-title">Lägg till modul</div>
          <div className="add-module">
            <div>
              <label htmlFor="new-module-type">Modultyp</label>
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
            </div>
            <button className="btn" type="button" disabled={adding} onClick={onAddModule}>
              {adding ? "Lägger till…" : "Lägg till"}
            </button>
          </div>
        </section>

        <section className="card">
          <div className="card-title">
            Moduler
            <span className="card-title-count">{modules.length} st</span>
          </div>
          {modules.length === 0 ? (
            <p className="hint">Inga moduler än. Lägg till en ovan för att börja.</p>
          ) : (
            <div>
              {modules.map((mod) => (
                <ModuleEditor
                  key={mod.id}
                  module={mod}
                  busy={!!busy[mod.id]}
                  onChange={onModuleChange}
                  onSave={onSaveModule}
                  onDelete={() => onDeleteModule(mod)}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
