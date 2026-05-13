import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";

/**
 * Transparent redirect for the deprecated `/v2/reports/:id` route.
 *
 * The legacy V2ReportEditor SPA page was removed — all editing now goes
 * through the standalone, token-authenticated `/editor/v2?token=…`
 * surface. To avoid 404s on old bookmarks and dashboard links that
 * cached the old path, this component mints a fresh editor capability
 * token via `/api/v2-editor-url` and replaces the current URL with
 * the modern editor URL.
 */
export default function V2ReportEditorRedirect() {
  const { id } = useParams();
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getEditorUrl(id);
        if (cancelled) return;
        if (res?.editor_url) {
          window.location.replace(res.editor_url);
        } else {
          setError("Inget editor-URL i svaret.");
        }
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <section className="stack-lg">
        <h2>Kunde inte öppna editor</h2>
        <p className="error">{error}</p>
        <p className="hint">
          Den gamla editor-vyn (<code>/v2/reports/:id</code>) har ersatts av den
          token-autentiserade editorn på <code>/editor/v2</code>. Försök igen
          eller gå tillbaka till rapportlistan.
        </p>
      </section>
    );
  }

  return <p>Öppnar editor…</p>;
}
