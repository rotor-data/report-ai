import { useUiStore } from "../stores/uiStore";

async function request(path, options = {}) {
  const token = useUiStore.getState().hubToken;
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, {
    ...options,
    headers,
  });

  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  // Document CRUD (REST endpoints — used by frontend directly)
  listDocuments: () => request("/documents"),
  getDocument: (id) => request(`/documents/${id}`),
  createDocument: (payload) => request("/documents", { method: "POST", body: JSON.stringify(payload) }),
  patchDocument: (id, payload) => request(`/documents/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteDocument: (id) => request(`/documents/${id}`, { method: "DELETE" }),

  // PDF export (REST endpoint)
  exportPdf: (payload) => request("/export-pdf", { method: "POST", body: JSON.stringify(payload) }),

  // Font management (REST endpoints)
  listFonts: () => request("/fonts"),
  uploadFont: (payload) => request("/fonts", { method: "POST", body: JSON.stringify(payload) }),

  // Chat-first support endpoints (fallback/admin UI)
  listDesignAssets: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/design-assets${query ? `?${query}` : ""}`);
  },
  uploadDesignAsset: (payload) => request("/design-assets", { method: "POST", body: JSON.stringify(payload) }),
  analyzeDesignAsset: (assetId) => request(`/design-assets/${assetId}/analyze`, { method: "POST", body: "{}" }),
  patchDesignAsset: (assetId, payload) => request(`/design-assets/${assetId}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteDesignAsset: (assetId) => request(`/design-assets/${assetId}`, { method: "DELETE" }),

  listBrandProfiles: () => request("/brand-profiles"),
  getBrandProfile: (id) => request(`/brand-profiles/${id}`),
  createBrandProfile: (payload) => request("/brand-profiles", { method: "POST", body: JSON.stringify(payload) }),
  patchBrandProfile: (id, payload) => request(`/brand-profiles/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  createBrandProfileVersion: (id, payload) =>
    request(`/brand-profiles/${id}/versions`, { method: "POST", body: JSON.stringify(payload) }),

  checkBrandReadiness: (payload) => request("/brand-readiness", { method: "POST", body: JSON.stringify(payload) }),
  runLayoutPreflight: (payload) => request("/layout-preflight", { method: "POST", body: JSON.stringify(payload) }),

  // ─── Report Engine v2 ────────────────────────────────────────────────────
  listV2Reports: (tenantId) => request(`/v2-reports?tenant_id=${encodeURIComponent(tenantId)}`),
  getV2Report: (id) => request(`/v2-reports/${id}`),
  createV2Report: (payload) => request("/v2-reports", { method: "POST", body: JSON.stringify(payload) }),
  patchV2Report: (id, payload) => request(`/v2-reports/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteV2Report: (id) => request(`/v2-reports/${id}`, { method: "DELETE" }),

  addV2Module: (payload) => request("/v2-modules", { method: "POST", body: JSON.stringify(payload) }),
  updateV2Module: (id, payload) => request(`/v2-modules/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteV2Module: (id) => request(`/v2-modules/${id}`, { method: "DELETE" }),

  listV2Assets: (tenantId) => request(`/v2-assets?tenant_id=${encodeURIComponent(tenantId)}`),
  uploadV2Asset: (payload) => request("/v2-assets", { method: "POST", body: JSON.stringify(payload) }),

  renderV2Pdf: (payload) => request("/v2-render", { method: "POST", body: JSON.stringify(payload) }),

  listV2Blueprints: (brandId) => request(`/v2-blueprints?brand_id=${encodeURIComponent(brandId)}`),
  saveV2Blueprint: (payload) => request("/v2-blueprints", { method: "POST", body: JSON.stringify(payload) }),
  createV2FromBlueprint: (payload) =>
    request("/v2-blueprints/create-from", { method: "POST", body: JSON.stringify(payload) }),

  // Note: AI generation (design system, module plan, HTML) is handled by
  // Claude via MCP tools — no frontend endpoints needed.
};
