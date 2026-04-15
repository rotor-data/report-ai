import { useEffect, useState } from "react";
import StyleOverridePanel from "./StyleOverridePanel";
import LayoutEditor from "./LayoutEditor";

/**
 * ModuleInspector — right-side panel with structured fields for a single
 * module (cover / chapter_break / back_cover / layout). Fires onSaveContent
 * with `{ content, style }` on Save click. The live preview is handled by
 * the editor canvas (HtmlPreview) — this panel only exposes fields that
 * are easier to edit as form inputs than by clicking in the preview.
 */
export default function ModuleInspector({ module, busy, onSaveContent, onDelete }) {
  // Local draft state so the user can edit without triggering a save on
  // every keystroke. Reset whenever the module id changes.
  const [content, setContent] = useState(module.content || {});
  const [style, setStyle] = useState(module.style || {});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setContent(module.content || {});
    setStyle(module.style || {});
    setDirty(false);
  }, [module.id]);

  const patchContent = (patch) => {
    setContent((c) => ({ ...c, ...patch }));
    setDirty(true);
  };
  const replaceContent = (next) => {
    setContent(next);
    setDirty(true);
  };
  const patchStyle = (next) => {
    setStyle(next);
    setDirty(true);
  };

  const handleSave = () => {
    onSaveContent({ content, style });
    setDirty(false);
  };

  return (
    <div className="inspector-pane">
      <div className="inspector-header">
        <div>
          <div className="inspector-eyebrow">Modul</div>
          <div className="inspector-title">{module.module_type}</div>
        </div>
        <button className="btn-danger" type="button" onClick={onDelete}>
          Ta bort
        </button>
      </div>

      <div className="inspector-body">
        {module.module_type === "cover" && (
          <>
            <label>
              Titel
              <input
                value={content.title || ""}
                onChange={(e) => patchContent({ title: e.target.value })}
              />
            </label>
            <label>
              Undertitel
              <input
                value={content.subtitle || ""}
                onChange={(e) => patchContent({ subtitle: e.target.value })}
              />
            </label>
            <label>
              Datum
              <input
                value={content.date || ""}
                onChange={(e) => patchContent({ date: e.target.value })}
              />
            </label>
            <label>
              Logovariant
              <select
                value={content.logo_variant || "primary"}
                onChange={(e) => patchContent({ logo_variant: e.target.value })}
              >
                <option value="primary">Primär</option>
                <option value="inverted">Inverterad</option>
                <option value="mark">Märke</option>
              </select>
            </label>
          </>
        )}

        {module.module_type === "chapter_break" && (
          <>
            <label>
              Kapitelnummer
              <input
                type="number"
                value={content.chapter_number ?? ""}
                onChange={(e) =>
                  patchContent({ chapter_number: e.target.value === "" ? null : Number(e.target.value) })
                }
              />
            </label>
            <label>
              Kapiteltitel
              <input
                value={content.chapter_title || content.title || ""}
                onChange={(e) => patchContent({ chapter_title: e.target.value })}
              />
            </label>
          </>
        )}

        {module.module_type === "back_cover" && (
          <>
            <label>
              Tagline
              <input
                value={content.tagline || ""}
                onChange={(e) => patchContent({ tagline: e.target.value })}
              />
            </label>
            <label>
              Kontaktrader (en per rad)
              <textarea
                rows={4}
                value={(content.contact_lines || []).join("\n")}
                onChange={(e) =>
                  patchContent({
                    contact_lines: e.target.value.split("\n").filter((l) => l.length > 0),
                  })
                }
              />
            </label>
            <label>
              Disclaimer
              <textarea
                rows={3}
                value={content.disclaimer || ""}
                onChange={(e) => patchContent({ disclaimer: e.target.value })}
              />
            </label>
          </>
        )}

        {module.module_type === "layout" && (
          <LayoutEditor
            content={content}
            onContentChange={replaceContent}
            moduleId={module.id}
          />
        )}

        {module.module_type === "freeform" && (
          <p className="hint">
            Denna modul är fribyggd med HTML. Redigera direkt i förhandsvisningen:
            dubbelklicka för text, klicka för att ta bort/duplicera element.
          </p>
        )}

        <StyleOverridePanel
          style={style}
          onChange={patchStyle}
          moduleType={module.module_type}
        />
      </div>

      <div className="inspector-footer">
        <button
          className="btn"
          type="button"
          disabled={busy || !dirty}
          onClick={handleSave}
        >
          {busy ? "Sparar…" : dirty ? "Spara ändringar" : "Inga ändringar"}
        </button>
      </div>
    </div>
  );
}
