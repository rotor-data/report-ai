import SlotEditor from "./SlotEditor";

const COLUMN_PRESETS = ["full", "half", "primary", "sidebar", "thirds", "wide-left", "quarter"];
const MAX_SLOTS = { full: 1, half: 2, primary: 2, sidebar: 2, thirds: 3, "wide-left": 2, quarter: 2 };

/**
 * LayoutEditor — structured editor for `module_type === 'layout'`.
 * Moved out of the old ModuleEditor so ModuleInspector can reuse it.
 */
export default function LayoutEditor({ content, onContentChange, moduleId }) {
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
