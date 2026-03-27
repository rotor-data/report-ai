import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";

export default function Dashboard() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .listDocuments()
      .then((res) => setItems(res.items || []))
      .catch((err) => setError(err.message));
  }, []);

  return (
    <section>
      <div className="row-between">
        <h2>Dokument</h2>
        <Link className="btn" to="/documents/new">
          Skapa
        </Link>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="card-list">
        {items.map((doc) => (
          <Link key={doc.id} className="card" to={`/documents/${doc.id}`}>
            <strong>{doc.title}</strong>
            <span>{doc.document_type}</span>
            <span>{doc.status}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
