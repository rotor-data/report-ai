import React, { useEffect, useState, useCallback } from "react";

/**
 * Side-panel widget that lists heuristic type-correction suggestions for
 * the current report's content units. Fetches from
 * `GET /api/v2/units/suggestions?report_id=...` and applies via
 * `POST /api/v2/units/apply-suggestions`.
 *
 * Stand-alone: NOT imported by EditorV2.jsx. Integration owner (Fas 3+4 or
 * later) imports from `./units-feedback/index.js` — see that file for the
 * exact props the editor should pass.
 *
 * Props:
 *   reportId:    string                — UUID of the report
 *   editorToken: string  (optional)    — capability token for X-Editor-Token
 *   bearerToken: string  (optional)    — Hub JWT for Authorization (alt to editorToken)
 *   onApplied?:  (count: number) => void  — called after a successful bulk apply
 */
export default function SuggestionsPanel({
  reportId,
  editorToken,
  bearerToken,
  onApplied,
}) {
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(false);

  const headers = useCallback(() => {
    const h = { "content-type": "application/json" };
    if (editorToken) h["X-Editor-Token"] = editorToken;
    if (bearerToken) h["Authorization"] = `Bearer ${bearerToken}`;
    return h;
  }, [editorToken, bearerToken]);

  const refresh = useCallback(async () => {
    if (!reportId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v2/units/suggestions?report_id=${encodeURIComponent(reportId)}`,
        { headers: headers() },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [reportId, headers]);

  useEffect(() => { refresh(); }, [refresh]);

  const applyAll = useCallback(async () => {
    if (!suggestions.length) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch("/api/v2/units/apply-suggestions", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          report_id: reportId,
          unit_ids: suggestions.map((s) => s.unit_id),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (typeof onApplied === "function") onApplied(data.applied ?? 0);
      await refresh();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setApplying(false);
    }
  }, [suggestions, reportId, headers, onApplied, refresh]);

  const applyOne = useCallback(async (unitId) => {
    setApplying(true);
    setError(null);
    try {
      const res = await fetch("/api/v2/units/apply-suggestions", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ report_id: reportId, unit_ids: [unitId] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (typeof onApplied === "function") onApplied(data.applied ?? 0);
      await refresh();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setApplying(false);
    }
  }, [reportId, headers, onApplied, refresh]);

  return (
    <div className="suggestions-panel" style={{ padding: 12, fontSize: 13 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <strong>Type suggestions</strong>
        <button onClick={refresh} disabled={loading} style={{ fontSize: 11 }}>
          {loading ? "…" : "Refresh"}
        </button>
      </header>
      {error && <div style={{ color: "#a40000", marginBottom: 8 }}>{error}</div>}
      {!loading && suggestions.length === 0 && (
        <div style={{ color: "#666" }}>No suggestions — everything looks correctly classified.</div>
      )}
      {suggestions.length > 0 && (
        <>
          <button
            onClick={applyAll}
            disabled={applying}
            style={{ marginBottom: 8, fontSize: 12 }}
          >
            Apply all ({suggestions.length})
          </button>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {suggestions.map((s) => (
              <li key={s.unit_id} style={{ padding: "6px 0", borderBottom: "1px solid #eee" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <code style={{ fontSize: 11 }}>{s.unit_id}</code>
                  <span style={{ fontSize: 11, color: "#666" }}>
                    {Math.round(s.confidence * 100)}%
                  </span>
                </div>
                <div style={{ marginTop: 2 }}>
                  <span style={{ color: "#888" }}>{s.current_type}</span>
                  {" → "}
                  <strong>{s.suggested_type}</strong>
                  {s.level !== undefined && <span style={{ color: "#888" }}> (level {s.level})</span>}
                </div>
                <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>{s.reasoning}</div>
                <button
                  onClick={() => applyOne(s.unit_id)}
                  disabled={applying}
                  style={{ marginTop: 4, fontSize: 11 }}
                >
                  Apply
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
