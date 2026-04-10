import SlotEditor from "./SlotEditor";
import StyleOverridePanel from "./StyleOverridePanel";

const COLUMN_PRESETS = ["full", "half", "primary", "sidebar", "thirds", "wide-left", "quarter"];
const MAX_SLOTS = { full: 1, half: 2, primary: 2, sidebar: 2, thirds: 3, "wide-left": 2, quarter: 2 };

/**
 * ModuleEditor — switches on module.module_type and renders the right fields.
 * Emits updated module via onChange. Parent persists via api.updateV2Module.
 */
export default function ModuleEditor({ module, onChange, onDelete, onSave, busy }) {
  const content = module.content || {};
  const style = module.style || {};
  const updateContent = (patch) => onChange({ ...module, content: { ...content, ...patch } });
  const updateStyle = (nextStyle) => onChange({ ...module, style: nextStyle });

  return (
    <article className="card stack">
      <div className="row-between">
        <strong>{module.module_type}</strong>
        <div className="row-wrap">
          <button className="btn" type="button" disabled={busy} onClick={() => onSave(module)}>
            {busy ? "Sparar…" : "Spara modul"}
          </button>
          <button className="btn-ghost" type="button" onClick={onDelete}>
            Ta bort
          </button>
        </div>
      </div>

      {module.module_type === "cover" ? (
        <>
          <label>
            Titel
            <input value={content.title || ""} onChange={(e) => updateContent({ title: e.target.value })} />
          </label>
          <label>
            Undertitel
            <input
              value={content.subtitle || ""}
              onChange={(e) => updateContent({ subtitle: e.target.value })}
            />
          </label>
          <label>
            Datum
            <input value={content.date || ""} onChange={(e) => updateContent({ date: e.target.value })} />
          </label>
          <label>
            Logovariant
            <select
              value={content.logo_variant || "primary"}
              onChange={(e) => updateContent({ logo_variant: e.target.value })}
            >
              <option value="primary">Primär</option>
              <option value="inverted">Inverterad</option>
              <option value="mark">Märke</option>
            </select>
          </label>
        </>
      ) : null}

      {module.module_type === "chapter_break" ? (
        <>
          <label>
            Kapitelnummer
            <input
              type="number"
              value={content.chapter_number || ""}
              onChange={(e) => updateContent({ chapter_number: Number(e.target.value) || null })}
            />
          </label>
          <label>
            Kapiteltitel
            <input
              value={content.chapter_title || content.title || ""}
              onChange={(e) => updateContent({ chapter_title: e.target.value })}
            />
          </label>
        </>
      ) : null}

      {module.module_type === "back_cover" ? (
        <>
          <label>
            Tagline
            <input value={content.tagline || ""} onChange={(e) => updateContent({ tagline: e.target.value })} />
          </label>
          <label>
            Kontaktrader (en per rad)
            <textarea
              rows={4}
              value={(content.contact_lines || []).join("\n")}
              onChange={(e) =>
                updateContent({ contact_lines: e.target.value.split("\n").filter((l) => l.length > 0) })
              }
            />
          </label>
          <label>
            Disclaimer
            <textarea
              rows={3}
              value={content.disclaimer || ""}
              onChange={(e) => updateContent({ disclaimer: e.target.value })}
            />
          </label>
        </>
      ) : null}

      {module.module_type === "layout" ? (
        <LayoutEditor
          content={content}
          onContentChange={(next) => onChange({ ...module, content: next })}
          moduleId={module.id}
        />
      ) : null}

      <StyleOverridePanel style={style} onChange={updateStyle} moduleType={module.module_type} />
    </article>
  );
}

function LayoutEditor({ content, onContentChange, moduleId }) {
  const columns = content.columns || "full";
  const slots = content.slots || [];
  const max = MAX_SLOTS[columns] || 1;

  const setColumns = (next) => {
    const trimmed = slots.slice(0, MAX_SLOTS[next] || 1);
    onContentChange({ ...content, columns: next, slots: trimmed });
  };

  const updateSlot = (idx, nextSlot) => {
    const next = slots.map((s, i) => (i === idx ? nextSlot : s));
    onContentChange({ ...content, slots: next });
  };

  const addSlot = () => {
    if (slots.length >= max) return;
    onContentChange({
      ...content,
      slots: [...slots, { category: "text", content: {} }],
    });
  };

  const removeSlot = (idx) => {
    onContentChange({ ...content, slots: slots.filter((_, i) => i !== idx) });
  };

  return (
    <div className="stack">
      <label>
        Kolumnpreset
        <select value={columns} onChange={(e) => setColumns(e.target.value)}>
          {COLUMN_PRESETS.map((c) => (
            <option key={c} value={c}>
              {c} (max {MAX_SLOTS[c]} slots)
            </option>
          ))}
        </select>
      </label>

      {slots.map((slot, idx) => (
        <div key={idx} className="stack">
          <SlotEditor
            slot={slot}
            index={idx}
            moduleId={moduleId}
            onChange={(next) => updateSlot(idx, next)}
          />
          <button className="btn-ghost" type="button" onClick={() => removeSlot(idx)}>
            Ta bort slot {idx + 1}
          </button>
        </div>
      ))}

      {slots.length < max ? (
        <button className="btn-ghost" type="button" onClick={addSlot}>
          Lägg till slot ({slots.length}/{max})
        </button>
      ) : (
        <p className="hint">Max antal slots för "{columns}" uppnått.</p>
      )}
    </div>
  );
}
