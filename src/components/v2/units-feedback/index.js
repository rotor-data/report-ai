/**
 * Units-feedback stand-alone components.
 *
 * These deliberately live outside EditorV2.jsx / HtmlPreview.jsx to avoid
 * merge conflicts with the Fas 3+4 polish agent. When that work lands,
 * integrate them like this:
 *
 *   // In EditorV2.jsx, near the per-unit row in the side panel:
 *   import { HeavyEditIndicator } from "../v2/units-feedback";
 *   ...
 *   {unit.editDistance !== undefined && (
 *     <HeavyEditIndicator
 *       editDistance={unit.editDistance}
 *       textLength={(unit.text ?? "").length}
 *     />
 *   )}
 *
 *   // In the editor sidebar, somewhere near the units list footer:
 *   import { SuggestionsPanel } from "../v2/units-feedback";
 *   ...
 *   <SuggestionsPanel
 *     reportId={reportId}
 *     editorToken={editorToken}   // OR bearerToken={hubJwt}
 *     onApplied={() => reloadUnits()}
 *   />
 *
 * `unit.editDistance` is not currently populated by getV2EditorContext —
 * the integration owner adds it via either a new SELECT against
 * `unit_parse_feedback` (latest row per unit) or a JOIN in the editor's
 * units query. The HeavyEditIndicator is a pure presentational component
 * and gracefully renders nothing when editDistance is missing.
 */
export { default as HeavyEditIndicator } from "./HeavyEditIndicator.jsx";
export { default as SuggestionsPanel } from "./SuggestionsPanel.jsx";
