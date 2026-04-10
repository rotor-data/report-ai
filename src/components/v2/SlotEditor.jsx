import { Link } from "react-router-dom";

/**
 * Slot editor — renders fields based on slot.category (text | data | media).
 * Content-driven: no variant field. Each category has its own shape.
 */
export default function SlotEditor({ slot, index, onChange, moduleId }) {
  const update = (patch) => onChange({ ...slot, ...patch });
  const updateContent = (patch) => update({ content: { ...(slot.content || {}), ...patch } });

  const content = slot.content || {};

  return (
    <div className="panel stack" style={{ padding: "12px" }}>
      <div className="row-between">
        <strong>Slot {index + 1}</strong>
        <select
          value={slot.category || "text"}
          onChange={(e) => update({ category: e.target.value, content: {} })}
        >
          <option value="text">Text</option>
          <option value="data">Data</option>
          <option value="media">Media</option>
        </select>
      </div>

      {slot.category === "text" || !slot.category ? (
        <>
          <label>
            Rubrik
            <input
              value={content.heading || ""}
              onChange={(e) => updateContent({ heading: e.target.value })}
            />
          </label>
          <label>
            Ingress
            <textarea
              rows={2}
              value={content.intro || ""}
              onChange={(e) => updateContent({ intro: e.target.value })}
            />
          </label>
          <label>
            Brödtext
            <textarea
              rows={5}
              value={content.body || ""}
              onChange={(e) => updateContent({ body: e.target.value })}
            />
          </label>
          <label>
            Attribution
            <input
              value={content.attribution || ""}
              onChange={(e) => updateContent({ attribution: e.target.value })}
            />
          </label>
        </>
      ) : null}

      {slot.category === "data" ? (
        <>
          <label>
            Diagramtyp
            <select
              value={content.chart_type || "kpi"}
              onChange={(e) => updateContent({ chart_type: e.target.value })}
            >
              <option value="kpi">KPI-kort</option>
              <option value="bar">Stapeldiagram</option>
              <option value="line">Linjediagram</option>
              <option value="pie">Cirkeldiagram</option>
            </select>
          </label>
          <KpiListEditor
            kpis={content.kpis || []}
            onChange={(kpis) => updateContent({ kpis })}
          />
        </>
      ) : null}

      {slot.category === "media" ? (
        <>
          <label>
            Asset ID
            <input
              value={content.asset_id || ""}
              onChange={(e) => updateContent({ asset_id: e.target.value })}
              placeholder="UUID från asset-biblioteket"
            />
          </label>
          <label>
            Bildtext
            <input
              value={content.caption || ""}
              onChange={(e) => updateContent({ caption: e.target.value })}
            />
          </label>
          {moduleId ? (
            <Link className="btn-ghost" to={`/v2/assets?select=1&module_id=${moduleId}&slot_index=${index}`}>
              Välj från bibliotek
            </Link>
          ) : null}
          {!content.asset_id ? <p className="hint">Ingen bild vald — platshållare visas.</p> : null}
        </>
      ) : null}
    </div>
  );
}

function KpiListEditor({ kpis, onChange }) {
  const update = (idx, patch) => {
    const next = kpis.map((k, i) => (i === idx ? { ...k, ...patch } : k));
    onChange(next);
  };
  const add = () => onChange([...kpis, { label: "", value: "", delta: "" }]);
  const remove = (idx) => onChange(kpis.filter((_, i) => i !== idx));

  return (
    <div className="stack">
      <strong>KPI:er</strong>
      {kpis.map((kpi, idx) => (
        <div key={idx} className="row-wrap">
          <input
            placeholder="Etikett"
            value={kpi.label || ""}
            onChange={(e) => update(idx, { label: e.target.value })}
          />
          <input
            placeholder="Värde"
            value={kpi.value || ""}
            onChange={(e) => update(idx, { value: e.target.value })}
          />
          <input
            placeholder="Förändring"
            value={kpi.delta || ""}
            onChange={(e) => update(idx, { delta: e.target.value })}
          />
          <button className="btn-ghost" type="button" onClick={() => remove(idx)}>
            Ta bort
          </button>
        </div>
      ))}
      <button className="btn-ghost" type="button" onClick={add}>
        Lägg till KPI
      </button>
    </div>
  );
}
