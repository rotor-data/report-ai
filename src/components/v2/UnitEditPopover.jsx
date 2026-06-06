/**
 * UnitEditPopover — inline editor for a single content unit, opened by
 * clicking a `[data-unit]` element on the canvas (Fas 4 of the panel
 * rebuild).
 *
 * Anchored to a viewport rect handed in via `anchorRect`. The popover
 * positions itself just below the rect (or above, if there isn't room),
 * keeps itself within the viewport on resize/scroll, and traps focus on
 * its primary textarea on open.
 *
 * Editing model
 * ─────────────
 *   - Text edits stream through `onPatchUnit(id, { text })` with a 500 ms
 *     debounce so typing → preview lag stays under 1 s without hammering
 *     the PATCH endpoint.
 *   - Live preview is the parent's job: as soon as `onPatchUnit` fires
 *     optimistic state, HtmlPreview re-runs substituteUnits and the
 *     canvas updates within ~200 ms.
 *   - Cancel restores the original text the popover opened with.
 *   - Save fires `onPatchUnit` synchronously (skipping the debounce) and
 *     calls `onClose`.
 *
 * Type / level changes route through the same `onPatchUnit` channel.
 * Complex types (table, kpi_group, comparison) surface a "Öppna i full
 * editor" link that calls `onOpenFullEditor` so the parent can scroll
 * the units side panel into focus on that row.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import UnitTypeIcon, { getUnitTypeMeta } from "./UnitTypeIcon.jsx";

const TEXT_ONLY_TYPES = new Set([
  "paragraph", "lead", "kicker", "attribution", "eyebrow",
  "blockquote", "pull_quote", "callout",
  "info_box", "warning_box", "success_box", "highlight",
  "caption", "footnote", "sidenote", "citation", "toc_entry",
]);
const HEADING_TYPES = new Set(["heading"]);
const COMPLEX_TYPES = new Set([
  "kpi", "kpi_group", "stat_hero", "table", "comparison",
  "timeline_event", "step", "testimonial", "glossary_item",
  "bibliography_entry",
]);

const TYPE_SUGGESTIONS = [
  "paragraph", "lead", "kicker", "attribution", "heading", "eyebrow",
  "blockquote", "pull_quote", "callout", "info_box", "warning_box",
  "success_box", "highlight", "caption", "footnote", "sidenote",
  "citation", "bullet_list", "numbered_list", "check_list",
  "definition_list", "kpi", "kpi_group", "stat_hero", "table",
  "comparison", "testimonial",
];

const POPOVER_WIDTH = 360;
const POPOVER_MIN_HEIGHT = 200;
const GAP = 8;

/**
 * Insert a markdown snippet at the textarea's current selection.
 * Returns the new value + new cursor position.
 */
function applyMarkdownSnippet(textarea, before, after = before, placeholder = "") {
  const { selectionStart, selectionEnd, value } = textarea;
  const sel = value.slice(selectionStart, selectionEnd);
  const inner = sel || placeholder;
  const next = value.slice(0, selectionStart) + before + inner + after + value.slice(selectionEnd);
  const cursorStart = selectionStart + before.length;
  const cursorEnd = cursorStart + inner.length;
  return { next, cursorStart, cursorEnd };
}

function clampPosition(anchorRect) {
  if (!anchorRect) {
    return { left: 24, top: 24, placement: "fixed" };
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Try below anchor first.
  let top = anchorRect.bottom + GAP;
  if (top + POPOVER_MIN_HEIGHT > vh) {
    top = Math.max(GAP, anchorRect.top - POPOVER_MIN_HEIGHT - GAP);
  }
  let left = anchorRect.left;
  if (left + POPOVER_WIDTH > vw - GAP) left = vw - POPOVER_WIDTH - GAP;
  if (left < GAP) left = GAP;
  return { left, top, placement: "anchored" };
}

export default function UnitEditPopover({
  unit,
  anchorRect,
  onPatchUnit,
  onClose,
  onOpenFullEditor,
}) {
  const original = useMemo(() => ({
    text: unit?.text || "",
    level: unit?.level || 1,
    type: unit?.type || "paragraph",
    metadata: unit?.metadata || {},
  }), [unit]);

  const [text, setText] = useState(original.text);
  const [level, setLevel] = useState(original.level);
  const [type, setType] = useState(original.type);
  const [metaJson, setMetaJson] = useState(() => JSON.stringify(original.metadata, null, 2));
  const [metaError, setMetaError] = useState("");
  const [pos, setPos] = useState(() => clampPosition(anchorRect));

  const textareaRef = useRef(null);
  const debounceTimer = useRef(null);

  // Reposition on viewport changes.
  useEffect(() => {
    const reposition = () => setPos(clampPosition(anchorRect));
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [anchorRect]);

  useEffect(() => setPos(clampPosition(anchorRect)), [anchorRect]);

  // Focus the main editable on open.
  useEffect(() => {
    const t = setTimeout(() => textareaRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  // Close on Escape (also restores original).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flushDebounce = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
  }, []);

  const scheduleTextSave = useCallback((nextText) => {
    if (!unit) return;
    flushDebounce();
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      if (nextText !== original.text) onPatchUnit?.(unit.id, { text: nextText });
    }, 500);
  }, [flushDebounce, onPatchUnit, original.text, unit]);

  const onTextChange = (next) => {
    setText(next);
    scheduleTextSave(next);
  };

  const insertMarkdown = (before, after, placeholder) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const { next, cursorStart, cursorEnd } = applyMarkdownSnippet(ta, before, after, placeholder);
    setText(next);
    // Defer focus restoration until after the controlled update lands.
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(cursorStart, cursorEnd);
    });
    scheduleTextSave(next);
  };

  const save = () => {
    if (!unit) return;
    flushDebounce();
    const patch = {};
    if (text !== original.text) patch.text = text;
    if (level !== original.level && type === "heading") patch.level = level;
    if (type !== original.type) patch.type = type;
    if (COMPLEX_TYPES.has(type) || type === "definition_list" || type === "bullet_list" || type === "numbered_list" || type === "check_list") {
      // Metadata JSON edits, validated client-side first.
      try {
        const parsed = JSON.parse(metaJson);
        const before = JSON.stringify(original.metadata || {});
        const after = JSON.stringify(parsed);
        if (before !== after) patch.metadata = parsed;
      } catch {
        // Block save when JSON is broken.
        setMetaError("Ogiltig JSON — kan inte spara.");
        return;
      }
    }
    if (Object.keys(patch).length > 0) onPatchUnit?.(unit.id, patch);
    onClose?.();
  };

  const cancel = () => {
    flushDebounce();
    // Revert any debounced patches by sending the original text back if
    // the local text drifted from it AND we didn't already commit a save.
    // The parent's optimistic state will roll back once the PATCH finishes.
    if (text !== original.text && unit) onPatchUnit?.(unit.id, { text: original.text });
    onClose?.();
  };

  if (!unit) return null;
  const meta = getUnitTypeMeta(type);
  const isHeading = HEADING_TYPES.has(type);
  const isComplex = COMPLEX_TYPES.has(type);
  const isList = type === "bullet_list" || type === "numbered_list" || type === "check_list" || type === "definition_list";
  const showText = TEXT_ONLY_TYPES.has(type) || isHeading;

  return (
    <>
      {/* Click-catcher backdrop so clicks outside the popover close it
          without stealing keystrokes inside. */}
      <div className="unit-popover-backdrop" onClick={cancel} />
      <div
        className="unit-popover"
        role="dialog"
        aria-label="Redigera unit"
        style={{
          left: pos.left,
          top: pos.top,
          width: POPOVER_WIDTH,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="unit-popover-head">
          <UnitTypeIcon type={type} level={isHeading ? level : null} />
          <code className="unit-popover-id" title={unit.unit_id}>{unit.unit_id}</code>
          <button
            type="button"
            className="unit-popover-close"
            onClick={cancel}
            aria-label="Stäng"
          >×</button>
        </header>

        <div className="unit-popover-body">
          <div className="unit-popover-row">
            <label className="unit-field-label" htmlFor="unit-popover-type">Typ</label>
            <select
              id="unit-popover-type"
              className="unit-select"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              {TYPE_SUGGESTIONS.map((t) => (
                <option key={t} value={t}>{getUnitTypeMeta(t).label}</option>
              ))}
              {/* If the current type isn't in suggestions, surface it so
                  it doesn't get silently coerced. */}
              {!TYPE_SUGGESTIONS.includes(type) ? (
                <option value={type}>{type}</option>
              ) : null}
            </select>
            {isHeading ? (
              <>
                <label className="unit-field-label" htmlFor="unit-popover-level">Nivå</label>
                <select
                  id="unit-popover-level"
                  className="unit-select"
                  value={level}
                  onChange={(e) => setLevel(parseInt(e.target.value, 10) || 1)}
                >
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <option key={n} value={n}>H{n}</option>
                  ))}
                </select>
              </>
            ) : null}
          </div>

          {showText ? (
            <>
              <div className="unit-popover-toolbar" role="toolbar" aria-label="Format">
                <button type="button" title="Fet (Cmd/Ctrl-B)" onClick={() => insertMarkdown("**", "**", "fet text")}>
                  <strong>B</strong>
                </button>
                <button type="button" title="Kursiv (Cmd/Ctrl-I)" onClick={() => insertMarkdown("*", "*", "kursiv")}>
                  <em>I</em>
                </button>
                <button type="button" title="Länk" onClick={() => insertMarkdown("[", "](https://)", "länktext")}>
                  🔗
                </button>
                <button type="button" title="Radbrytning" onClick={() => insertMarkdown("<br>", "", "")}>
                  ↵
                </button>
              </div>
              <textarea
                ref={textareaRef}
                className="unit-popover-textarea"
                rows={6}
                value={text}
                onChange={(e) => onTextChange(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
                    e.preventDefault(); insertMarkdown("**", "**", "fet text");
                  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
                    e.preventDefault(); insertMarkdown("*", "*", "kursiv");
                  } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault(); save();
                  }
                }}
              />
            </>
          ) : null}

          {(isComplex || isList) ? (
            <div className="unit-popover-complex">
              <label className="unit-field-label">
                Metadata (JSON)
              </label>
              <textarea
                className="unit-popover-textarea unit-popover-textarea--mono"
                rows={6}
                value={metaJson}
                onChange={(e) => {
                  setMetaJson(e.target.value);
                  try {
                    JSON.parse(e.target.value);
                    setMetaError("");
                  } catch (err) {
                    setMetaError(err.message);
                  }
                }}
              />
              {metaError ? <div className="unit-popover-error">{metaError}</div> : null}
              {isComplex ? (
                <button
                  type="button"
                  className="unit-popover-fulleditor"
                  onClick={() => onOpenFullEditor?.(unit)}
                >
                  Öppna i full editor →
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <footer className="unit-popover-foot">
          <button type="button" className="unit-popover-btn" onClick={cancel}>
            Avbryt
          </button>
          <button
            type="button"
            className="unit-popover-btn unit-popover-btn--primary"
            onClick={save}
          >
            Spara
          </button>
        </footer>
      </div>
    </>
  );
}
