import { useEffect, useState } from "react";
import { api } from "../api/client";

export default function FontManager() {
  const [fonts, setFonts] = useState([]);
  const [familyName, setFamilyName] = useState("");
  const [format, setFormat] = useState("woff2");
  const [blobKey, setBlobKey] = useState("");
  const [error, setError] = useState("");

  const load = () => api.listFonts().then((res) => setFonts(res.items || []));

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      await api.uploadFont({ family_name: familyName, format: format, blob_key: blobKey });
      setFamilyName("");
      setBlobKey("");
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section className="stack-lg">
      <h2>Typsnitt</h2>
      <form className="stack panel" onSubmit={submit}>
        <label>
          Family name
          <input value={familyName} onChange={(e) => setFamilyName(e.target.value)} required />
        </label>
        <label>
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="woff2">woff2</option>
            <option value="woff">woff</option>
            <option value="ttf">ttf</option>
          </select>
        </label>
        <label>
          Blob key
          <input value={blobKey} onChange={(e) => setBlobKey(e.target.value)} required />
        </label>
        <button className="btn" type="submit">
          Registrera font
        </button>
      </form>

      {error ? <p className="error">{error}</p> : null}

      <div className="card-list">
        {fonts.map((font) => (
          <article className="card" key={font.id}>
            <strong>{font.family_name}</strong>
            <span>{font.format}</span>
            <span>{font.weight}</span>
          </article>
        ))}
      </div>
    </section>
  );
}
