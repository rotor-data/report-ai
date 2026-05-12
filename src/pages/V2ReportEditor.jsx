import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../api/client";
import ModuleEditor from "../components/v2/ModuleEditor";

const MODULE_TYPES = ["cover", "chapter_break", "back_cover", "layout"];

/**
 * V2 Report editor — loads report, lists modules, lets user edit and save
 * them individually. Also offers draft PDF preview and a new-module creator.
 */
export default function V2ReportEditor() {
  const { id } = useParams();
  const [report, setReport] = useState(null);
  const [modules, setModules] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState({}); // { [module_id]: bool }
  const [newType, setNewType] = useState("layout");
  const [adding, setAdding] = useState(false);
  const [renderBusy, setRenderBusy] = useState(false);
  const [pdfUrl, setPdfUrl] = useState("");
  const [pptxBusy, setPptxBusy] = useState(false);
  const [pptxUrl, setPptxUrl] = useState("");

  const load = async () => {
    setError("");
    try {
      const res = await api.getV2Report(id);
      setReport(res.item);
      setModules(res.modules || []);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Consume asset selection stashed by V2AssetLibrary (select mode).
  // Format: { module_id, slot_index, asset_id, asset?: {...} }
  useEffect(() => {
    if (!modules.length) return;
    const raw = sessionStorage.getItem("v2_asset_selection");
    if (!raw) return;
    let sel;
    try {
      sel = JSON.parse(raw);
    } catch {
      sessionStorage.removeItem("v2_asset_selection");
      return;
    }
    sessionStorage.removeItem("v2_asset_selection");
    if (!sel?.module_id || sel.asset_id == null) return;

    const target = modules.find((m) => m.id === sel.module_id);
    if (!target) return;

    // Clone content and inject asset_id into the target slot.
    const nextContent = JSON.parse(JSON.stringify(target.content || {}));
    const slotIdx = Number.isFinite(sel.slot_index) ? sel.slot_index : 0;

    if (target.module_type === "layout") {
      if (!Array.isArray(nextContent.slots)) nextContent.slots = [];
      if (!nextContent.slots[slotIdx]) {
        nextContent.slots[slotIdx] = { category: "media", content: {} };
      }
      const slot = nextContent.slots[slotIdx];
      if (!slot.content) slot.content = {};
      slot.content.asset_id = sel.asset_id;
      if (sel.asset?.filename && !slot.content.caption) {
        slot.content.caption = sel.asset.filename;
      }
    } else {
      // For full-bleed modules (cover/back_cover), set a background asset.
      nextContent.background_asset_id = sel.asset_id;
    }

    // Persist and update local state.
    (async () => {
      setBusy((b) => ({ ...b, [target.id]: true }));
      try {
        const res = await api.updateV2Module(target.id, {
          content: nextContent,
          style: target.style,
        });
        setModules((prev) => prev.map((m) => (m.id === target.id ? res.item : m)));
      } catch (err) {
        setError(`Kunde inte koppla asset: ${err.message}`);
      } finally {
        setBusy((b) => ({ ...b, [target.id]: false }));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modules.length]);

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
        report_id: id,
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
      const res = await api.renderV2Pdf({ report_id: id, mode: "draft" });
      setPdfUrl(res.pdf_url);
    } catch (err) {
      setError(err.message);
    } finally {
      setRenderBusy(false);
    }
  };

  // 2026-05-13: editor-side .pptx export (mirrors EditorV2). Sync —
  // bounded by Netlify's 26s function cap. For 20+ page decks use the
  // workflow's export_pptx choice (BG-function, 15 min cap).
  const onExportPptx = async () => {
    setPptxBusy(true);
    setError("");
    setPptxUrl("");
    try {
      const res = await api.renderV2Pptx({ report_id: id });
      setPptxUrl(res.pptx_url);
      if (res.pptx_url) {
        const a = document.createElement("a");
        a.href = res.pptx_url;
        a.download = res.pptx_url.split("/").pop()?.split("?")[0] || "report.pptx";
        a.rel = "noopener noreferrer";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch (err) {
      setError(`PowerPoint-export misslyckades: ${err.message}`);
    } finally {
      setPptxBusy(false);
    }
  };

  if (!report) return <p>Laddar…</p>;

  return (
    <section className="stack-lg">
      <div className="row-between">
        <div>
          <h2>{report.title}</h2>
          <span className="hint">
            {report.document_type} · {report.status}
          </span>
        </div>
        <div className="row-wrap">
          <Link className="btn-ghost" to={`/v2/assets?report_id=${id}`}>
            Assets
          </Link>
          {pptxUrl ? (
            <a className="btn-ghost" href={pptxUrl} target="_blank" rel="noopener noreferrer">
              Öppna .pptx ↗
            </a>
          ) : null}
          <button
            className="btn-ghost"
            type="button"
            disabled={pptxBusy}
            onClick={onExportPptx}
            title="Exportera som editerbar PowerPoint (.pptx). Bakgrunder bevaras som bild, text och bilder är native-editerbara."
          >
            {pptxBusy ? "Exporterar…" : "Exportera .pptx"}
          </button>
          <button className="btn" type="button" disabled={renderBusy} onClick={onRenderDraft}>
            {renderBusy ? "Renderar…" : "Förhandsgranska PDF"}
          </button>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {pdfUrl ? (
        <p>
          <a href={pdfUrl} target="_blank" rel="noopener noreferrer">
            Öppna draft-PDF ↗
          </a>
        </p>
      ) : null}

      <div className="panel stack">
        <strong>Lägg till modul</strong>
        <div className="row-wrap">
          <select value={newType} onChange={(e) => setNewType(e.target.value)}>
            {MODULE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button className="btn" type="button" disabled={adding} onClick={onAddModule}>
            {adding ? "Lägger till…" : "Lägg till"}
          </button>
        </div>
      </div>

      <div className="stack">
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
        {modules.length === 0 ? <p className="hint">Inga moduler än. Lägg till en för att börja.</p> : null}
      </div>
    </section>
  );
}
