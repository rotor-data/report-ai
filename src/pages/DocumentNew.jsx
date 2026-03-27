import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";

export default function DocumentNew() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [documentType, setDocumentType] = useState("annual_report");
  const [error, setError] = useState("");

  const onSubmit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const res = await api.createDocument({ title, document_type: documentType });
      navigate(`/documents/${res.item.id}`);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section className="panel">
      <h2>Nytt dokument</h2>
      <form onSubmit={onSubmit} className="stack">
        <label>
          Titel
          <input value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label>
          Dokumenttyp
          <select value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
            <option value="annual_report">Årsredovisning</option>
            <option value="quarterly">Kvartalsrapport</option>
            <option value="pitch">Pitchdeck</option>
            <option value="proposal">Offert</option>
          </select>
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button className="btn" type="submit">
          Skapa dokument
        </button>
      </form>
    </section>
  );
}
