import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";

/**
 * ImagePickerDialog — modal for choosing or uploading an image.
 *
 * Three source tabs:
 *   1. Upload — drag/drop a file or click to open file picker. Sent to
 *      /api/v2-assets which stores in Netlify Blobs and returns a
 *      data-asset-ref id + storage_url.
 *   2. Library — existing tenant_assets for this tenant, thumbnail grid.
 *   3. Unsplash — photo search via the Unsplash API. Each hit can be
 *      "imported" (downloaded + stored as a tenant_asset) so the same
 *      picker is used from now on.
 *
 * Props:
 *  - open: boolean
 *  - tenantId: string
 *  - onClose: () => void
 *  - onPick: ({ assetId, url, alt }) => void — fired when the user
 *    chooses an image. assetId is null for external URLs that
 *    weren't imported.
 *  - initialTab: "upload" | "library" | "unsplash"
 *  - initialAlt: string — prefill alt text for newly uploaded images
 */
export default function ImagePickerDialog({
  open,
  tenantId,
  onClose,
  onPick,
  initialTab = "library",
  initialAlt = "",
}) {
  const [tab, setTab] = useState(initialTab);
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [unsplash, setUnsplash] = useState([]);
  const [unsplashLoading, setUnsplashLoading] = useState(false);
  const [alt, setAlt] = useState(initialAlt);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  // Refresh library when dialog opens or tenant changes
  useEffect(() => {
    if (!open || !tenantId || tab !== "library") return;
    setLoading(true);
    setError("");
    api.listV2Assets(tenantId)
      // API returns { items }; old code looked for { assets } which
      // meant the library tab was always empty.
      .then((res) => setAssets(Array.isArray(res?.items) ? res.items : Array.isArray(res?.assets) ? res.assets : []))
      .catch((e) => setError(e?.message || "Kunde inte ladda bildbibliotek"))
      .finally(() => setLoading(false));
  }, [open, tenantId, tab]);

  // Reset alt when dialog opens
  useEffect(() => { if (open) setAlt(initialAlt); }, [open, initialAlt]);

  if (!open) return null;

  async function doUpload(file) {
    if (!file) return;
    if (!tenantId) { setError("Saknar tenant_id — kan inte ladda upp."); return; }
    setLoading(true);
    setError("");
    try {
      const dataBase64 = await readFileAsBase64(file);
      const res = await api.uploadV2Asset({
        tenant_id: tenantId,
        filename: file.name,
        mime_type: file.type || "image/jpeg",
        data_base64: dataBase64,
      });
      const asset = res?.asset || res;
      onPick({
        assetId: asset.id || null,
        url: asset.storage_url || asset.url,
        alt: alt || file.name.replace(/\.[^.]+$/, ""),
      });
      onClose();
    } catch (e) {
      setError(e?.message || "Uppladdning misslyckades");
    } finally {
      setLoading(false);
    }
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        // result is data:<mime>;base64,<payload>
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(new Error("Kunde inte läsa filen"));
      reader.readAsDataURL(file);
    });
  }

  async function searchUnsplash(query) {
    if (!query || query.trim().length < 2) return;
    setUnsplashLoading(true);
    setError("");
    try {
      // Route through api.request so the editor auth token is attached.
      // Without it the endpoint returns 401 before even calling Unsplash.
      const data = await api.unsplashSearch(query);
      if (data?.warning) setError(data.warning);
      setUnsplash(Array.isArray(data?.results) ? data.results : []);
    } catch (e) {
      setError(e?.message || "Unsplash-sökning misslyckades");
      setUnsplash([]);
    } finally {
      setUnsplashLoading(false);
    }
  }

  async function importUnsplash(hit) {
    // Download the photo and stash it as a tenant_asset so future
    // editors (and the PDF renderer) read it from our own storage.
    if (!tenantId) {
      // No tenant → just hand the direct URL back to the caller
      onPick({ assetId: null, url: hit.urls.regular, alt: alt || hit.alt_description || "" });
      onClose();
      return;
    }
    setLoading(true);
    setError("");
    try {
      const resp = await fetch(hit.urls.regular);
      const blob = await resp.blob();
      const dataBase64 = await blobToBase64(blob);
      const upload = await api.uploadV2Asset({
        tenant_id: tenantId,
        filename: `unsplash-${hit.id}.jpg`,
        mime_type: blob.type || "image/jpeg",
        data_base64: dataBase64,
      });
      const asset = upload?.asset || upload;
      onPick({
        assetId: asset.id || null,
        url: asset.storage_url || asset.url,
        alt: alt || hit.alt_description || "",
      });
      onClose();
    } catch (e) {
      setError(e?.message || "Kunde inte importera Unsplash-bild");
    } finally {
      setLoading(false);
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const r = reader.result;
        const comma = r.indexOf(",");
        resolve(comma >= 0 ? r.slice(comma + 1) : r);
      };
      reader.onerror = () => reject(new Error("Kunde inte läsa blob"));
      reader.readAsDataURL(blob);
    });
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff", borderRadius: 12, width: "min(800px, 92vw)",
          maxHeight: "86vh", display: "flex", flexDirection: "column",
          overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
        }}
      >
        <header style={{ padding: "14px 18px", borderBottom: "1px solid #eee", display: "flex", alignItems: "center", gap: 16 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Välj bild</h3>
          <div style={{ display: "flex", gap: 2, marginLeft: 12 }}>
            {[
              { id: "library", label: "Bibliotek" },
              { id: "upload", label: "Ladda upp" },
              { id: "unsplash", label: "Unsplash" },
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  padding: "6px 12px", border: "none", borderRadius: 6,
                  background: tab === t.id ? "#004549" : "transparent",
                  color: tab === t.id ? "#fff" : "#4a4a4a",
                  fontSize: 13, fontWeight: 500, cursor: "pointer",
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button
            onClick={onClose}
            style={{ marginLeft: "auto", border: "none", background: "transparent", fontSize: 20, cursor: "pointer", color: "#888" }}
          >×</button>
        </header>

        <div style={{ padding: "14px 18px", overflow: "auto", flex: 1 }}>
          {error && (
            <div style={{ padding: "8px 12px", background: "#fdecec", border: "1px solid #f5b1b1", borderRadius: 6, color: "#922", marginBottom: 12, fontSize: 13 }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, marginBottom: 14, alignItems: "center" }}>
            <label style={{ fontSize: 12, color: "#666", fontWeight: 500 }}>Alt-text:</label>
            <input
              value={alt}
              onChange={(e) => setAlt(e.target.value)}
              placeholder="Beskriv bilden för skärmläsare och SEO"
              style={{ flex: 1, padding: "6px 10px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13 }}
            />
          </div>

          {tab === "upload" && (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const file = e.dataTransfer.files?.[0];
                if (file) doUpload(file);
              }}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `2px dashed ${dragOver ? "#004549" : "#ccc"}`,
                borderRadius: 8, padding: "56px 24px", textAlign: "center",
                background: dragOver ? "#f0f7f6" : "#fafafa", cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              <div style={{ fontSize: 40, marginBottom: 10 }}>📤</div>
              <div style={{ fontSize: 15, fontWeight: 500, color: "#333" }}>
                {loading ? "Laddar upp…" : "Dra en bild hit eller klicka för att välja"}
              </div>
              <div style={{ fontSize: 12, color: "#888", marginTop: 6 }}>
                JPEG / PNG / WebP / SVG — max ~10 MB
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) doUpload(file);
                }}
              />
            </div>
          )}

          {tab === "library" && (
            <div>
              {loading && <div style={{ textAlign: "center", padding: 32, color: "#888" }}>Laddar bibliotek…</div>}
              {!loading && assets.length === 0 && (
                <div style={{ textAlign: "center", padding: 32, color: "#888" }}>
                  Inga bilder i biblioteket ännu. Ladda upp en i första fliken.
                </div>
              )}
              {!loading && assets.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10 }}>
                  {assets.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => {
                        onPick({ assetId: a.id, url: a.storage_url || a.url, alt: alt || a.filename });
                        onClose();
                      }}
                      style={{
                        border: "1px solid #e4e4e4", borderRadius: 8, background: "#fff",
                        padding: 0, overflow: "hidden", cursor: "pointer",
                        aspectRatio: "4/3", position: "relative",
                      }}
                      title={a.filename}
                    >
                      <img
                        src={a.storage_url || a.url}
                        alt={a.filename}
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "unsplash" && (
            <div>
              <form
                onSubmit={(e) => { e.preventDefault(); searchUnsplash(search); }}
                style={{ display: "flex", gap: 8, marginBottom: 14 }}
              >
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Sökord, t.ex. 'nordic landscape winter'"
                  style={{ flex: 1, padding: "8px 12px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13 }}
                />
                <button
                  type="submit"
                  disabled={unsplashLoading}
                  style={{
                    padding: "8px 16px", border: "none", borderRadius: 6,
                    background: "#004549", color: "#fff", fontSize: 13, fontWeight: 500,
                    cursor: unsplashLoading ? "default" : "pointer",
                    opacity: unsplashLoading ? 0.6 : 1,
                  }}
                >
                  {unsplashLoading ? "Söker…" : "Sök"}
                </button>
              </form>
              {unsplash.length === 0 && !unsplashLoading && (
                <div style={{ textAlign: "center", padding: 24, color: "#888", fontSize: 13 }}>
                  Sök efter bilder från Unsplash.<br />
                  Tips: sökord på engelska ger bäst resultat.
                </div>
              )}
              {unsplash.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
                  {unsplash.map((hit) => (
                    <button
                      key={hit.id}
                      onClick={() => importUnsplash(hit)}
                      style={{
                        border: "1px solid #e4e4e4", borderRadius: 8, background: "#fff",
                        padding: 0, overflow: "hidden", cursor: "pointer",
                        aspectRatio: "4/3", position: "relative",
                      }}
                      title={hit.alt_description || "Unsplash"}
                    >
                      <img
                        src={hit.urls?.thumb || hit.urls?.small || hit.urls?.regular}
                        alt={hit.alt_description || ""}
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                      />
                      <span style={{
                        position: "absolute", left: 4, bottom: 4, fontSize: 9,
                        background: "rgba(0,0,0,0.55)", color: "#fff",
                        padding: "1px 4px", borderRadius: 3,
                      }}>{hit.user?.name?.split(" ").map((s) => s[0]).join("").slice(0,2) || "?"}</span>
                    </button>
                  ))}
                </div>
              )}
              <div style={{ fontSize: 11, color: "#888", marginTop: 10 }}>
                Bilder importeras till ditt bibliotek när du klickar — sedan är
                de tillgängliga även i PDF:en. Kräver att UNSPLASH_ACCESS_KEY
                är konfigurerad på servern.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
