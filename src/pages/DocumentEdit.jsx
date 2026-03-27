import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { useDocumentStore } from "../stores/documentStore";
import ModuleList from "../components/ModuleList";
import HtmlPreview from "../components/HtmlPreview";
import PipelineStepper from "../components/PipelineStepper";
import RequiredSectionBanner from "../components/RequiredSectionBanner";
import ExportButton from "../components/ExportButton";

export default function DocumentEdit() {
  const { id } = useParams();
  const { document, validationWarnings, setDocument, setValidationWarnings } = useDocumentStore();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [brandInputText, setBrandInputText] = useState("{}");
  const [rawContent, setRawContent] = useState("");

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

  useEffect(() => {
    if (!document) return;
    setBrandInputText(JSON.stringify(document.brand_input || {}, null, 2));
    setRawContent(document.raw_content || "");
  }, [document]);

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

      <PipelineStepper
        onGenerateSystem={async () => {
          if (!parsedBrandInput) {
            setError("Brand input måste vara giltig JSON innan steg 1.");
            return;
          }
          await api.generateSystem({ document_id: id, brand_input: parsedBrandInput });
          await refresh();
        }}
        onGenerateModules={async () => {
          await api.generateModules({ document_id: id, raw_content: rawContent || "" });
          await refresh();
        }}
        onGenerateHtml={async () => {
          await api.generateHtml({ document_id: id });
          await refresh();
        }}
      />

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
