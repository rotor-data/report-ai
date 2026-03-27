import TableEditor from "./TableEditor";

export default function ModuleCard({ module, onChange, onDelete, dragProps }) {
  return (
    <article className="card stack">
      <div className="row-between">
        <div className="row-wrap">
          <strong>{module.module_type}</strong>
          {dragProps ? (
            <button className="btn-ghost drag-handle" type="button" aria-label="Dra modul" {...dragProps}>
              Dra
            </button>
          ) : null}
        </div>
        <button className="btn-ghost" onClick={onDelete}>
          Ta bort
        </button>
      </div>

      <label>
        Rubrik
        <input value={module.title || ""} onChange={(e) => onChange({ ...module, title: e.target.value })} />
      </label>

      <label>
        Innehåll
        <textarea
          rows={4}
          value={module.content || ""}
          onChange={(e) => onChange({ ...module, content: e.target.value })}
        />
      </label>

      {module.module_type === "table" ? (
        <TableEditor
          module={module}
          onSave={(data) => {
            onChange({ ...module, data });
          }}
        />
      ) : null}
    </article>
  );
}
