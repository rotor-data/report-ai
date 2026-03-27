import { useEffect, useMemo, useState } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const DEFAULT_COLUMN = (idx) => ({ id: `col_${idx}`, header: `Kolumn ${idx}`, type: "text", align: "left", width_pct: 25 });

const DEFAULT_ROW = (idx, columns) => ({
  id: `row_${idx}`,
  is_header: false,
  is_total: false,
  cells: Object.fromEntries(columns.map((c) => [c.id, ""])),
});

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatLimitWarning(columns, rows) {
  if (columns.length >= 20) return "Max 20 kolumner uppnått.";
  if (rows.length >= 200) return "Max 200 rader uppnått.";
  return "";
}

function SortableColumnHeader({ children, colId }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: colId });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <th ref={setNodeRef} style={style}>
      <div className="row-between">
        {children}
        <button className="btn-ghost drag-handle" type="button" aria-label="Dra kolumn" {...attributes} {...listeners}>
          Dra
        </button>
      </div>
    </th>
  );
}

export default function TableEditor({ module, onSave }) {
  const initial = useMemo(() => {
    if (module.data?.columns && module.data?.rows) return module.data;
    const cols = [DEFAULT_COLUMN(1), DEFAULT_COLUMN(2)];
    return {
      columns: cols,
      rows: [DEFAULT_ROW(1, cols)],
      caption: "",
      notes: "",
    };
  }, [module.data]);

  const [draft, setDraft] = useState(deepClone(initial));
  useEffect(() => setDraft(deepClone(initial)), [initial]);

  const sensors = useSensors(useSensor(PointerSensor));
  const limitWarning = formatLimitWarning(draft.columns || [], draft.rows || []);

  const updateColumn = (idx, patch) => {
    const columns = deepClone(draft.columns);
    columns[idx] = { ...columns[idx], ...patch };
    setDraft({ ...draft, columns });
  };

  const updateCell = (rowIndex, colId, value) => {
    const rows = deepClone(draft.rows);
    rows[rowIndex].cells[colId] = value;
    setDraft({ ...draft, rows });
  };

  const addRowBelow = (idx) => {
    if (draft.rows.length >= 200) return;
    const rows = deepClone(draft.rows);
    rows.splice(idx + 1, 0, DEFAULT_ROW(draft.rows.length + 1, draft.columns));
    setDraft({ ...draft, rows });
  };

  const addColumnRight = (idx) => {
    if (draft.columns.length >= 20) return;
    const columns = deepClone(draft.columns);
    const next = DEFAULT_COLUMN(draft.columns.length + 1);
    columns.splice(idx + 1, 0, next);

    const rows = deepClone(draft.rows).map((row) => ({ ...row, cells: { ...row.cells, [next.id]: "" } }));
    setDraft({ ...draft, columns, rows });
  };

  const removeColumn = (idx) => {
    if (draft.columns.length <= 1) return;
    const columns = deepClone(draft.columns);
    const [removed] = columns.splice(idx, 1);
    const rows = deepClone(draft.rows).map((row) => {
      const cells = { ...row.cells };
      delete cells[removed.id];
      return { ...row, cells };
    });
    setDraft({ ...draft, columns, rows });
  };

  const removeRow = (idx) => {
    const rows = deepClone(draft.rows);
    rows.splice(idx, 1);
    setDraft({ ...draft, rows });
  };

  const toggleTotal = (idx) => {
    const rows = deepClone(draft.rows);
    rows[idx].is_total = !rows[idx].is_total;
    const normal = rows.filter((r) => !r.is_total);
    const totals = rows.filter((r) => r.is_total);
    setDraft({ ...draft, rows: [...normal, ...totals] });
  };

  const onColumnDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const oldIndex = draft.columns.findIndex((c) => c.id === active.id);
    const newIndex = draft.columns.findIndex((c) => c.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const columns = arrayMove(draft.columns, oldIndex, newIndex);
    setDraft({ ...draft, columns });
  };

  return (
    <div className="table-editor stack">
      {limitWarning ? <p className="warn">{limitWarning}</p> : null}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onColumnDragEnd}>
        <table>
          <thead>
            <tr>
              <SortableContext items={draft.columns.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
                {draft.columns.map((col, idx) => (
                  <SortableColumnHeader key={col.id} colId={col.id}>
                    <div className="stack">
                      <input value={col.header} onChange={(e) => updateColumn(idx, { header: e.target.value })} />
                      <div className="inline-controls">
                        <select value={col.type || "text"} onChange={(e) => updateColumn(idx, { type: e.target.value })}>
                          <option value="text">text</option>
                          <option value="number">number</option>
                          <option value="currency">currency</option>
                          <option value="percent">percent</option>
                        </select>
                        {col.type === "currency" ? (
                          <input
                            value={col.currency_code || "SEK"}
                            onChange={(e) => updateColumn(idx, { currency_code: e.target.value })}
                            placeholder="SEK"
                          />
                        ) : null}
                        <button className="btn-ghost" type="button" onClick={() => addColumnRight(idx)}>
                          + höger
                        </button>
                        <button className="btn-ghost" type="button" onClick={() => removeColumn(idx)}>
                          ta bort
                        </button>
                      </div>
                    </div>
                  </SortableColumnHeader>
                ))}
              </SortableContext>
              <th>Radverktyg</th>
            </tr>
          </thead>
          <tbody>
            {draft.rows.map((row, rowIndex) => (
              <tr key={row.id} className={row.is_total ? "is-total" : ""}>
                {draft.columns.map((col) => (
                  <td key={col.id}>
                    <input
                      type="text"
                      inputMode={col.type === "number" || col.type === "currency" || col.type === "percent" ? "decimal" : "text"}
                      value={row.cells?.[col.id] ?? ""}
                      onChange={(e) => updateCell(rowIndex, col.id, e.target.value)}
                    />
                  </td>
                ))}
                <td>
                  <div className="inline-controls">
                    <button className="btn-ghost" type="button" onClick={() => addRowBelow(rowIndex)}>
                      + rad
                    </button>
                    <button className="btn-ghost" type="button" onClick={() => removeRow(rowIndex)}>
                      ta bort
                    </button>
                    <button className="btn-ghost" type="button" onClick={() => toggleTotal(rowIndex)}>
                      total
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DndContext>

      <label>
        Caption
        <input value={draft.caption || ""} onChange={(e) => setDraft({ ...draft, caption: e.target.value })} />
      </label>
      <label>
        Notes
        <input value={draft.notes || ""} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
      </label>

      <button className="btn" type="button" onClick={() => onSave(draft)}>
        Spara tabell
      </button>
    </div>
  );
}
