import { useEffect, useState, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { api } from "../api/client";

/**
 * V2 Asset library — lists tenant assets, handles drag-drop + file picker
 * uploads, shows DPI warnings. In select mode (?select=1&module_id=...),
 * clicking an asset sets the asset_id on a target slot of the module.
 */
export default function V2AssetLibrary() {
  const [tenantId, setTenantId] = useState(() => localStorage.getItem("v2_tenant_id") || "");
  const [assets, setAssets] = useState([]);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const selectMode = params.get("select") === "1";
  const moduleId = params.get("module_id");
  const slotIndex = params.get("slot_index");

  const load = async () => {
    if (!tenantId) return;
    setError("");
    try {
      const res = await api.listV2Assets(tenantId);
      setAssets(res.items || []);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const uploadFile = async (file) => {
    if (!tenantId) {
      setError("Ange tenant_id först.");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const data_base64 = await fileToBase64(file);
      const res = await api.uploadV2Asset({
        tenant_id: tenantId,
        filename: file.name,
        mime_type: file.type || "application/octet-stream",
        data_base64,
      });
      setAssets((prev) => [res.item, ...prev]);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const onFileChange = async (e) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) {
      await uploadFile(f);
    }
    e.target.value = "";
  };

  const onDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    for (const f of files) {
      await uploadFile(f);
    }
  };

  const onSelectAsset = async (asset) => {
    if (!selectMode || !moduleId) return;
    try {
      // Fetch the module's current content via its report to know structure.
      // Simpler: rely on PATCH that updates just the slot. Since the module
      // editor doesn't give us direct module fetch, we read from parent route.
      // For MVP, we redirect back with asset info — the editor can handle the
      // actual write on return, OR we do a best-effort PATCH using slot_index.
      const slotIdx = slotIndex != null ? Number(slotIndex) : null;
      if (slotIdx == null || Number.isNaN(slotIdx)) {
        // Without slot index, just navigate back.
        navigate(-1);
        return;
      }
      // Minimal approach: load report via a separate endpoint is overkill.
      // Instead, we stash the selection in sessionStorage and go back — the
      // editor can pick it up on mount if desired. Pragmatic MVP.
      sessionStorage.setItem(
        "v2_asset_selection",
        JSON.stringify({ module_id: moduleId, slot_index: slotIdx, asset_id: asset.id })
      );
      navigate(-1);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section className="stack-lg">
      <div className="row-between">
        <h2>Asset-bibliotek {selectMode ? "(välj bild)" : ""}</h2>
        <button className="btn" type="button" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? "Laddar upp…" : "Ladda upp"}
        </button>
        <input ref={fileRef} type="file" multiple hidden onChange={onFileChange} />
      </div>

      {!tenantId ? (
        <div className="panel stack">
          <label>
            Tenant ID
            <input
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              onBlur={() => localStorage.setItem("v2_tenant_id", tenantId)}
            />
          </label>
        </div>
      ) : null}

      {error ? <p className="error">{error}</p> : null}

      <div
        className="panel"
        style={{
          border: dragOver ? "2px dashed #666" : "2px dashed #ccc",
          padding: "24px",
          textAlign: "center",
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        Dra och släpp filer här eller klicka på "Ladda upp".
      </div>

      <div className="card-list">
        {assets.map((a) => (
          <div
            key={a.id}
            className="card stack"
            onClick={selectMode ? () => onSelectAsset(a) : undefined}
            style={{ cursor: selectMode ? "pointer" : "default" }}
          >
            <div>
              {a.mime_type?.startsWith("image/") ? (
                <img
                  src={a.storage_url}
                  alt={a.filename}
                  style={{ maxWidth: "100%", maxHeight: "120px", objectFit: "contain" }}
                />
              ) : (
                <div className="hint">(ingen förhandsvisning)</div>
              )}
            </div>
            <strong>{a.filename}</strong>
            <span className="hint">
              {a.asset_class} · {formatBytes(a.size_bytes)}
              {a.width_px && a.height_px ? ` · ${a.width_px}×${a.height_px}px` : ""}
            </span>
            {a.dpi_warning ? <span className="error">{a.dpi_warning}</span> : null}
          </div>
        ))}
        {assets.length === 0 && tenantId ? <p className="hint">Inga assets ännu.</p> : null}
      </div>
    </section>
  );
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || "";
      const base64 = String(result).split(",")[1] || "";
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
