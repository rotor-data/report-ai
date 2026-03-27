import { useEffect, useMemo, useState, useRef } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { useDocumentStore } from "../stores/documentStore";
import ModuleList from "../components/ModuleList";
import HtmlPreview from "../components/HtmlPreview";
import StatusIndicator from "../components/StatusIndicator";
import RequiredSectionBanner from "../components/RequiredSectionBanner";
import ExportButton from "../components/ExportButton";

const POLL_INTERVAL_MS = 3000;

export default function DocumentEdit() {
  const { id } = useParams();
  const { document, validationWarnings, setDocument, setValidationWarnings } = useDocumentStore();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [brandInputText, setBrandInputText] = useState("{}");
  const [rawContent, setRawContent] = useState("");
  const pollRef = useRef(null);

  // Fetch document on mount
  useEffect(() => {
    if (!id) return;
    api
      .getDocument(id)
      .then((res) => {
        setDocument(res.item);
        setValidationWarnings(res.warnings || []);
      })
      .catch((err) => setError(err.message));
  }, [id, setDocument, setValidationWarnings]);

  // Sync local state when document changes
  useEffect(() => {
    if (!document) return;
    setBrandInputText(JSON.stringify(document.brand_input || {}, null, 2));
    setRawContent(document.raw_content || "");
  }, [document]);

  // Poll for updates when status is "generating"
  useEffect(() => {
    if (!id || document?.status !== "generating") {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }

    pollRef.current = setInterval(async () => {
      try {
        const res = await api.getDocument(id);
        setDocument(res.item);
        setValidationWarnings(res.warnings || []);
        // Stop polling when no longer generating
        if (res.item?.status !== "generating") {
          clearInterval(pollRef.current);
        }
      } catch {
        // Silent fail on poll
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(pollRef.current);
  }, [id, document?.status, setDocument, setValidationWarnings]);

  const parsedBrandInput = useMemo(() => {
    try {
      return JSON.parse(brandInputText || "{}");
    } catch {
      return null;
    }
  }, [brandInputText]);

  const refresh = async () => {
    if (!id) return;
    const res = await api.getDocument(id);
    setDocument(res.item);
    setValidationWarnings(res.warnings || []);
  };

  const onSaveMetadata = async () => {
    if (!id) return;
    if (!parsedBrandInput) {
      setError("Brand input måste vara giltig JSON.");
      return;
    }

    setError("");
    setBusy(true);
    try {
      const res = await api.patchDocument(id, {
        brand_input: parsedBrandInput,
        raw_content: rawContent,
      });
      setDocument(res.item);
      setValidationWarnings(res.warnings || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const onSavePlan = async (modulePlan) => {
    if (!id) return;
    const res = await api.patchDocument(id, { module_plan: modulePlan });
    setDocument(res.item);
    setValidationWarnings(res.warnings || []);
  };

  if (!document) return <p>Laddar...</p>;

  return (
    <section className="stack-lg">
      <div className="row-between">
        <h2>{document.title}</h2>
        <ExportButton documentId={document.id} />
      </div>

      {error ? <p className="error">{error}</p> : null}

      <StatusIndicator document={document} />

      <div className="panel stack">
        <label>
          Brand input (JSON)
          <textarea rows={8} value={brandInputText} onChange={(e) => setBrandInputText(e.target.value)} />
        </label>
        <label>
          Raw content
          <textarea rows={8} value={rawContent} onChange={(e) => setRawContent(e.target.value)} />
        </label>
        <button className="btn" type="button" disabled={busy} onClick={onSaveMetadata}>
          {busy ? "Sparar..." : "Spara metadata"}
        </button>
      </div>

      <RequiredSectionBanner
        warnings={validationWarnings}
        onAutoAdd={async () => {
          await api.patchDocument(id, {
            module_plan: document.module_plan || [],
            auto_add_missing_sections: true,
          });
          await refresh();
        }}
      />

      <div className="split">
        <ModuleList modules={document.module_plan || []} onSave={onSavePlan} />
        <HtmlPreview html={document.html_output || ""} />
      </div>
    </section>
  );
}
